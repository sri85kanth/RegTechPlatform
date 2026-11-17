#!/usr/bin/env python3
"""
Accept the proposed control-to-duty links, in bulk, on the account owner's
instruction.

The review state is a record of a decision, so it records the decision that was
actually taken: accepted in bulk by the admin account on this date, NOT reviewed
one by one. `mapping_method` keeps saying how the link was derived, and
`rationale` says how it was accepted, so an auditor reading this later sees a
bulk acceptance and not 12,156 individual judgements.
"""
import argparse, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
ACTOR = "usr-59b7316aa4eb"          # the admin account


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()
    n = con.execute("SELECT COUNT(*) FROM control_requirements WHERE review_status = 'UNREVIEWED'").fetchone()[0]
    print(f"[accept] {n:,} links to accept, and {con.execute('SELECT COUNT(*) FROM controls').fetchone()[0]} controls")
    if not a.apply:
        print("(report only — pass --apply to write)")
        return
    note = ("Accepted in bulk by the account owner on " + _now()[:10] +
            "; not individually reviewed.")
    con.execute("""UPDATE control_requirements
                      SET review_status = 'ACCEPTED', reviewed_by = ?, reviewed_at = ?,
                          updated_at = ?, rationale = COALESCE(rationale,'') || ' ' || ?
                    WHERE review_status = 'UNREVIEWED'""", (ACTOR, _now(), _now(), note))
    con.commit()
    print(f"accepted: {n:,} links, recorded as a bulk acceptance by {ACTOR}")


if __name__ == "__main__":
    main()
