"""
Review bundles for the NABH Guidebook pass: for every objective element, the
standard text, its guidebook interpretation, and the hospital passages closest
in meaning to that interpretation (local bge retrieval, same corpus as the
6th Edition gap run).

    python nabh6_gb_bundle.py <hosp6_gb.json> <company upload folder> <out dir>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nabh6_gap import Retriever, company_corpus                   # noqa: E402

PART = 8


def main() -> None:
    stds = json.loads(Path(sys.argv[1]).read_text())["standards"]
    docs = company_corpus(Path(sys.argv[2]))
    out = Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    ret = Retriever(docs)
    index = "\n".join(dict.fromkeys(f"{d['code']}: {d['title']}" for d in docs if d["kind"] in ("Policy", "SOP")))
    (out / "document_index.md").write_text("# Every policy and SOP the hospital has (code: title)\n\n" + index + "\n")
    by_ch: dict[str, list[dict]] = {}
    for s in stds:
        by_ch.setdefault(s["chapter"], []).append(s)
    files = []
    for ch, ss in by_ch.items():
        parts = [ss[i:i + PART] for i in range(0, len(ss), PART)]
        for pi, part in enumerate(parts, 1):
            name = ch if len(parts) == 1 else f"{ch}-{pi}"
            lines = [f"# NABH 6th Ed. Guidebook — {part[0]['chapter_name']} ({name})", ""]
            n_el = 0
            for s in part:
                lines += [f"## STANDARD {s['code'].rstrip('.')} — {s['statement']}", ""]
                for e in s["elements"]:
                    n_el += 1
                    code = e["code"].rstrip(".")
                    interp = e.get("interpretation") or "(no interpretation in the guidebook — use the element text)"
                    lines += [f"### {code} [{e['category']}{' *DOC' if e['documentation_required'] else ''}] {e['text']}",
                              f"Interpretation (guidebook p{e.get('gb_page') or '?'}): {interp}", "",
                              "Closest hospital passages:"]
                    q = f"{e['text']} {e.get('interpretation', '')[:900]}"
                    seen = set()
                    for d, sc in ret.top(q, 6):
                        key = (d["code"], d["text"][:80])
                        if key in seen or sc < 0.5:
                            continue
                        seen.add(key)
                        lines.append(f"- {d['code']} | {d['kind']} | {d['title']}: {d['text'][:350]}")
                    lines.append("")
            (out / f"{name}.md").write_text("\n".join(lines))
            files.append((name, n_el))
    for f in files:
        print(f"{f[0]:<7} elements {f[1]}")


if __name__ == "__main__":
    main()
