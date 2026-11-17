#!/usr/bin/env python3
"""
Re-extract applicability rules for every regulation that (a) currently holds an
Unknown-typed rule and (b) names a party the CURRENT vocabulary can see.

Why this exists alongside reextract_rules.py
--------------------------------------------
reextract_rules.py scopes to NEW_TERMS — the six parties added on 2026-09-26.
The healthcare block (hospitals, clinical establishments, nursing homes,
diagnostic centres, pharmacies, practitioners, occupiers, waste generators)
was added to APPLICABILITY_VOCAB on 2026-09-10 and never re-read, so those
regulations still carry entity_type 'Unknown'. Measured 2026-09-28: 21,242
regulations hold an Unknown rule; 3,458 of them name a party the vocabulary
now knows.

Scoping comes from APPLICABILITY_VOCAB itself, so this script cannot drift from
the extractor again: widen the vocabulary and the scope widens with it.

Same write contract as reextract_rules.py: rules are deleted and rewritten one
regulation at a time. Nothing references applicability_rules by id, so a scoped
rebuild cannot orphan a verdict; verdicts are recomputed afterwards by
materialise_applicability.
"""
import argparse, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                          # noqa: E402
from regulatory_ingestion.parsers import extract_applicability       # noqa: E402
from regulatory_ingestion.parsers import APPLICABILITY_VOCAB         # noqa: E402

_now = lambda: datetime.now(timezone.utc)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    con = connect()

    terms = sorted({t.lower() for t in APPLICABILITY_VOCAB})
    where = " OR ".join(["lower(s.section_text) LIKE ?"] * len(terms))
    q = (f"SELECT DISTINCT s.regulation_id AS id FROM sections s "
         f"WHERE s.regulation_id IN (SELECT regulation_id FROM applicability_rules "
         f"                          WHERE entity_type = 'Unknown' OR entity_type IS NULL) "
         f"  AND ({where}) ORDER BY 1")
    if a.limit:
        q += f" LIMIT {a.limit}"
    regs = [r["id"] for r in con.execute(q, tuple("%" + t + "%" for t in terms)).fetchall()]
    print(f"[rules] {len(regs):,} regulations hold an Unknown rule and name a known party",
          flush=True)

    gained, rows_total, before_addressee, after_addressee = 0, 0, 0, 0
    before_unknown, after_unknown = 0, 0
    for n, rid in enumerate(regs, 1):
        secs = [{"no": s["section_number"], "heading": "", "text": s["section_text"] or ""}
                for s in con.execute("SELECT section_number, section_text FROM sections "
                                     "WHERE regulation_id = ? ORDER BY id", (rid,)).fetchall()]
        found = extract_applicability(secs)
        had = con.execute("SELECT COUNT(*) FROM applicability_rules WHERE regulation_id = ? "
                          "AND role LIKE 'ADDRESSEE%'", (rid,)).fetchone()[0]
        unk = con.execute("SELECT COUNT(*) FROM applicability_rules WHERE regulation_id = ? "
                          "AND (entity_type = 'Unknown' OR entity_type IS NULL)",
                          (rid,)).fetchone()[0]
        now = sum(1 for f in found if str(f.get("role") or "").startswith("ADDRESSEE"))
        now_unk = sum(1 for f in found
                      if (f.get("entity_type") or "Unknown") == "Unknown")
        before_addressee += had
        after_addressee += now
        before_unknown += unk
        after_unknown += now_unk
        if now > had:
            gained += 1
        rows_total += len(found)
        if a.apply:
            con.execute("DELETE FROM applicability_rules WHERE regulation_id = ?", (rid,))
            con.executemany(
                "INSERT INTO applicability_rules (regulation_id, entity_type, applicability, "
                "applicability_rule, source_clause, confidence, role, evidence, classified_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                [(rid, f.get("entity_type"), f.get("applicability"), f.get("applicability_rule"),
                  f.get("source_clause"), f.get("confidence"), f.get("role"),
                  f.get("applicability_rule"), _now()) for f in found])
        if n % 250 == 0:
            print(f"  … {n}/{len(regs)}", flush=True)

    print(f"\n  rules that would be written      {rows_total:,}")
    print(f"  addressee rules before           {before_addressee:,}")
    print(f"  addressee rules after            {after_addressee:,}")
    print(f"  Unknown rules before             {before_unknown:,}")
    print(f"  Unknown rules after              {after_unknown:,}")
    print(f"  regulations gaining an addressee {gained:,}")
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.commit()
    print(f"\nwritten: {rows_total:,} rules across {len(regs):,} regulations")


if __name__ == "__main__":
    main()
