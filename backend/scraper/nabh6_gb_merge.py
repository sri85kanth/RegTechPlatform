"""
Fold the guidebook review (nabh-gb-claude/results/*.json) into the NABH 6th
Edition gap file, so each objective element carries its guidebook requirements
(`subs`) and a status rolled up from them.

    python nabh6_gb_merge.py <hosp6_gb.json> <bundle dir> <hosp6_gap.json>   (rewritten in place; .bak kept)

Roll-up, per element, from its guidebook requirements:
  all MET                         -> MET
  all NOT_COVERED                 -> NOT_COVERED
  only GAP / NOT_COVERED          -> GAP
  anything else (a mix)           -> PARTIAL
Risk follows the element's NABH category via nabh6_gap.risk_for, as before.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nabh6_gap import risk_for                                    # noqa: E402

VALID = {"MET", "PARTIAL", "GAP", "NOT_COVERED"}
CODE_RE = re.compile(r"^(?:HR|NUR|BME)-(?:POL|SOP|F|C|R)-\d+$")


def rollup(sts: list[str]) -> str:
    s = set(sts)
    if s == {"MET"}:
        return "MET"
    if s == {"NOT_COVERED"}:
        return "NOT_COVERED"
    if s <= {"GAP", "NOT_COVERED"}:
        return "GAP"
    return "PARTIAL"


def main() -> None:
    gb = json.loads(Path(sys.argv[1]).read_text())["standards"]
    bdir, gap_path = Path(sys.argv[2]), Path(sys.argv[3])
    answers: dict[str, list] = {}
    bad = []
    for f in sorted((bdir / "results").glob("*.json")):
        try:
            for k, v in json.loads(f.read_text(encoding="utf-8-sig")).items():
                answers[k.strip().rstrip(".")] = v if isinstance(v, list) else [v]
        except json.JSONDecodeError as ex:
            bad.append(f"{f.name}: {ex}")
    gap = json.loads(gap_path.read_text())
    shutil.copy(gap_path, gap_path.with_suffix(".before_guidebook.json"))
    interp = {e["code"].rstrip("."): e for s in gb for e in s["elements"]}

    n_req, missing, changed, dropped = 0, [], 0, 0
    tally: dict = {}
    for scode, s in gap.items():
        for e in s["elements"]:
            code = e["code"].rstrip(".")
            g = interp.get(code, {})
            e["interpretation"] = g.get("interpretation", "")
            e["gb_page"] = g.get("gb_page")
            subs_in = answers.get(code)
            if not subs_in:
                missing.append(code)
                continue
            subs = []
            for i, r in enumerate(subs_in, 1):
                st = str(r.get("st", "")).upper().replace(" ", "_")
                st = st if st in VALID else "GAP"
                by = []
                for c in r.get("by") or []:
                    c = str(c).strip()
                    (by.append(c) if CODE_RE.match(c) else None)
                    dropped += 0 if CODE_RE.match(c) else 1
                subs.append({"n": i, "rq": r.get("rq", ""), "ev": r.get("ev", ""), "src": r.get("src", ""),
                             "who": r.get("who", ""), "freq": r.get("freq", ""), "st": st,
                             "by": by, "gap": r.get("gap", "") if st != "MET" else "",
                             "fix": r.get("fix", "") if st != "MET" else "",
                             "risk": risk_for(e["category"], st)})
                tally[st] = tally.get(st, 0) + 1
            n_req += len(subs)
            e["subs"] = subs
            new = rollup([x["st"] for x in subs])
            changed += new != e["status"]
            e["status"] = new
            e["risk"] = risk_for(e["category"], new)
            e["satisfied_by"] = sorted({c for x in subs for c in x["by"]} | set(e.get("satisfied_by", [])))
            unmet = [x for x in subs if x["st"] != "MET"]
            e["gap"] = ("; ".join(dict.fromkeys(x["gap"] for x in unmet if x["gap"])))[:600] if unmet else ""
            e["action"] = ("; ".join(dict.fromkeys(x["fix"] for x in unmet if x["fix"])))[:600] if unmet else ""
    gap_path.write_text(json.dumps(gap, indent=1, ensure_ascii=False))
    els = [e for s in gap.values() for e in s["elements"]]
    st: dict = {}
    for e in els:
        st[e["status"]] = st.get(e["status"], 0) + 1
    print(f"guidebook requirements {n_req} · per status {tally}")
    print(f"elements {len(els)} · rolled-up status {st} · status changed on {changed} · no answer {len(missing)} {missing[:10]}")
    print(f"bad files {bad} · unknown codes dropped {dropped}")


if __name__ == "__main__":
    main()
