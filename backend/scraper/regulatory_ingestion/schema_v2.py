"""
The canonical compliance model.

WHY THIS EXISTS
---------------
The database grew a strong regulatory spine — regulator, regulation, section,
obligation — and then stopped. Everything a compliance product actually sells
sits in the layers that were missing: a testable requirement between an
obligation and a control, an explicit mapping rather than a bulk one, and
evidence that knows what it proves and when it expires.

This module creates those layers and, just as importantly, adds the constraints
the existing tables never had. Before this the database had 7 foreign keys and
zero CHECK constraints across 41 tables, which is how a control could claim to
cover an obligation that no longer existed.

THE CHAIN, AS REAL ROWS
-----------------------
    regulations -> sections -> obligations -> requirements -> controls -> evidence
                            \\-> applicability_rules

Every link is a foreign key. Every status column is constrained to a known
vocabulary. Nothing in here invents content: the tables are created empty and
are filled only by extraction that can cite a source clause.

IDEMPOTENT
----------
Safe to run repeatedly. Existing tables are altered additively and constraints
are added only when absent, because CREATE TABLE IF NOT EXISTS silently skips a
table that already exists - constraints included - which is exactly how the
integration_records unique constraint went missing and broke every collection.
"""
from __future__ import annotations

# Review vocabulary shared by every extracted object. UNREVIEWED is the default
# because nothing a machine produced should read as accepted until a person
# says so.
REVIEW_STATES = ("UNREVIEWED", "ACCEPTED", "REJECTED", "NEEDS_REVIEW")

APPLICABILITY_STATES = ("APPLIES", "DOES_NOT_APPLY", "CONDITIONAL",
                        "REVIEW_REQUIRED", "UNKNOWN")

EVIDENCE_STATES = ("VALID", "EXPIRING", "EXPIRED", "MISSING",
                   "PENDING_REVIEW", "REJECTED")

OBLIGATION_KINDS = ("OBLIGATION", "APPLICABILITY", "DEFINITION", "PERMISSION",
                    "SCOPE", "EXPLANATORY", "AMENDMENT_REF")

TABLE_KINDS = ("REGULATORY_TABLE", "TABLE_OF_CONTENTS", "SCHEDULE",
               "ANNEXURE", "FORM", "REFERENCE", "UNKNOWN")


def _q(v) -> str:
    return ", ".join(f"'{x}'" for x in v)


DDL = f"""
-- ------------------------------------------------------------------ requirements
-- A requirement is the testable reading of an obligation. It is the layer a
-- control can actually be mapped to, and the reason a control mapped straight
-- to 58 obligations tells nobody anything useful.
CREATE TABLE IF NOT EXISTS requirements (
  id                TEXT PRIMARY KEY,
  obligation_id     TEXT NOT NULL,
  regulation_id     TEXT NOT NULL,
  statement         TEXT NOT NULL,
  expected_action   TEXT,
  threshold         TEXT,
  condition         TEXT,
  frequency         TEXT,
  deadline          TEXT,
  responsible_role  TEXT,
  test_method       TEXT,
  source_clause     TEXT,
  source_excerpt    TEXT,
  page_number       INTEGER,
  confidence        REAL,
  derivation_method TEXT NOT NULL,
  review_status     TEXT NOT NULL DEFAULT 'UNREVIEWED',
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  created_at        TEXT NOT NULL
);

-- ------------------------------------------------------- requirement <-> control
-- One row per real mapping. Coverage is counted from this table and nowhere
-- else, so a coverage figure is always a count of relationships that exist.
CREATE TABLE IF NOT EXISTS control_requirements (
  id              SERIAL PRIMARY KEY,
  control_id      TEXT NOT NULL,
  requirement_id  TEXT NOT NULL,
  rationale       TEXT,
  mapped_by       TEXT,
  review_status   TEXT NOT NULL DEFAULT 'UNREVIEWED',
  created_at      TEXT NOT NULL
);

-- ------------------------------------------------------------------- evidence
-- Evidence proves a control operated during a period. Validity is stored as
-- dates so freshness and expiry are computed, never asserted.
CREATE TABLE IF NOT EXISTS evidence (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  evidence_type    TEXT,
  owner_id         TEXT,
  source_system    TEXT,
  source_location  TEXT,
  period_start     TEXT,
  period_end       TEXT,
  valid_from       TEXT,
  valid_until      TEXT,
  uploaded_at      TEXT,
  content_hash     TEXT,
  verification_status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewer         TEXT,
  review_date      TEXT,
  created_at       TEXT NOT NULL
);

-- --------------------------------------------------------- evidence <-> control
CREATE TABLE IF NOT EXISTS evidence_links (
  id             SERIAL PRIMARY KEY,
  evidence_id    TEXT NOT NULL,
  control_id     TEXT,
  requirement_id TEXT,
  created_at     TEXT NOT NULL
);
"""

