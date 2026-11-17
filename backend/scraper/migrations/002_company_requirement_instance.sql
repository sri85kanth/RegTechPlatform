-- =====================================================================
-- 002 · The boundary between regulatory truth and company compliance
-- =====================================================================
--
-- WHAT THIS SEPARATES
-- -------------------
--   requirements                   what the REGULATOR requires. Immutable,
--                                  source-grounded, company-agnostic.
--   company_requirement_instances  what that requirement means for THIS
--                                  company, in a given scope.
--
-- Without this boundary, company state leaks into the regulatory record: an
-- owner, a deadline or a compliance status written onto `requirements` would
-- make the regulatory layer un-shareable across companies and, worse, would
-- let a company's assessment be mistaken for what the regulator wrote.
--
-- ONE SOURCE OF APPLICABILITY TRUTH
-- ---------------------------------
-- The verdict lives in `applicability_results` and NOWHERE else. A CRI holds a
-- foreign key to it, not a copy of it. The temptation is to denormalise a
-- `status` column onto the CRI for convenient queries; that is exactly how a
-- system ends up showing APPLICABLE on one screen and REVIEW_REQUIRED on
-- another. Read it through the view `v_company_requirements` instead — one
-- join, one answer.
--
-- SCOPE IS A TABLE, NOT COLUMNS
-- -----------------------------
-- product_id / channel_id / customer_type_id as columns on the CRI would cap
-- the model at the scope kinds we thought of today, and would make "applies to
-- Gold Loan but not to PPI" inexpressible. `company_requirement_scopes` carries
-- one row per scope with its own verdict, so a single requirement can be
-- APPLICABLE to one product and NOT_APPLICABLE to another.
--
-- EVERY ROW DECLARES WHAT KIND OF CLAIM IT IS
-- -------------------------------------------
-- `fact_class` answers: is this the regulator speaking, our reading of the
-- regulator, a fact about the company, our assessment, a derivation, or a human
-- decision? The UI must be able to explain the whole chain, and it cannot do
-- that if every row looks equally authoritative.
--
-- Additive only. No drops, no renames, no data loss.
-- =====================================================================

