"""
Add referential integrity, indexes and views to PostgreSQL (company_brain).

    python -m regulatory_ingestion.migrate_constraints --dry-run   # report only
    python -m regulatory_ingestion.migrate_constraints             # apply

SQLite cannot ALTER TABLE ADD CONSTRAINT, so tables that gain a foreign key are
rebuilt: create shadow table with constraints, copy rows, drop, rename. The whole
run is one transaction — it either lands completely or not at all.

Orphaned rows are reported and, with --clean, removed before the constraint is
applied. Nothing is deleted silently.
"""
import argparse
import shutil
import sys
from pathlib import Path

from .db import connect

DB = Path(__file__).resolve().parent.parent / "output" / "PostgreSQL (company_brain)"

ORPHAN_CHECKS = [
    ("impact_relationships", "obligation_id", "obligations", "id"),
    ("impact_relationships", "company_brain_entity_id", "company_entities", "id"),
    ("entity_relationships", "source_id", "company_entities", "id"),
    ("entity_relationships", "target_id", "company_entities", "id"),
    ("company_mappings", "obligation_id", "obligations", "id"),
    ("company_mappings", "target_id", "company_entities", "id"),
]

# tables rebuilt to gain foreign keys, with their new definition
REBUILDS: dict[str, str] = {
    "impact_relationships": """
        CREATE TABLE impact_relationships (
          id TEXT PRIMARY KEY,
          regulation_id TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
          obligation_id TEXT REFERENCES obligations(id) ON DELETE CASCADE,
          company_brain_entity_id TEXT REFERENCES company_entities(id) ON DELETE CASCADE,
          entity_name TEXT, entity_domain TEXT, relationship_type TEXT,
          match_reason TEXT, match_signals TEXT, confidence REAL,
          regulation_clause_id TEXT, source TEXT, created_at TEXT
        )""",
    "entity_relationships": """
        CREATE TABLE entity_relationships (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES company_entities(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          target_id TEXT NOT NULL REFERENCES company_entities(id) ON DELETE CASCADE,
          confidence INTEGER DEFAULT 100,
          status TEXT DEFAULT 'Pending',
          created_at TEXT,
          UNIQUE (source_id, type, target_id)
        )""",
    "company_mappings": """
        CREATE TABLE company_mappings (
          id TEXT PRIMARY KEY,
          obligation_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES company_entities(id) ON DELETE CASCADE,
          target_domain TEXT,
          status TEXT DEFAULT 'Proposed'
            CHECK (status IN ('Proposed','Approved','Rejected','Needs Review')),
          confidence INTEGER, reason TEXT, source TEXT,
          created_by TEXT, reviewed_by TEXT, reviewed_at TEXT, rationale TEXT,
          created_at TEXT,
          UNIQUE (obligation_id, target_id)
        )""",
}

