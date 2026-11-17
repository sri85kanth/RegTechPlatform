"""
One-time migration: move the Company Brain out of frontend TypeScript seed
modules and into the database, so the app has a real source of record.

Reads the export the frontend already produces (company_brain.json) and
writes it into company_entities / entity_relationships / company_mappings.
After this the seed files are no longer the source of truth.
"""
import json
import pathlib
import sys

from regulatory_ingestion.company_db import init, upsert_entity, add_relationship, log, now

SRC = pathlib.Path(__file__).parent / "input" / "company_brain.json"

OPERATIONAL = {"people", "processes", "systems", "data", "policies", "controls", "risks", "evidence"}


def main(only_operational: bool = False) -> None:
    if not SRC.exists():
        sys.exit(f"missing {SRC} — run `npx tsx scripts/export-brain.ts` in company-brain-app first")
    data = json.loads(SRC.read_text())
    con = init()

    ents = data.get("entities", [])
    if only_operational:
        ents = [e for e in ents if e["domain"] in OPERATIONAL]

    for e in ents:
        upsert_entity(con, e, actor="seed-migration")

    for r in data.get("relationships", []):
        add_relationship(con, {
            "id": r.get("id") or f"rel-{r['sourceId']}-{r['type']}-{r['targetId']}",
            "sourceId": r["sourceId"], "type": r["type"], "targetId": r["targetId"],
            "confidence": r.get("confidence", 100), "status": r.get("status", "Verified"),
        })

    for m in data.get("mappings", []):
        con.execute(
            """INSERT OR REPLACE INTO company_mappings
               (id,obligation_id,target_id,target_domain,status,confidence,reason,source,
                created_by,reviewed_by,reviewed_at,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (m["id"], m["obligationId"], m["targetId"], m.get("targetDomain"), m.get("status", "Proposed"),
             m.get("confidence"), m.get("reason"), m.get("source", "Seed"), m.get("createdBy"),
             m.get("reviewedBy"), m.get("reviewedAt"), now()),
        )

    log(con, "-", "seed migrated to database", f"{len(ents)} entities", "migration")
    con.commit()

    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("company_entities", "entity_relationships", "company_mappings")}
    print("migrated →", counts)


if __name__ == "__main__":
    main(only_operational="--operational-only" in sys.argv)