-- ---------- shared vocabulary ----------------------------------------
DO $$ BEGIN
  CREATE TYPE fact_class AS ENUM (
    'REGULATORY_FACT',           -- the regulator's own words
    'REGULATORY_INTERPRETATION', -- our reading of them
    'COMPANY_FACT',              -- something true about the company
    'COMPANY_ASSESSMENT',        -- our judgement about the company
    'SYSTEM_DERIVATION',         -- computed from other rows
    'HUMAN_DECISION'             -- a person decided this
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- 1. applicability results: the single verdict --------------
CREATE TABLE IF NOT EXISTS applicability_results (
  id                TEXT PRIMARY KEY,
  regulation_id     TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  company_id        BIGINT NOT NULL,
  -- COMPANY when the verdict is for the whole firm; otherwise the scope the
  -- verdict was computed for.
  scope_type        TEXT NOT NULL DEFAULT 'COMPANY',
  scope_entity_id   TEXT,
  verdict           TEXT NOT NULL,
  confidence        TEXT,
  reason            TEXT,
  checks            TEXT,      -- JSON: every check, its result and its citation
  missing_facts     TEXT,      -- JSON: what would settle a CONDITIONAL
  engine_version    TEXT NOT NULL,
  fact_class        fact_class NOT NULL DEFAULT 'COMPANY_ASSESSMENT',
  review_status     TEXT NOT NULL DEFAULT 'UNREVIEWED',
  computed_at       TEXT NOT NULL,
  CONSTRAINT ar_verdict_ck CHECK (verdict IN
    ('APPLICABLE','CONDITIONAL','NOT_APPLICABLE','REVIEW_REQUIRED','UNASSESSED')),
  CONSTRAINT ar_scope_ck CHECK (scope_type IN
    ('COMPANY','LEGAL_ENTITY','BUSINESS_UNIT','BUSINESS_ACTIVITY',
     'PRODUCT','CHANNEL','CUSTOMER_TYPE','GEOGRAPHY')),
  CONSTRAINT ar_review_ck CHECK (review_status IN
    ('UNREVIEWED','REVIEWED','APPROVED','REJECTED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ar_scope
  ON applicability_results (regulation_id, company_id, scope_type,
                            COALESCE(scope_entity_id, ''));
CREATE INDEX IF NOT EXISTS ix_ar_verdict ON applicability_results (verdict);

-- ---------- 2. company requirement instance ---------------------------
CREATE TABLE IF NOT EXISTS company_requirement_instances (
  id                      TEXT PRIMARY KEY,
  requirement_id          TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  company_id              BIGINT NOT NULL,
  -- The verdict is READ THROUGH here. Deliberately no status column.
  applicability_result_id TEXT REFERENCES applicability_results(id) ON DELETE SET NULL,

  effective_from          TEXT,
  effective_to            TEXT,
  compliance_deadline     TEXT,

  -- Derived from the evidence and testing chain, never asserted directly.
  compliance_status       TEXT NOT NULL DEFAULT 'NOT_ASSESSED',
  compliance_reason       TEXT,
  compliance_computed_at  TEXT,

  owner_id                TEXT,
  applicability_reason    TEXT,
  company_interpretation  TEXT,

  fact_class              fact_class NOT NULL DEFAULT 'COMPANY_ASSESSMENT',
  review_status           TEXT NOT NULL DEFAULT 'UNREVIEWED',
  reviewed_by             TEXT,
  reviewed_at             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT,
  CONSTRAINT cri_compliance_ck CHECK (compliance_status IN
    ('NOT_ASSESSED','NOT_TESTED','COMPLIANT','PARTIALLY_COMPLIANT',
     'NON_COMPLIANT','EVIDENCE_MISSING','REVIEW_REQUIRED','NOT_APPLICABLE')),
  CONSTRAINT cri_review_ck CHECK (review_status IN
    ('UNREVIEWED','REVIEWED','APPROVED','REJECTED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cri
  ON company_requirement_instances (requirement_id, company_id);
CREATE INDEX IF NOT EXISTS ix_cri_compliance
  ON company_requirement_instances (compliance_status);
CREATE INDEX IF NOT EXISTS ix_cri_result
  ON company_requirement_instances (applicability_result_id);

-- ---------- 3. scopes -------------------------------------------------
CREATE TABLE IF NOT EXISTS company_requirement_scopes (
  id                  TEXT PRIMARY KEY,
  cri_id              TEXT NOT NULL
                      REFERENCES company_requirement_instances(id) ON DELETE CASCADE,
  scope_type          TEXT NOT NULL,
  -- References company_entities(id) for PRODUCT / BUSINESS_ACTIVITY /
  -- LEGAL_ENTITY / GEOGRAPHY. NULL for the whole-company scope.
  scope_entity_id     TEXT,
  scope_label         TEXT,
  applicability_status TEXT NOT NULL DEFAULT 'UNASSESSED',
  reason              TEXT,
  source_rule_id      TEXT,
  confidence          REAL,
  fact_class          fact_class NOT NULL DEFAULT 'SYSTEM_DERIVATION',
  created_at          TEXT NOT NULL,
  CONSTRAINT crs_scope_ck CHECK (scope_type IN
    ('COMPANY','LEGAL_ENTITY','BUSINESS_UNIT','BUSINESS_ACTIVITY',
     'PRODUCT','CHANNEL','CUSTOMER_TYPE','GEOGRAPHY')),
  CONSTRAINT crs_status_ck CHECK (applicability_status IN
    ('APPLICABLE','CONDITIONAL','NOT_APPLICABLE','REVIEW_REQUIRED','UNASSESSED'))
);
CREATE INDEX IF NOT EXISTS ix_crs_cri ON company_requirement_scopes (cri_id);
CREATE INDEX IF NOT EXISTS ix_crs_entity ON company_requirement_scopes (scope_entity_id);

-- ---------- 4. provenance of the provision → clause link --------------
-- Why a provision cites the clause it cites, so an unresolved link is
-- distinguishable from a confident one rather than both reading as silence.
ALTER TABLE legal_provisions ADD COLUMN IF NOT EXISTS link_method TEXT;
ALTER TABLE legal_provisions ADD COLUMN IF NOT EXISTS link_confidence REAL;
COMMENT ON COLUMN legal_provisions.link_method IS
  'EXACT_TEXT | NORMALIZED_TEXT | STRUCTURAL | MANUAL | UNRESOLVED | NOT_APPLICABLE. '
  'NOT_APPLICABLE means the section carries no enumeration, so no clause exists '
  'to cite — distinct from UNRESOLVED, where clauses exist but the sentence '
  'could not be located in any of them.';

-- ---------- 5. one place to read a requirement for a company ----------
CREATE OR REPLACE VIEW v_company_requirements AS
SELECT
  cri.id                        AS cri_id,
  cri.company_id,
  rq.id                         AS requirement_id,
  rq.regulation_id,
  rq.statement,
  rq.source_clause,
  rq.frequency,
  rq.deadline,
  rq.responsible_role,
  rq.review_status              AS requirement_review_status,
  -- The verdict, read through the result table. Never stored on the CRI.
  ar.verdict                    AS applicability,
  ar.confidence                 AS applicability_confidence,
  ar.reason                     AS applicability_reason,
  ar.missing_facts,
  ar.scope_type                 AS verdict_scope,
  cri.effective_from,
  cri.compliance_deadline,
  cri.compliance_status,
  cri.compliance_reason,
  cri.owner_id,
  cri.review_status             AS instance_review_status
FROM company_requirement_instances cri
JOIN requirements rq            ON rq.id = cri.requirement_id
LEFT JOIN applicability_results ar ON ar.id = cri.applicability_result_id;
