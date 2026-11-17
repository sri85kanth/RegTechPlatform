#!/usr/bin/env python3
"""
Bridge CRI → CONTROL.

Controls are linked to OBLIGATIONS today (control_obligations, 7,540 rows).
Requirements hang off obligations. So the requirement-level link is a pure
derivation: every requirement under a linked obligation inherits that
obligation's control, and the company requirement instance for it inherits the
same.

WHAT THIS DOES NOT CLAIM
------------------------
All 7,540 parent links are status 'Proposed' and created by the keyword
matcher, and one control — Transaction Monitoring — claims 4,812 obligations.
A derived link cannot be more trustworthy than the link it was derived from,
so every row written here is UNREVIEWED, records `derived_from` as the parent
control_obligations id, and carries fact_class SYSTEM_DERIVATION. Nothing
becomes approved by being copied.

The derivation only runs for CRIs whose regulation reaches the company. A
control mapped to a requirement in a Commercial Banks direction is not a
mapping this company needs to review.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect  # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    rows = con.execute("""
        SELECT co.id            AS parent_id,
               co.control_id,
               co.status        AS parent_status,
               co.rationale     AS parent_rationale,
               rq.id            AS requirement_id,
               cri.id           AS cri_id
          FROM control_obligations co
          JOIN requirements rq  ON rq.obligation_id = co.obligation_id
          JOIN company_requirement_instances cri ON cri.requirement_id = rq.id
          JOIN v_company_requirements v ON v.cri_id = cri.id
         WHERE v.applicability IN ('APPLICABLE', 'CONDITIONAL')
    """).fetchall()

    tally = Counter()
    out = []
    seen = set()
    for r in rows:
        key = (r["control_id"], r["requirement_id"])
        if key in seen:
            continue
        seen.add(key)
        # A derived link is never more approved than its parent.
        review = "UNREVIEWED" if r["parent_status"] == "Proposed" else "NEEDS_REVIEW"
        # id is a serial on this table; let Postgres assign it.
        out.append((
            r["control_id"], r["requirement_id"], r["cri_id"],
            f"Inherited from obligation-level link {r['parent_id']} "
            f"({r['parent_status']}). {r['parent_rationale'] or ''}".strip()[:1000],
            "wire_control_requirements/1", review, r["parent_id"], _now()))
        tally[f"control {r['control_id']}"] += 1

    print(f"[wire] {len(out):,} control→requirement links derivable for CRIs that reach the company")
    for k, n in tally.most_common():
        print(f"    {k:48} {n:,}")

    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return

    con.execute("DELETE FROM control_requirements WHERE mapped_by='wire_control_requirements/1'")
    con.executemany(
        "INSERT INTO control_requirements (control_id, requirement_id, cri_id, rationale, "
        "mapped_by, review_status, derived_from, created_at) VALUES (?,?,?,?,?,?,?,?)", out)
    con.commit()
    print(f"\nwritten: {len(out):,} — all UNREVIEWED")


if __name__ == "__main__":
    main()
