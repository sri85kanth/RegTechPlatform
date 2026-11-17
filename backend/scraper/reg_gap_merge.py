"""
Merge reviewer results for the hospital's applicable regulations
(regs-claude/results/B###.json, aliases from bundle_map.json) into one file the
loader and the Impact Cascade page read.

    python reg_gap_merge.py <regs-claude dir> <out regs_gap.json>
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                       # noqa: E402

VALID = {"MET", "PARTIAL", "GAP", "NOT_COVERED", "NOT_APPLICABLE"}
RISKS = {"Critical", "High", "Medium", "Low"}
CODE_RE = re.compile(r"^(?:HR|NUR|BME)-(?:POL|SOP|F|C|R)-\d+$")


def main() -> None:
    d, out = Path(sys.argv[1]), Path(sys.argv[2])
    amap = json.loads((d / "bundle_map.json").read_text())
    answers: dict[str, dict] = {}
    bad_files = []
    for f in sorted((d / "results").glob("B*.json")):
        try:
            answers.update(json.loads(f.read_text(encoding="utf-8-sig")))
        except json.JSONDecodeError as ex:
            bad_files.append(f"{f.name}: {ex}")
    con = connect()
    req_ids = [v["requirement_id"] for v in amap.values()]
    meta = {r["id"]: dict(r) for r in con.execute(
        """SELECT q.id, q.statement, q.source_clause, q.regulation_id, s.section_number, s.section_title
           FROM requirements q LEFT JOIN obligations o ON o.id=q.obligation_id
           LEFT JOIN sections s ON s.id=o.section_id WHERE q.id = ANY(?)""", (req_ids,))}
    regs = {r["id"]: dict(r) for r in con.execute(
        """SELECT id, title, short_title, coalesce(nullif(regulator_short,''), regulator, '') AS regulator,
                  coalesce(nullif(official_document_url,''), source_url) AS url FROM regulations
           WHERE id = ANY(?)""", (list({v["regulation_id"] for v in amap.values()}),))}

    results: dict[str, dict] = {}
    missing, fixed_status, fixed_risk, dropped = [], 0, 0, 0
    for alias, m in amap.items():
        a = answers.get(alias)
        if a is None:
            missing.append(alias)
            continue
        st = str(a.get("st", "")).upper().replace(" ", "_")
        if st not in VALID:
            st, fixed_status = "GAP", fixed_status + 1
        risk = str(a.get("risk", "")).title()
        if st in ("MET", "NOT_APPLICABLE"):
            risk = "None"
        elif risk not in RISKS:
            risk, fixed_risk = "Medium", fixed_risk + 1
        by = []
        for c in a.get("by") or []:
            c = str(c).strip()
            (by.append(c) if CODE_RE.match(c) else None)
            dropped += 0 if CODE_RE.match(c) else 1
        results[m["requirement_id"]] = {"alias": alias, "st": st, "rk": risk, "ob": a.get("ob", ""), "rq": a.get("rq", ""),
                                        "who": a.get("who", ""), "freq": a.get("freq", ""), "by": by,
                                        "gap": a.get("gap", "") if st not in ("MET", "NOT_APPLICABLE") else "",
                                        "fix": a.get("fix", "") if st not in ("MET", "NOT_APPLICABLE") else "",
                                        "why": a.get("why", "")}

    # page format: regulation -> units (sections) -> items
    by_reg: dict[str, dict] = {}
    for rid, r in results.items():
        q = meta.get(rid, {})
        g = regs.get(q.get("regulation_id"), {})
        reg = by_reg.setdefault(g.get("id", "?"), {"id": g.get("id"), "title": g.get("title", ""), "short": g.get("short_title") or "",
                                                   "regulator": g.get("regulator", ""), "url": g.get("url") or "", "_u": {}})
        sec = (q.get("section_number") or "").strip() or "General"
        unit = reg["_u"].setdefault(sec, {"g": reg["title"][:60], "u": sec, "ut": q.get("section_title") or sec, "items": []})
        unit["items"].append({"c": q.get("source_clause") or r["alias"], "rid": rid, "t": re.sub(r"\s+", " ", q.get("statement") or "")[:600],
                              "ob": r["ob"], "rq": r["rq"], "st": r["st"], "rk": r["rk"], "cat": "", "gap": r["gap"],
                              "fix": r["fix"], "by": r["by"], "who": r["who"], "why": r["why"]})
    regs_out = []
    for reg in by_reg.values():
        units = list(reg.pop("_u").values())
        if len(units) > 60:                      # too many tiny sections: one scope per regulation is clearer
            units = [{"g": reg["title"][:60], "u": "All", "ut": reg["title"], "items": [i for u in units for i in u["items"]]}]
        reg["units"] = units
        regs_out.append(reg)
    unmet = lambda r: sum(1 for u in r["units"] for i in u["items"] if i["st"] not in ("MET", "NOT_APPLICABLE"))  # noqa: E731
    regs_out.sort(key=lambda r: -unmet(r))
    out.write_text(json.dumps({"regulations": regs_out, "results": results}, ensure_ascii=False))
    tally: dict = {}
    for r in results.values():
        tally[r["st"]] = tally.get(r["st"], 0) + 1
    rk: dict = {}
    for r in results.values():
        rk[r["rk"]] = rk.get(r["rk"], 0) + 1
    print(f"answered {len(results)}/{len(amap)} · regulations {len(regs_out)}")
    print("status", tally)
    print("risk  ", rk)
    print(f"missing {len(missing)} (first: {missing[:6]}) · bad files {bad_files[:3]} · status fixed {fixed_status} · "
          f"risk defaulted {fixed_risk} · unknown codes dropped {dropped}")


if __name__ == "__main__":
    main()
