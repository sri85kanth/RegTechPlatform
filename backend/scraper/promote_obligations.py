#!/usr/bin/env python3
"""
Give a requirement to an obligation that never got one.

WHY THEY ARE MISSING
--------------------
extract_clauses promotes a CLAUSE to a requirement, and a clause means an
enumeration marker the drafter typed — (a), (i), (2). Most duties in this
corpus are plain paragraphs with no marker, so 129,210 obligations in the
regulations that concern this company hold a duty that never became testable.

WHY THIS IS INSERT-ONLY
-----------------------
It writes requirements only for obligations that have none. It never deletes,
so the clause-derived requirements and, crucially, the 240,423 company
requirement instances that hang off them are untouched — the scoped rebuild in
extract_clauses has to DELETE first, and that cascade is what took half an hour.

THE BAR IS THE SAME ONE A CLAUSE CLEARS
---------------------------------------
`promotable()`: states a duty, names the party that owes it, and is not a
figures table. 11,268 of 129,210 pass. The rest are modal sentences with no
duty-bearer and OCR'd rate schedules, and calling those requirements would bury
every real duty on the compliance screen.
"""
import argparse, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect        # noqa: E402
from extract_clauses import promotable             # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
DEFAULT_VERDICTS = ["APPLICABLE", "CONDITIONAL", "REVIEW_REQUIRED"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--verdicts", default=",".join(DEFAULT_VERDICTS),
                    help="only regulations carrying one of these company verdicts")
    a = ap.parse_args()
    want = [v.strip().upper() for v in a.verdicts.split(",") if v.strip()]
    con = connect()

    rows = con.execute("""
        SELECT o.id, o.regulation_id, o.description, o.responsible_entity, o.frequency,
               s.section_number
          FROM obligations o
          LEFT JOIN sections s ON s.id = o.section_id
         WHERE NOT EXISTS (SELECT 1 FROM requirements q WHERE q.obligation_id = o.id)
           AND EXISTS (SELECT 1 FROM regulations r WHERE r.id = o.regulation_id
                         AND r.applicability = ANY(?::text[]))""", (want,)).fetchall()
    print(f"[promote] {len(rows):,} obligations with no requirement, in regulations "
          f"whose verdict is {', '.join(want)}", flush=True)

    out, regs = [], set()
    for r in rows:
        d = dict(r)
        if not promotable(d):
            continue
        regs.add(d["regulation_id"])
        out.append((f"{d['id']}-r", d["id"], d["regulation_id"],
                    (d["description"] or "")[:2000], None, None, None, d.get("frequency"),
                    None, d.get("responsible_entity"), None,
                    d.get("section_number"), (d["description"] or "")[:600], None,
                    # below a clause-derived requirement: the drafter marked no
                    # structure here, so the split is ours, not theirs
                    0.65, "section-obligation/1", "UNREVIEWED", _now()))

    print(f"[promote] {len(out):,} promotable, across {len(regs):,} regulations")
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.executemany(
        "INSERT INTO requirements (id, obligation_id, regulation_id, statement, "
        "expected_action, threshold, condition, frequency, deadline, responsible_role, "
        "test_method, source_clause, source_excerpt, page_number, confidence, "
        "derivation_method, review_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        out)
    con.commit()
    print(f"\nwritten: {len(out):,} requirements")


if __name__ == "__main__":
    main()
