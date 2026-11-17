"""
Export the NABH 6th Edition gap-assessment inputs as one review bundle per
chapter, so the judgement step can be done by any reviewer (Claude agents, a
human assessor) instead of the local LLM. Retrieval stays local and semantic.

    python nabh6_bundle.py <hosp6.json> <company upload folder> <out dir>

Writes <out dir>/<CH>.md (the bundle a reviewer reads) and <out dir>/passages.json
(which passages each standard was shown, for traceability). Large chapters are
split into parts of at most 10 standards: <CH>-1.md, <CH>-2.md.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nabh6_gap import Retriever, company_corpus                   # noqa: E402

PART = 10


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
    shown: dict[str, list] = {}
    files = []
    for ch, ss in by_ch.items():
        parts = [ss[i:i + PART] for i in range(0, len(ss), PART)]
        for pi, part in enumerate(parts, 1):
            name = ch if len(parts) == 1 else f"{ch}-{pi}"
            lines = [f"# NABH Hospitals 6th Edition — {part[0]['chapter_name']} ({name})", ""]
            for s in part:
                best: dict[int, tuple[dict, float]] = {}
                for e in s["elements"]:
                    for d, sc in ret.top(e["text"], 5):
                        if id(d) not in best or sc > best[id(d)][1]:
                            best[id(d)] = (d, sc)
                passages = sorted(best.values(), key=lambda x: -x[1])[:28]
                shown[s["code"]] = [{"code": d["code"], "kind": d["kind"], "title": d["title"],
                                     "similarity": round(sc, 3)} for d, sc in passages]
                lines += [f"## STANDARD {s['code'].rstrip('.')} — {s['statement']}", "", "### Objective elements"]
                for e in s["elements"]:
                    lines.append(f"- {e['code']} [{e['category']}{' *DOC' if e['documentation_required'] else ''}] {e['text']}")
                lines += ["", "### Most relevant passages from the hospital's documents (retrieved per element)"]
                grouped: dict[str, list[str]] = {}
                heads: dict[str, str] = {}
                for d, _ in passages:
                    heads[d["code"]] = f"{d['code']} | {d['kind']} | {d['title']}"
                    grouped.setdefault(d["code"], []).append(d["text"][:400].replace("\n", " "))
                for c, ts in grouped.items():
                    lines.append(f"- **{heads[c]}**")
                    lines += [f"    - {t}" for t in ts]
                lines.append("")
            (out / f"{name}.md").write_text("\n".join(lines))
            files.append((name, len(part), sum(len(s["elements"]) for s in part)))
    (out / "passages.json").write_text(json.dumps(shown, indent=1))
    for f in files:
        print(f"{f[0]:<7} standards {f[1]:>3}  elements {f[2]:>4}")


if __name__ == "__main__":
    main()
