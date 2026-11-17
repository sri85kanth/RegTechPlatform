"""
Export every requirement of every regulation that applies to the hospital as
review bundles for a document-based gap assessment (same method as the NABH
6th Edition run: semantic retrieval of the hospital's own passages, judgement
by a reviewer).

    python reg_gap_bundle.py <company upload folder> <out dir> [--per 80] [--exclude nabh-hospital-6th-edition-2025]

Writes <out>/bundles/B###.md, <out>/bundle_map.json (alias -> requirement id,
regulation id) and <out>/manifest.json.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                       # noqa: E402
from nabh6_gap import Retriever, company_corpus                   # noqa: E402

COMPANY = 1


def clean(s: str | None, n: int) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def main() -> None:
    folder, out = Path(sys.argv[1]), Path(sys.argv[2])
    per = int(sys.argv[sys.argv.index("--per") + 1]) if "--per" in sys.argv else 80
    exclude = set(sys.argv[sys.argv.index("--exclude") + 1].split(",")) if "--exclude" in sys.argv else set()
    (out / "bundles").mkdir(parents=True, exist_ok=True)

    con = connect()
    regs = [dict(r) for r in con.execute(
        """SELECT r.id, r.title, coalesce(nullif(r.regulator_short,''), r.regulator, '') AS regulator,
                  r.regulation_type, r.jurisdiction
           FROM regulations r JOIN applicability_results ar
             ON ar.regulation_id=r.id AND ar.company_id=? AND ar.scope_type='COMPANY'
           WHERE ar.verdict IN ('APPLICABLE','CONDITIONAL') ORDER BY r.id""", (COMPANY,))
        if r["id"] not in exclude]
    reqs_by_reg: dict[str, list[dict]] = {}
    for r in con.execute(
            """SELECT q.id, q.regulation_id, q.statement, q.source_excerpt, q.source_clause, q.page_number,
                      o.obligation_type, o.title AS obl_title
               FROM requirements q LEFT JOIN obligations o ON o.id=q.obligation_id
               WHERE q.regulation_id = ANY(?) ORDER BY q.regulation_id, q.id""", ([g["id"] for g in regs],)):
        reqs_by_reg.setdefault(r["regulation_id"], []).append(dict(r))

    docs = company_corpus(folder)
    ret = Retriever(docs)
    all_reqs = [q for g in regs for q in reqs_by_reg.get(g["id"], [])]
    print(f"regulations {len(regs)} · requirements {len(all_reqs)} · company passages {len(docs)}", flush=True)

    # one batched encode for all requirement texts
    texts = ["Represent this sentence for searching relevant passages: " + clean(q["statement"], 400) for q in all_reqs]
    qv = ret.model.encode(texts, normalize_embeddings=True, batch_size=64, show_progress_bar=False)
    sims = qv @ ret.emb.T
    top = np.argsort(-sims, axis=1)[:, :3]
    hits = {q["id"]: [(int(i), float(sims[n, i])) for i in top[n]] for n, q in enumerate(all_reqs)}
    print("retrieval done", flush=True)

    bundles, cur, cur_n = [], [], 0
    for g in regs:
        qs = reqs_by_reg.get(g["id"], [])
        for i in range(0, len(qs), per):                 # big regulations split across bundles
            part = qs[i:i + per]
            if cur and cur_n + len(part) > per:
                bundles.append(cur)
                cur, cur_n = [], 0
            cur.append((g, part))
            cur_n += len(part)
    if cur:
        bundles.append(cur)

    amap: dict[str, dict] = {}
    manifest = []
    for bi, b in enumerate(bundles, 1):
        name = f"B{bi:03d}"
        lines = [f"# Review bundle {name}", ""]
        n = 0
        for g, part in b:
            lines += [f"## REGULATION: {g['title']}", f"Regulator: {g['regulator'] or 'unknown'} · Type: {g['regulation_type'] or '—'}", "",
                      "### Requirements"]
            chunk_ids: dict[int, float] = {}
            for q in part:
                n += 1
                alias = f"{name}.{n}"
                amap[alias] = {"requirement_id": q["id"], "regulation_id": g["id"]}
                exc = clean(q["source_excerpt"], 350)
                st = clean(q["statement"], 350)
                extra = f" | source: {exc}" if exc and exc[:60] != st[:60] else ""
                ref = f" [{q['source_clause']}]" if q["source_clause"] else ""
                lines.append(f"- {alias}{ref} ({q['obligation_type'] or '—'}) {st}{extra}")
                for i, s in hits[q["id"]]:
                    if s >= 0.55 and s > chunk_ids.get(i, 0):
                        chunk_ids[i] = s
            lines += ["", "### Closest passages in the hospital's documents (by meaning)"]
            grouped: dict[str, list[str]] = {}
            heads: dict[str, str] = {}
            for i, _ in sorted(chunk_ids.items(), key=lambda x: -x[1])[:60]:
                d = docs[i]
                heads[d["code"]] = f"{d['code']} | {d['kind']} | {d['title']}"
                grouped.setdefault(d["code"], []).append(clean(d["text"], 300))
            if not grouped:
                lines.append("- (no passage in the hospital's documents is close in meaning)")
            for c, ts in grouped.items():
                lines.append(f"- **{heads[c]}**")
                lines += [f"    - {t}" for t in dict.fromkeys(ts)]
            lines.append("")
        (out / "bundles" / f"{name}.md").write_text("\n".join(lines))
        manifest.append({"bundle": name, "requirements": n, "regulations": [g["id"] for g, _ in b]})
    (out / "bundle_map.json").write_text(json.dumps(amap))
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"bundles {len(bundles)} · requirements {len(amap)}")


if __name__ == "__main__":
    main()
