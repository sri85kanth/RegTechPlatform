"""
Remove the demonstration company and everything derived from it.

WHY THIS IS NOT ONE DELETE
--------------------------
Only two foreign keys point at the seed roots, and both are SET NULL rather
than CASCADE. Deleting `company_entities` on its own therefore leaves ~117,000
rows across eleven tables referencing entities that no longer exist — a graph
that looks populated and is entirely dangling. So the derived layers are
removed first, in dependency order, and the roots last.

WHAT IS NOT TOUCHED
-------------------
The regulation side. Regulations, sections, clauses, obligations,
requirements, definitions, penalties, cross-references, amendments, changes,
document versions and provenance are the product of scraping government
sources; none of it is seed and none of it is removed. `source_register` and
its portals stay too — a curated register is not company data.

    python remove_company_seed.py              # dry run: exact counts
    python remove_company_seed.py --apply
"""
from __future__ import annotations

import argparse

from regulatory_ingestion.db import connect

# Derived first, roots last. Each entry: (table, why it goes).
DERIVED = [
    ("assessments",                   "an assessment of a control that will not exist"),
    ("control_evidence",              "links between seed controls and seed evidence"),
    ("control_requirements",          "derived from seed control→obligation links"),
    ("control_obligations",           "keyword matches from the seed controls"),
    ("company_mappings",              "proposals against seed entities"),
    ("obligation_status",             "per-company status rows"),
    ("impact_scores",                 "scored against the seed footprint"),
    ("impact_relationships",          "obligation↔entity matches"),
    ("company_requirement_scopes",    "scope rows under the company instances"),
    ("company_requirement_instances", "one per requirement, for this company"),
    ("applicability_results",         "verdicts about this company"),
    ("impact_runs",                   "agent runs over seed data"),
]

ROOTS = [
    ("evidence",             "seed evidence records"),
    ("controls",             "the 9 demonstration controls"),
    ("company_documents",    "uploaded demo documents"),
    ("entity_relationships", "edges between seed entities"),
    ("company_entities",     "the demonstration entities themselves"),
    ("company_profile",      "Meridian Finserv Limited — a fictional company"),
    ("integrations",         "the folder connector that loaded the seed"),
]

# Never removed. Listed so the intent is explicit rather than implied by absence.
PROTECTED = [
    "regulations", "sections", "clauses", "obligations", "requirements",
    "definitions", "penalty_provisions", "cross_references", "regulation_amendments",
    "section_changes", "document_versions", "documents", "verification_records",
    "provenance", "legal_provisions", "thresholds", "timing_rules",
    "provision_conditions", "provision_exceptions", "regulation_tables",
    "source_register", "source_register_portals", "users", "sessions",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--keep-integrations", action="store_true",
                    help="leave the connector configured")
    a = ap.parse_args()
    con = connect()

    plan = list(DERIVED) + [r for r in ROOTS
                            if not (a.keep_integrations and r[0] == "integrations")]

    print("REMOVING (derived first, roots last)")
    total = 0
    for table, why in plan:
        try:
            n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except Exception:
            print(f"  {table:<32} (absent)")
            continue
        total += n
        print(f"  {table:<32} {n:>7}   {why}")
        if a.apply and n:
            con.execute(f"DELETE FROM {table}")

    if a.apply:
        con.commit()

    print(f"\n  total rows {'removed' if a.apply else 'that would be removed'}: {total:,}")

    print("\nUNTOUCHED (the regulation side and the curated register)")
    for t in PROTECTED[:8]:
        try:
            print(f"  {t:<28} {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]:>8}")
        except Exception:
            pass
    print(f"  … and {len(PROTECTED) - 8} more tables left alone")

    if a.apply:
        # Prove it: nothing may still point at an entity that is gone.
        dangling = 0
        for t, col in (("impact_relationships", "entity_id"), ("obligation_status", "owner_id"),
                       ("company_mappings", "entity_id")):
            try:
                dangling += con.execute(
                    f"""SELECT COUNT(*) FROM {t} x WHERE x.{col} IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM company_entities e WHERE e.id = x.{col})"""
                ).fetchone()[0]
            except Exception:
                pass
        print(f"\n  dangling references after removal: {dangling}")
    else:
        print("\n(dry run — pass --apply to delete)")


if __name__ == "__main__":
    main()