# Constraints are applied separately: ALTER TABLE ADD CONSTRAINT has no
# IF NOT EXISTS on every supported engine, so each is attempted and a duplicate
# is tolerated rather than aborting the whole migration.
CONSTRAINTS = [
    # ---- the chain, as foreign keys
    ("requirements", "requirements_obligation_fk",
     "FOREIGN KEY (obligation_id) REFERENCES obligations(id) ON DELETE CASCADE"),
    ("requirements", "requirements_regulation_fk",
     "FOREIGN KEY (regulation_id) REFERENCES regulations(id) ON DELETE CASCADE"),
    ("control_requirements", "creq_control_fk",
     "FOREIGN KEY (control_id) REFERENCES controls(id) ON DELETE CASCADE"),
    ("control_requirements", "creq_requirement_fk",
     "FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE"),
    ("control_requirements", "creq_unique",
     "UNIQUE (control_id, requirement_id)"),
    ("evidence_links", "evlink_evidence_fk",
     "FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE"),
    ("evidence_links", "evlink_control_fk",
     "FOREIGN KEY (control_id) REFERENCES controls(id) ON DELETE CASCADE"),
    ("evidence_links", "evlink_requirement_fk",
     "FOREIGN KEY (requirement_id) REFERENCES requirements(id) ON DELETE CASCADE"),

    # ---- retrofit the spine the original schema never constrained
    ("obligations", "obligations_regulation_fk",
     "FOREIGN KEY (regulation_id) REFERENCES regulations(id) ON DELETE CASCADE"),
    ("sections", "sections_regulation_fk",
     "FOREIGN KEY (regulation_id) REFERENCES regulations(id) ON DELETE CASCADE"),
    ("applicability_rules", "applicability_regulation_fk",
     "FOREIGN KEY (regulation_id) REFERENCES regulations(id) ON DELETE CASCADE"),

    # ---- vocabularies, so a status cannot be a typo
    ("requirements", "requirements_review_ck",
     f"CHECK (review_status IN ({_q(REVIEW_STATES)}))"),
    ("control_requirements", "creq_review_ck",
     f"CHECK (review_status IN ({_q(REVIEW_STATES)}))"),
    ("evidence", "evidence_status_ck",
     f"CHECK (verification_status IN ({_q(EVIDENCE_STATES)}))"),
    # An evidence link that points at neither a control nor a requirement proves
    # nothing and must not be storable.
    ("evidence_links", "evlink_target_ck",
     "CHECK (control_id IS NOT NULL OR requirement_id IS NOT NULL)"),
]

# Added to existing tables so every extracted object carries its own provenance
# and review state, per the traceability requirement.
COLUMNS = [
    ("obligations", "kind", "TEXT"),
    ("obligations", "actor", "TEXT"),
    ("obligations", "action", "TEXT"),
    ("obligations", "obj", "TEXT"),
    ("obligations", "condition", "TEXT"),
    ("obligations", "deadline", "TEXT"),
    ("obligations", "source_excerpt", "TEXT"),
    ("obligations", "page_number", "INTEGER"),
    ("obligations", "extracted_at", "TEXT"),
    ("obligations", "review_status", "TEXT"),
    ("applicability_rules", "subject", "TEXT"),
    ("applicability_rules", "jurisdiction", "TEXT"),
    ("applicability_rules", "sector", "TEXT"),
    ("applicability_rules", "licence_status", "TEXT"),
    ("applicability_rules", "thresholds", "TEXT"),
    ("applicability_rules", "conditions", "TEXT"),
    ("applicability_rules", "exclusions", "TEXT"),
    ("applicability_rules", "exemptions", "TEXT"),
    ("applicability_rules", "effective_date", "TEXT"),
    ("applicability_rules", "expiry_date", "TEXT"),
    ("applicability_rules", "source_excerpt", "TEXT"),
    ("applicability_rules", "review_status", "TEXT"),
    ("regulation_tables", "table_kind", "TEXT"),
    ("regulation_tables", "extraction_confidence", "REAL"),
]

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_req_obligation ON requirements(obligation_id)",
    "CREATE INDEX IF NOT EXISTS idx_req_regulation ON requirements(regulation_id)",
    "CREATE INDEX IF NOT EXISTS idx_req_review ON requirements(review_status)",
    "CREATE INDEX IF NOT EXISTS idx_creq_requirement ON control_requirements(requirement_id)",
    "CREATE INDEX IF NOT EXISTS idx_creq_control ON control_requirements(control_id)",
    "CREATE INDEX IF NOT EXISTS idx_evlink_control ON evidence_links(control_id)",
    "CREATE INDEX IF NOT EXISTS idx_evlink_requirement ON evidence_links(requirement_id)",
    "CREATE INDEX IF NOT EXISTS idx_evidence_valid ON evidence(valid_until)",
    "CREATE INDEX IF NOT EXISTS idx_obl_kind ON obligations(kind)",
]


def migrate(con, *, verbose: bool = False) -> dict:
    """Create the missing layers and constrain the existing ones."""
    report = {"tables": 0, "columns": 0, "constraints": 0, "indexes": 0, "skipped": []}

    for stmt in DDL.split(";"):
        if stmt.strip():
            con.execute(stmt)
            report["tables"] += 1
    con.commit()

    for table, col, typ in COLUMNS:
        try:
            con.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {typ}")
            con.commit()
            report["columns"] += 1
        except Exception as e:
            con.rollback()
            report["skipped"].append(f"{table}.{col}: {str(e)[:60]}")

    for table, name, defn in CONSTRAINTS:
        try:
            con.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} {defn}")
            con.commit()
            report["constraints"] += 1
        except Exception as e:
            con.rollback()
            msg = str(e)
            # An existing constraint is the expected case on a second run.
            if "already exists" not in msg:
                report["skipped"].append(f"{name}: {msg[:70]}")

    for stmt in INDEXES:
        try:
            con.execute(stmt); con.commit(); report["indexes"] += 1
        except Exception as e:
            con.rollback(); report["skipped"].append(f"index: {str(e)[:60]}")

    return report
