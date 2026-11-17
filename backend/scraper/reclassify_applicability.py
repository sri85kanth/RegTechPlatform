#!/usr/bin/env python3
"""
Re-derive every applicability rule from the stored section text, using the
addressee test instead of a substring match.

WHY THIS RUNS AT ALL
--------------------
1,211 rules were recorded as "Applies" because an entity type appeared
somewhere in the document. Some of those are counterparty mentions — the
regulated party is somebody else and our company is the borrower, the vendor or
the exception. Those rules put other people's rulebooks on this company's
applicable list.

WHAT IT DOES NOT DO
-------------------
It does not DELETE a single row. Every existing rule is updated in place with
its role, its evidence sentence and a corrected verdict; rules whose entity
type can no longer be found in the source are marked UNCERTAIN rather than
removed. Newly discovered addressee rules are inserted. The audit trail of what
the system previously believed stays intact, and the change is re-runnable.
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from regulatory_ingestion import db  # noqa: E402
from regulatory_ingestion.addressee import (  # noqa: E402
    RANK, VERDICT, CONFIDENCE, UNCERTAIN, role_in, resolve_document,
)
from regulatory_ingestion.parsers import scan_addressees  # noqa: E402

def sections_for(con, rid: str) -> list[dict]:
    rows = con.execute(
        "SELECT section_number, section_title, section_text FROM sections "
        "WHERE regulation_id=? ORDER BY id", (rid,)).fetchall()
    return [dict(r) for r in rows]


def classify(secs: list[dict]) -> dict[str, dict]:
    """
    Strongest role per entity type.

    The scanning logic lives in parsers.scan_addressees and is shared with the
    ingest pipeline. It used to be copied here, which meant the two could
    disagree about what a document says — and did: only one of them got the
    whole-document fallback for texts with no scope clause.
    """
    best = scan_addressees([(s["section_number"], s["section_title"], s["section_text"])
                            for s in secs])
    return resolve_document(best)


def main() -> None:
    con = db.connect()
    rids = [r[0] for r in con.execute(
        "SELECT DISTINCT regulation_id FROM sections ORDER BY 1").fetchall()]
    print(f"[reclassify] {len(rids)} regulations with stored sections")

    tally = Counter()
    updated = inserted = orphaned = 0

    for n, rid in enumerate(rids, 1):
        best = classify(sections_for(con, rid))

        existing = {r["entity_type"]: r["id"] for r in
                    (dict(x) for x in con.execute(
                        "SELECT id, entity_type FROM applicability_rules WHERE regulation_id=?",
                        (rid,)).fetchall())}

        for ent, b in best.items():
            tally[b["role"]] += 1
            verdict, conf = VERDICT[b["role"]], CONFIDENCE[b["role"]]
            if ent in existing:
                con.execute(
                    "UPDATE applicability_rules SET applicability=?, applicability_rule=?, "
                    "source_clause=?, confidence=?, role=?, evidence=?, "
                    "classified_at=now() WHERE id=?",
                    (verdict, b["evidence"], f"Section {b['sec']}", conf, b["role"], b["evidence"],
                     existing[ent]))
                updated += 1
            else:
                con.execute(
                    "INSERT INTO applicability_rules (regulation_id, entity_type, applicability, "
                    "applicability_rule, source_clause, confidence, role, evidence, classified_at) "
                    "VALUES (?,?,?,?,?,?,?,?,now())",
                    (rid, ent, verdict, b["evidence"], f"Section {b['sec']}", conf, b["role"], b["evidence"]))
                inserted += 1

        # Rules the rescan could not reproduce. Kept, never deleted — but they
        # can no longer be presented as a finding.
        for ent, rid_row in existing.items():
            if ent not in best and ent != "Unknown":
                con.execute(
                    "UPDATE applicability_rules SET applicability='Unknown', role=?, "
                    "confidence=0, evidence='The entity type could not be located in the "
                    "stored section text on re-scan.', classified_at=now() WHERE id=?",
                    (UNCERTAIN, rid_row))
                orphaned += 1
                tally["NOT_REPRODUCED"] += 1

        if n % 100 == 0:
            con.commit()
            print(f"  … {n}/{len(rids)}")

    con.commit()
    print(f"[reclassify] updated {updated} · inserted {inserted} · not reproduced {orphaned}")
    for role, c in tally.most_common():
        print(f"    {role:20} {c}")


if __name__ == "__main__":
    main()
