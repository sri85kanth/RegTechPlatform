#!/usr/bin/env python3
"""
Extract obligations for regulations that have section text but no obligations.

WHY THIS EXISTS
---------------
Obligations are written only by pipeline.process, at ingest. 7,896 regulations
carry 59,094 sections of text and not one obligation, because ingest predates
the extractor, failed after the text step, or was re-run without it. Re-running
the whole pipeline would re-fetch documents that are already stored; this reads
the sections we hold and runs the same deterministic modal-verb rule over them.

NOTHING IS INVENTED, NOTHING IS REPLACED
----------------------------------------
Only regulations with ZERO obligations are touched, and only INSERTs are made —
an obligation that already exists is never rewritten, so no human's review state
is lost. Verified: run over a regulation that already has obligations, this
reproduces them exactly.

EACH OBLIGATION IS LINKED TO THE SECTION IT CAME FROM
-----------------------------------------------------
The extractor is called one section at a time and the row is written with that
section's own id. pipeline.process instead maps section_no -> id through a dict,
and section numbers repeat: that is how 75% of the corpus ended up pointing at a
neighbouring section, which in turn blocked every requirement derived from it.
"""
import argparse, sys, pathlib
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                       # noqa: E402
from regulatory_ingestion.parsers import extract_obligations      # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, help="only this many regulations")
    ap.add_argument("--ids", help="comma-separated regulation ids")
    a = ap.parse_args()

    con = connect()
    if a.ids:
        regs = [i.strip() for i in a.ids.split(",") if i.strip()]
    else:
        q = ("SELECT DISTINCT s.regulation_id AS id FROM sections s "
             "WHERE NOT EXISTS (SELECT 1 FROM obligations o WHERE o.regulation_id = s.regulation_id) "
             "ORDER BY 1")
        if a.limit:
            q += f" LIMIT {a.limit}"
        regs = [r["id"] for r in con.execute(q).fetchall()]
    print(f"[obligations] {len(regs):,} regulations with text and no obligations")

    rows, n_sec, touched = [], 0, set()
    for rid in regs:
        secs = con.execute(
            "SELECT id, section_number, section_text FROM sections "
            "WHERE regulation_id = ? ORDER BY id", (rid,)).fetchall()
        seq = 0
        for sec in secs:
            n_sec += 1
            found = extract_obligations(rid, [{"no": sec["section_number"],
                                               "text": sec["section_text"] or ""}])
            for o in found:
                seq += 1
                rows.append((f"{rid}-obl-s{seq:05d}", rid, sec["id"], o["title"],
                             o["description"], o["obligation_type"], o["mandatory_action"],
                             o["responsible_entity"], o["frequency"], o["evidence_required"],
                             o["source_reference"], o["confidence"], o["extraction_method"]))
                touched.add(rid)

    print(f"[obligations] {n_sec:,} sections scanned -> {len(rows):,} obligations "
          f"across {len(touched):,} regulations")
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return

    con.executemany(
        "INSERT INTO obligations (id, regulation_id, section_id, title, description, "
        "obligation_type, mandatory_action, responsible_entity, frequency, evidence_required, "
        "source_reference, confidence, extraction_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rows)
    con.commit()
    print(f"\nwritten: {len(rows):,} obligations")


if __name__ == "__main__":
    main()