INDEXES = [
    # regulatory corpus — the columns the library and pipeline filter on
    "CREATE INDEX IF NOT EXISTS idx_reg_regulator   ON regulations(regulator_short)",
    "CREATE INDEX IF NOT EXISTS idx_reg_status      ON regulations(ingestion_status)",
    "CREATE INDEX IF NOT EXISTS idx_reg_impact      ON regulations(impact_level)",
    "CREATE INDEX IF NOT EXISTS idx_doc_reg         ON documents(regulation_id)",
    "CREATE INDEX IF NOT EXISTS idx_sec_reg         ON sections(regulation_id)",
    "CREATE INDEX IF NOT EXISTS idx_obl_reg         ON obligations(regulation_id)",
    "CREATE INDEX IF NOT EXISTS idx_obl_section     ON obligations(section_id)",
    "CREATE INDEX IF NOT EXISTS idx_obl_type        ON obligations(obligation_type)",
    "CREATE INDEX IF NOT EXISTS idx_app_reg         ON applicability_rules(regulation_id)",
    "CREATE INDEX IF NOT EXISTS idx_ver_reg         ON verification_records(regulation_id)",
    "CREATE INDEX IF NOT EXISTS idx_job_reg         ON ingestion_jobs(regulation_id)",
    # the seam — every join direction the app uses
    "CREATE INDEX IF NOT EXISTS idx_ir_obl          ON impact_relationships(obligation_id)",
    "CREATE INDEX IF NOT EXISTS idx_ir_entity       ON impact_relationships(company_brain_entity_id)",
    "CREATE INDEX IF NOT EXISTS idx_ir_reg          ON impact_relationships(regulation_id)",
    "CREATE INDEX IF NOT EXISTS idx_ir_conf         ON impact_relationships(confidence)",
    # company side
    "CREATE INDEX IF NOT EXISTS idx_ce_domain       ON company_entities(domain)",
    "CREATE INDEX IF NOT EXISTS idx_ce_type         ON company_entities(type)",
    "CREATE INDEX IF NOT EXISTS idx_ce_owner        ON company_entities(owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_ce_verification ON company_entities(verification)",
    "CREATE INDEX IF NOT EXISTS idx_er_src          ON entity_relationships(source_id)",
    "CREATE INDEX IF NOT EXISTS idx_er_tgt          ON entity_relationships(target_id)",
    "CREATE INDEX IF NOT EXISTS idx_cm_obl          ON company_mappings(obligation_id)",
    "CREATE INDEX IF NOT EXISTS idx_cm_target       ON company_mappings(target_id)",
    "CREATE INDEX IF NOT EXISTS idx_cm_status       ON company_mappings(status)",
    "CREATE INDEX IF NOT EXISTS idx_audit_at        ON audit_events(at)",
]

VIEWS = {
    # one row per regulation with everything the library card needs
    "v_regulation_summary": """
        CREATE VIEW v_regulation_summary AS
        SELECT r.id, r.title, r.regulator_short, r.regulation_type, r.sector,
               r.issued_on, r.ingestion_status, r.impact_level, s.score AS impact_score,
               (SELECT COUNT(*) FROM obligations o WHERE o.regulation_id = r.id)          AS obligations,
               (SELECT COUNT(*) FROM sections  x WHERE x.regulation_id = r.id)            AS sections,
               (SELECT COUNT(*) FROM impact_relationships i WHERE i.regulation_id = r.id) AS candidate_links,
               d.page_count, d.document_hash
        FROM regulations r
        LEFT JOIN impact_scores s ON s.regulation_id = r.id
        LEFT JOIN documents     d ON d.regulation_id = r.id""",

    # obligation with its full provenance chain, for citation display
    "v_obligation_provenance": """
        CREATE VIEW v_obligation_provenance AS
        SELECT o.id AS obligation_id, o.title, o.obligation_type, o.confidence,
               o.source_reference, sec.section_number, sec.section_title,
               r.id AS regulation_id, r.title AS regulation_title, r.regulator_short,
               d.page_count, d.source_url
        FROM obligations o
        LEFT JOIN sections  sec ON sec.id = o.section_id
        LEFT JOIN regulations r ON r.id  = o.regulation_id
        LEFT JOIN documents   d ON d.regulation_id = r.id""",

    # company entity with owner resolved and its edge counts
    "v_company_entity": """
        CREATE VIEW v_company_entity AS
        SELECT e.id, e.domain, e.type, e.name, e.criticality, e.verification, e.source,
               o.name AS owner_name,
               (SELECT COUNT(*) FROM entity_relationships x
                 WHERE x.source_id = e.id OR x.target_id = e.id)                   AS connections,
               (SELECT COUNT(*) FROM company_mappings m WHERE m.target_id = e.id
                  AND m.status = 'Approved')                                        AS approved_obligations
        FROM company_entities e
        LEFT JOIN company_entities o ON o.id = e.owner_id""",

    # what a reviewer needs to decide, in one row
    "v_review_queue": """
        CREATE VIEW v_review_queue AS
        SELECT m.id AS mapping_id, m.status, m.confidence, m.reason,
               o.title AS obligation, o.obligation_type, o.source_reference,
               r.title AS regulation, r.regulator_short,
               e.name AS entity, e.domain AS entity_domain, e.criticality
        FROM company_mappings m
        JOIN obligations      o ON o.id = m.obligation_id
        JOIN regulations      r ON r.id = o.regulation_id
        JOIN company_entities e ON e.id = m.target_id
        WHERE m.status IN ('Proposed','Needs Review')""",

    # pipeline health at a glance
    "v_pipeline_status": """
        CREATE VIEW v_pipeline_status AS
        SELECT regulator_short, ingestion_status, COUNT(*) AS regulations
        FROM regulations GROUP BY regulator_short, ingestion_status""",

    # the integrity problem, kept queryable rather than buried
    "v_orphan_matches": """
        CREATE VIEW v_orphan_matches AS
        SELECT i.id, i.regulation_id, i.obligation_id, i.company_brain_entity_id, i.entity_name
        FROM impact_relationships i
        LEFT JOIN company_entities e ON e.id = i.company_brain_entity_id
        WHERE e.id IS NULL""",
}


