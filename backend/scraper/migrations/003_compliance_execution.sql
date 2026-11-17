-- =====================================================================
-- 003 · Compliance execution: the boxes below CONTROL that had no table
-- =====================================================================
--
-- The target chain is
--
--   CRI → CONTROL → EVIDENCE → TEST → FINDING → REMEDIATION → VALIDATION
--                                                          → DERIVED COMPLIANCE
--
-- Before this migration, TEST, FINDING and VALIDATION had no table at all, and
-- CHAPTER/PART above the section had none either. A chain the schema cannot
-- express cannot be derived from, which is why compliance_status was a
-- hardcoded string.
--
-- These tables are created EMPTY and will stay empty until a person performs
-- a test or records a finding. That is correct. The value of this migration is
-- not rows; it is that `derive_compliance.py` can now compute a status from
-- the chain instead of asserting one, and that every status it returns cites
-- the exact missing link.
--
-- REMEDIATION is not a new table. `actions` already exists with an owner, a
-- state machine and 17 rows; it gains a `finding_id` so a remediation can
-- point at what it remediates.
--
-- Additive only.
-- =====================================================================

-- ---------- CHAPTER / PART, above SECTION -----------------------------
CREATE TABLE IF NOT EXISTS chapters (
  id              TEXT PRIMARY KEY,
  regulation_id   TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  document_id     TEXT,
  chapter_number  TEXT,
  title           TEXT,
  ordinal         INT,
  first_section_id TEXT,
  last_section_id  TEXT,
  fact_class      fact_class NOT NULL DEFAULT 'REGULATORY_FACT',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_chapters_reg ON chapters (regulation_id);
ALTER TABLE sections ADD COLUMN IF NOT EXISTS chapter_id TEXT;

-- ---------- TEST -------------------------------------------------------
-- A test is an act performed against a control for a company requirement,
-- on a date, by a person, with an outcome. It is never a regulatory fact.
CREATE TABLE IF NOT EXISTS compliance_tests (
  id              TEXT PRIMARY KEY,
  cri_id          TEXT NOT NULL
                  REFERENCES company_requirement_instances(id) ON DELETE CASCADE,
  control_id      TEXT NOT NULL REFERENCES controls(id) ON DELETE CASCADE,
  procedure       TEXT,
  frequency       TEXT,
  sample_size     INT,
  performed_by    TEXT,
  performed_at    TEXT,
  period_from     TEXT,
  period_to       TEXT,
  result          TEXT NOT NULL DEFAULT 'NOT_TESTED',
  result_notes    TEXT,
  evidence_ids    TEXT,              -- JSON array of evidence.id consulted
  fact_class      fact_class NOT NULL DEFAULT 'HUMAN_DECISION',
  created_at      TEXT NOT NULL,
  CONSTRAINT ct_result_ck CHECK (result IN
    ('NOT_TESTED','PASS','FAIL','PARTIAL','INCONCLUSIVE'))
);
CREATE INDEX IF NOT EXISTS ix_ct_cri ON compliance_tests (cri_id);
CREATE INDEX IF NOT EXISTS ix_ct_result ON compliance_tests (result);

-- ---------- FINDING ----------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
  id              TEXT PRIMARY KEY,
  cri_id          TEXT NOT NULL
                  REFERENCES company_requirement_instances(id) ON DELETE CASCADE,
  test_id         TEXT REFERENCES compliance_tests(id) ON DELETE SET NULL,
  control_id      TEXT REFERENCES controls(id) ON DELETE SET NULL,
  severity        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  root_cause      TEXT,
  raised_by       TEXT,
  raised_at       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN',
  closed_at       TEXT,
  fact_class      fact_class NOT NULL DEFAULT 'HUMAN_DECISION',
  CONSTRAINT f_sev_ck CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  CONSTRAINT f_status_ck CHECK (status IN
    ('OPEN','IN_REMEDIATION','REMEDIATED','VALIDATED','CLOSED','ACCEPTED_RISK'))
);
CREATE INDEX IF NOT EXISTS ix_findings_cri ON findings (cri_id);
CREATE INDEX IF NOT EXISTS ix_findings_status ON findings (status);

-- ---------- REMEDIATION: the existing actions table, now attachable ----
ALTER TABLE actions ADD COLUMN IF NOT EXISTS finding_id TEXT;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS cri_id TEXT;

-- ---------- VALIDATION -------------------------------------------------
-- Someone other than the remediator confirms the remediation worked.
CREATE TABLE IF NOT EXISTS validations (
  id              TEXT PRIMARY KEY,
  finding_id      TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  action_id       TEXT,
  validated_by    TEXT NOT NULL,
  validated_at    TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  notes           TEXT,
  evidence_ids    TEXT,
  fact_class      fact_class NOT NULL DEFAULT 'HUMAN_DECISION',
  CONSTRAINT v_outcome_ck CHECK (outcome IN ('EFFECTIVE','INEFFECTIVE','PARTIAL'))
);
CREATE INDEX IF NOT EXISTS ix_validations_finding ON validations (finding_id);

-- ---------- CRI ↔ CONTROL: give the link a place to carry provenance ---
ALTER TABLE control_requirements ADD COLUMN IF NOT EXISTS cri_id TEXT;
ALTER TABLE control_requirements ADD COLUMN IF NOT EXISTS derived_from TEXT;
ALTER TABLE control_requirements ADD COLUMN IF NOT EXISTS fact_class fact_class
  NOT NULL DEFAULT 'SYSTEM_DERIVATION';
CREATE INDEX IF NOT EXISTS ix_creq_cri ON control_requirements (cri_id);
