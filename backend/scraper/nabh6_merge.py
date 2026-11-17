"""
Merge reviewer results (one JSON per bundle, see nabh6_bundle.py) into the gap
cache format that nabh6_load.py and nabh6_report.py read.

    python nabh6_merge.py <hosp6.json> <bundle dir> <out hosp6_gap.json>

Checks every element is answered once with a valid status, drops cited document
codes that do not exist in the hospital's documents, and applies the risk rule
from nabh6_gap.risk_for (risk is never taken from the reviewer).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nabh6_gap import risk_for                                    # noqa: E402

VALID = {"MET", "PARTIAL", "GAP", "NOT_COVERED"}


def main() -> None:
    stds = json.loads(Path(sys.argv[1]).read_text())["standards"]
    bdir = Path(sys.argv[2])
    out = Path(sys.argv[3])
    answers: dict[str, dict] = {}
    for f in sorted((bdir / "results").glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as ex:
            print(f"!! {f.name}: invalid JSON ({ex})")
            continue
        for k, v in data.items():
            answers[k.strip().rstrip(".")] = v
    passages = json.loads((bdir / "passages.json").read_text())
    known = set(re.findall(r"^((?:HR|NUR|BME)-(?:POL|SOP)-\d+):", (bdir / "document_index.md").read_text(), re.M))
    known |= {p["code"] for ps in passages.values() for p in ps}
    known_pat = re.compile(r"^(?:HR|NUR|BME)-(?:POL|SOP|F|C|R)-\d+$")

    cache, missing, bad_status, dropped = {}, [], [], 0
    for s in stds:
        rows = []
        for e in s["elements"]:
            code = e["code"].rstrip(".")
            a = answers.get(code)
            if a is None:
                missing.append(code)
                continue
            st = str(a.get("st", "")).upper().replace(" ", "_")
            if st not in VALID:
                bad_status.append((code, st))
                st = "GAP"
            by = []
            for c in a.get("by") or []:
                c = str(c).strip()
                if c in known or known_pat.match(c):
                    by.append(c)
                else:
                    dropped += 1
            rows.append(dict(e, obligation=a.get("ob", ""), requirement=a.get("rq", ""),
                             responsible=a.get("who", ""), frequency=a.get("freq", ""), status=st,
                             satisfied_by=by, gap=a.get("gap", "") if st != "MET" else "",
                             action=a.get("fix", "") if st != "MET" else "",
                             consequence=a.get("why", ""), risk=risk_for(e["category"], st)))
        if rows and len(rows) == len(s["elements"]):
            cache[s["code"]] = {"standard": {k: s[k] for k in ("code", "chapter", "chapter_name", "statement")},
                                "passages": passages.get(s["code"], []), "elements": rows,
                                "assessed_by": "Claude review of semantically retrieved passages"}
    out.write_text(json.dumps(cache, indent=1, ensure_ascii=False))
    els = [r for v in cache.values() for r in v["elements"]]
    tally: dict = {}
    for r in els:
        tally[r["status"]] = tally.get(r["status"], 0) + 1
    risk: dict = {}
    for r in els:
        risk[r["risk"]] = risk.get(r["risk"], 0) + 1
    print(f"standards complete {len(cache)}/{len(stds)} · elements {len(els)}/{sum(len(s['elements']) for s in stds)}")
    print("status", tally)
    print("risk  ", risk)
    print(f"missing answers {len(missing)} {missing[:12]} · invalid status {bad_status[:5]} · dropped unknown codes {dropped}")


if __name__ == "__main__":
    main()