def orphans(con) -> list[tuple[str, str, str, int]]:
    out = []
    for tbl, col, ref, refcol in ORPHAN_CHECKS:
        n = con.execute(
            f"SELECT COUNT(*) FROM {tbl} t LEFT JOIN {ref} r ON r.{refcol}=t.{col} "
            f"WHERE t.{col} IS NOT NULL AND r.{refcol} IS NULL"
        ).fetchone()[0]
        if n:
            out.append((tbl, col, ref, n))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--clean", action="store_true", help="delete orphaned rows so constraints can apply")
    args = ap.parse_args()

    con = connect()
    con.execute("PRAGMA foreign_keys=OFF")

    found = orphans(con)
    print("orphaned rows:")
    if found:
        for tbl, col, ref, n in found:
            print(f"  {n:>7}  {tbl}.{col} → {ref}")
    else:
        print("  none")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return
    if found and not args.clean:
        print("\nrefusing to proceed — those rows would violate the new constraints.")
        print("re-run with --clean to delete them, or fix them first.")
        sys.exit(1)

    backup = DB.with_suffix(".db.bak")
    shutil.copyfile(DB, backup)
    print(f"\nbackup → {backup.name}")

    con.execute("BEGIN")
    try:
        if args.clean:
            for tbl, col, ref, _ in found:
                refcol = "id"
                n = con.execute(
                    f"DELETE FROM {tbl} WHERE {col} IS NOT NULL AND {col} NOT IN (SELECT {refcol} FROM {ref})"
                ).rowcount
                print(f"  deleted {n} orphaned rows from {tbl}")

        for table, ddl in REBUILDS.items():
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})")]
            con.execute(f"ALTER TABLE {table} RENAME TO _old_{table}")
            con.execute(ddl)
            collist = ",".join(cols)
            con.execute(f"INSERT OR IGNORE INTO {table} ({collist}) SELECT {collist} FROM _old_{table}")
            con.execute(f"DROP TABLE _old_{table}")
            print(f"  rebuilt {table} with foreign keys")

        for stmt in INDEXES:
            con.execute(stmt)
        print(f"  {len(INDEXES)} indexes ensured")

        for name, ddl in VIEWS.items():
            con.execute(f"DROP VIEW IF EXISTS {name}")
            con.execute(ddl)
        print(f"  {len(VIEWS)} views created")

        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise

    con.execute("PRAGMA foreign_keys=ON")
    bad = con.execute("PRAGMA foreign_key_check").fetchall()
    print(f"\nforeign_key_check: {'clean' if not bad else str(len(bad)) + ' violations'}")
    con.execute("ANALYZE")
    con.execute("VACUUM")
    print("analyzed + vacuumed")


if __name__ == "__main__":
    main()
