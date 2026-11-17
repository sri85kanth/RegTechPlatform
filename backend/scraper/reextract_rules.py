#!/usr/bin/env python3
"""
Re-extract applicability rules for regulations that name a party the vocabulary
could not see before.

WHY
---
APPLICABILITY_VOCAB is what the extractor looks for in a regulation's text. A
party missing from it is invisible: the rule is stored with entity_type
"Unknown" and role UNCERTAIN, and evaluate() skips it, so the regulation can
never reach anyone. 21,382 of 34,559 rules are in that state. On 2026-09-26 the
vocabulary gained data fiduciary, food business operator, approved place,
principal employer, contractor and building owner — every one a party this
company IS — but a vocabulary change does nothing until the text is read again.

SCOPE
-----
Only regulations whose stored text actually contains one of the new terms. The
rest would re-extract to exactly what they already hold, and rewriting 30,414
regulations to reproduce them is not a change, it is a risk.

REPLACES PER REGULATION, NEVER GLOBALLY
---------------------------------------
Rules are deleted and rewritten one regulation at a time. Nothing references
applicability_rules by id — applicability_results point at the regulation — so a
scoped rebuild cannot orphan a verdict; the verdict is recomputed afterwards by
materialise_applicability.
"""
import argparse, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                        # noqa: E402
from regulatory_ingestion.parsers import extract_applicability     # noqa: E402

NEW_TERMS = ["data fiduciary", "data fiduciaries", "food business operator",
             "approved place", "principal employer", "contractor", "building owner",
             "owners or occupiers"]
_now = lambda: datetime.now(timezone.utc)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    con = connect()

    where = " OR ".join(["lower(s.section_text) LIKE ?"] * len(NEW_TERMS))
    q = f"SELECT DISTINCT s.regulation_id AS id FROM sections s WHERE {where} ORDER BY 1"
    if a.limit:
        q += f" LIMIT {a.limit}"
    regs = [r["id"] for r in con.execute(q, tuple("%" + t + "%" for t in NEW_TERMS)).fetchall()]
    print(f"[rules] {len(regs):,} regulations name one of the new parties", flush=True)

    gained, rows_total, before_addressee, after_addressee = 0, 0, 0, 0
    for n, rid in enumerate(regs, 1):
        secs = [{"no": s["section_number"], "heading": "", "text": s["section_text"] or ""}
                for s in con.execute("SELECT section_number, section_text FROM sections "
                                     "WHERE regulation_id = ? ORDER BY id", (rid,)).fetchall()]
        found = extract_applicability(secs)
        had = con.execute("SELECT COUNT(*) FROM applicability_rules WHERE regulation_id = ? "
                          "AND role LIKE 'ADDRESSEE%'", (rid,)).fetchone()[0]
        now = sum(1 for f in found if str(f.get("role") or "").startswith("ADDRESSEE"))
        before_addressee += had
        after_addressee += now
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
        if n % 200 == 0:
            print(f"  … {n}/{len(regs)}", flush=True)

    print(f"\n  rules that would be written   {rows_total:,}")
    print(f"  addressee rules before        {before_addressee:,}")
    print(f"  addressee rules after         {after_addressee:,}")
    print(f"  regulations gaining an addressee {gained:,}")
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.commit()
    print(f"\nwritten: {rows_total:,} rules across {len(regs):,} regulations")


if __name__ == "__main__":
    main()
