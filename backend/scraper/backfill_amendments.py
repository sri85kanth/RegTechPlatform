"""
Amendment history, extracted from the consolidated text already in the database.

WHY THIS FILE WAS REWRITTEN
---------------------------
The previous version read `company-brain-app/public/data/extracted/*.json` — a
static-JSON export from an architecture this project left behind. That
directory no longer exists, so the loop iterated zero files and wrote zero
rows. `regulation_amendments` was empty for that reason alone: the parser in
regulatory_ingestion/amendments.py is sound, and the section text it needs has
been in PostgreSQL all along. Nothing else was wrong, so nothing else changed —
the same `extract()` is called, with the same output contract.

WHAT IT DOES NOT DO
-------------------
It does not loosen the marker regex to raise recall. The parser only accepts a
full "…vide <instrument> <reference> dated <date>" footnote, which is why most
regulations that merely contain the word "vide" yield nothing. A looser pattern
would invent amendments that the drafter never recorded; an under-count that is
verifiable beats an over-count that is not.

    python backfill_amendments.py            # report only
    python backfill_amendments.py --apply
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter

from regulatory_ingestion.db import connect
from regulatory_ingestion.company_db import init_amendments
from regulatory_ingestion.amendments import extract


def sections_for(con, rid: str) -> list[dict]:
    """The parser wants {section_number, section_title, text} — its own contract."""
    return [dict(r) for r in con.execute(
        """SELECT section_number, section_title, section_text AS text
             FROM sections WHERE regulation_id = ?""", (rid,)).fetchall()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--ids", nargs="*", help="limit to specific regulation ids")
    a = ap.parse_args()

    con = init_amendments(connect())

    if a.ids:
        candidates = [r["id"] for r in con.execute(
            "SELECT id FROM regulations WHERE id = ANY(?)", (a.ids,)).fetchall()]
    else:
        # Only regulations whose text carries the footnote marker at all; the
        # rest cannot produce an amendment by construction.
        candidates = [r["regulation_id"] for r in con.execute(
            """SELECT DISTINCT regulation_id FROM sections
                WHERE section_text ILIKE '%vide%'""").fetchall()]

    written = skipped = 0
    per_reg: Counter[str] = Counter()
    actions: Counter[str] = Counter()
    for rid in candidates:
        rows = extract(sections_for(con, rid))
        if not rows:
            continue
        per_reg[rid] = len(rows)
        for r in rows:
            actions[r["action"]] += 1
            if not a.apply:
                continue
            # INSERT OR IGNORE is translated to ON CONFLICT DO NOTHING by pgdb,
            # so re-running is idempotent against the table's own unique index.
            con.execute(
                """INSERT OR IGNORE INTO regulation_amendments
                   (regulation_id, section_number, section_title, action, meaning,
                    instrument, reference, amended_on, context, raw, extraction_method)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (rid, r["section_number"], r["section_title"], r["action"], r["meaning"],
                 r["instrument"], r["reference"], r["amended_on"], r["context"], r["raw"],
                 "amendments.MARKER/1"))
            written += 1
    if a.apply:
        con.commit()

    total = con.execute("SELECT COUNT(*) FROM regulation_amendments").fetchone()[0]
    print(f"candidates scanned          : {len(candidates)}")
    print(f"regulations with amendments : {len(per_reg)}")
    print(f"amendment rows {'written' if a.apply else 'derivable'}     : {written or sum(per_reg.values())}")
    print(f"by action                   : {dict(actions)}")
    print(f"regulation_amendments now   : {total}")
    for rid, n in per_reg.most_common(8):
        print(f"    {rid:<28} {n}")
    if not a.apply:
        print("\n(report only — pass --apply to write)")


if __name__ == "__main__":
    sys.exit(main())
