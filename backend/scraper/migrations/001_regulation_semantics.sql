-- ============================================================================
-- Regulation module — separate REGULATORY FACT from ANALYSIS from COMPANY.
--
-- Strictly additive. No table is dropped, no column renamed, no id changed:
-- 12 foreign keys and 14 API endpoints depend on the current shape.
--
-- Layering enforced by table, not by convention:
--     REGULATORY SOURCE   documents, document_versions
--     REGULATORY CONTENT  sections, clauses, definitions
--     REGULATORY SEMANTICS legal_provisions, obligations, requirements,
--                          conditions, exceptions, thresholds, timing_rules,
--                          reporting/record/disclosure requirements
--     REGULATORY ANALYSIS regulatory_analysis        (AI, marked PROPOSED)
--     COMPANY COMPLIANCE  controls, evidence, actions (already separate)
-- ============================================================================

-- ---------------------------------------------------------------- identity
-- The spec separates issued / published / effective. A document's printed date
-- is NOT its effective date, and conflating them misstates when a rule bites.
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS notification_number TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS circular_number     TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS issuing_department  TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS issuing_authority   TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS published_date      TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS country             TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS state               TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS language            TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS legal_authority     TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS enabling_act        TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS enabling_section    TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS first_published_at  TEXT;
ALTER TABLE regulations ADD COLUMN IF NOT EXISTS last_verified_at    TEXT;

-- ---------------------------------------------------------------- provenance
-- One provenance row per extracted fact, so "where did this come from?" has a
-- single answer shape rather than a different set of columns on every table.
CREATE TABLE IF NOT EXISTS provenance (
  id                  BIGSERIAL PRIMARY KEY,
  regulation_id       TEXT REFERENCES regulations(id) ON DELETE CASCADE,
  document_id         TEXT,
  document_version_id BIGINT,
  source_authority    TEXT,
  source_url          TEXT,
  sha256              TEXT,
  retrieved_at        TEXT,
  page_number         INTEGER,
  section_reference   TEXT,
  clause_reference    TEXT,
  paragraph_reference TEXT,
  source_text         TEXT,            -- the exact words this was taken from
  extraction_method   TEXT,            -- regex | docling | ocr | llm | human
  extraction_confidence DOUBLE PRECISION,
  review_status       TEXT DEFAULT 'UNREVIEWED',
  created_at          TEXT NOT NULL DEFAULT now()::text
);
CREATE INDEX IF NOT EXISTS idx_prov_reg ON provenance(regulation_id);

-- ---------------------------------------------------------------- definitions
-- A defined term is regulatory fact and must never be paraphrased in storage.
CREATE TABLE IF NOT EXISTS definitions (
  id             TEXT PRIMARY KEY,
  regulation_id  TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  term           TEXT NOT NULL,
  definition_text TEXT NOT NULL,       -- verbatim
  source_section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
  source_clause_id  TEXT,
  effective_from TEXT,
  effective_to   TEXT,
  provenance_id  BIGINT REFERENCES provenance(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT now()::text
);
CREATE INDEX IF NOT EXISTS idx_def_reg  ON definitions(regulation_id);
CREATE INDEX IF NOT EXISTS idx_def_term ON definitions(lower(term));

-- where a defined term is actually used
CREATE TABLE IF NOT EXISTS definition_usages (
  id            BIGSERIAL PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
  section_id    TEXT REFERENCES sections(id) ON DELETE CASCADE,
  UNIQUE (definition_id, section_id)
);

-- ---------------------------------------------------------------- provisions
-- The atomic unit of legal meaning: WHO must/may/must-not do WHAT to WHAT.
-- Obligations hang off provisions; a provision may also be a permission or a
-- prohibition, which an "obligation" alone cannot express.
CREATE TABLE IF NOT EXISTS legal_provisions (
  id              TEXT PRIMARY KEY,
  regulation_id   TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  section_id      TEXT REFERENCES sections(id) ON DELETE SET NULL,
  clause_id       TEXT,
  actor           TEXT,
  modality        TEXT,   -- SHALL | SHALL_NOT | MUST | MAY | SHOULD | REQUIRED | PROHIBITED | PERMITTED
  action          TEXT,
  object          TEXT,
  scope           TEXT,
  is_prohibition  BOOLEAN DEFAULT FALSE,
  is_permission   BOOLEAN DEFAULT FALSE,
  source_text     TEXT NOT NULL,       -- the sentence, verbatim
  normalized_text TEXT,
  provenance_id   BIGINT REFERENCES provenance(id) ON DELETE SET NULL,
  review_status   TEXT DEFAULT 'PROPOSED',
  created_at      TEXT NOT NULL DEFAULT now()::text
);
CREATE INDEX IF NOT EXISTS idx_prov_reg2 ON legal_provisions(regulation_id);
CREATE INDEX IF NOT EXISTS idx_prov_sec  ON legal_provisions(section_id);

-- link the existing 44,203 obligations to their provision without changing them
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS provision_id TEXT
  REFERENCES legal_provisions(id) ON DELETE SET NULL;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS modality TEXT;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS provenance_id BIGINT
  REFERENCES provenance(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- qualifiers
CREATE TABLE IF NOT EXISTS provision_conditions (
  id             BIGSERIAL PRIMARY KEY,
  provision_id   TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  obligation_id  TEXT REFERENCES obligations(id) ON DELETE CASCADE,
  condition_type TEXT,      -- IF | WHEN | WHERE | UNLESS | PROVIDED_THAT | SUBJECT_TO | IN_CASE
  expression     TEXT,
  structured_value TEXT,
  source_text    TEXT NOT NULL,
  provenance_id  BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cond_prov ON provision_conditions(provision_id);

CREATE TABLE IF NOT EXISTS provision_exceptions (
  id             BIGSERIAL PRIMARY KEY,
  provision_id   TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  obligation_id  TEXT REFERENCES obligations(id) ON DELETE CASCADE,
  exception_type TEXT,      -- EXCEPTION | EXEMPTION | CARVE_OUT
  expression     TEXT,
  applies_to     TEXT,
  source_text    TEXT NOT NULL,
  provenance_id  BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_exc_prov ON provision_exceptions(provision_id);

CREATE TABLE IF NOT EXISTS thresholds (
  id            BIGSERIAL PRIMARY KEY,
  provision_id  TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  obligation_id TEXT REFERENCES obligations(id) ON DELETE CASCADE,
  metric        TEXT,       -- transaction_amount | age | count | duration | ratio …
  operator      TEXT,       -- <= | >= | < | > | = | between
  value         TEXT,
  unit          TEXT,
  currency      TEXT,
  condition     TEXT,
  source_text   TEXT NOT NULL,
  provenance_id BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_thr_prov ON thresholds(provision_id);

CREATE TABLE IF NOT EXISTS timing_rules (
  id            BIGSERIAL PRIMARY KEY,
  provision_id  TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  obligation_id TEXT REFERENCES obligations(id) ON DELETE CASCADE,
  rule_type     TEXT,       -- DEADLINE | FREQUENCY | TRIGGER | GRACE_PERIOD | TRANSITION | VALID_FROM | VALID_TO
  expression    TEXT,
  value         TEXT,
  unit          TEXT,
  trigger_event TEXT,
  source_text   TEXT NOT NULL,
  provenance_id BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tim_prov ON timing_rules(provision_id);

-- ---------------------------------------------------------------- outputs
-- What the regulation requires be REPORTED / KEPT / DISCLOSED. These are
-- regulatory facts; the company's actual filings and evidence live elsewhere.
CREATE TABLE IF NOT EXISTS reporting_requirements (
  id                BIGSERIAL PRIMARY KEY,
  regulation_id     TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  provision_id      TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  report_type       TEXT,
  reporting_entity  TEXT,
  recipient         TEXT,
  submission_method TEXT,
  format            TEXT,
  deadline          TEXT,
  frequency         TEXT,
  trigger_event     TEXT,
  source_text       TEXT NOT NULL,
  provenance_id     BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rep_reg ON reporting_requirements(regulation_id);

CREATE TABLE IF NOT EXISTS record_requirements (
  id                  BIGSERIAL PRIMARY KEY,
  regulation_id       TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  provision_id        TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  record_type         TEXT,
  required_record     TEXT,
  retention_period    TEXT,
  format              TEXT,
  language            TEXT,
  storage_requirement TEXT,
  recipient           TEXT,
  source_text         TEXT NOT NULL,
  provenance_id       BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_reg ON record_requirements(regulation_id);

CREATE TABLE IF NOT EXISTS disclosures (
  id                  BIGSERIAL PRIMARY KEY,
  regulation_id       TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  provision_id        TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  disclosure_type     TEXT,
  audience            TEXT,
  content_requirement TEXT,
  channel             TEXT,
  timing              TEXT,
  language_requirement TEXT,
  source_text         TEXT NOT NULL,
  provenance_id       BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_dis_reg ON disclosures(regulation_id);

-- ---------------------------------------------------------------- references
CREATE TABLE IF NOT EXISTS cross_references (
  id                  BIGSERIAL PRIMARY KEY,
  source_regulation_id TEXT REFERENCES regulations(id) ON DELETE CASCADE,
  source_provision_id  TEXT,
  source_reference     TEXT,
  relation             TEXT NOT NULL,  -- REFERS_TO | READ_WITH | SUBJECT_TO | INCORPORATES
                                       -- AMENDS | SUPERSEDES | EXEMPTS | OVERRIDES | RELATED_TO
  target_regulation_id TEXT REFERENCES regulations(id) ON DELETE SET NULL,
  target_reference     TEXT,           -- kept as text when the target is not held
  resolved             BOOLEAN DEFAULT FALSE,
  source_text          TEXT,
  provenance_id        BIGINT REFERENCES provenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_xref_src ON cross_references(source_regulation_id);
CREATE INDEX IF NOT EXISTS idx_xref_tgt ON cross_references(target_regulation_id);

-- ---------------------------------------------------------------- amendments
-- Structured operations alongside the existing free-text amendment records.
ALTER TABLE regulation_amendments ADD COLUMN IF NOT EXISTS operation TEXT;      -- INSERT | DELETE | SUBSTITUTE | RENUMBER | REPLACE | ADD | REMOVE
ALTER TABLE regulation_amendments ADD COLUMN IF NOT EXISTS affected_provision_id TEXT;
ALTER TABLE regulation_amendments ADD COLUMN IF NOT EXISTS old_text TEXT;
ALTER TABLE regulation_amendments ADD COLUMN IF NOT EXISTS new_text TEXT;
ALTER TABLE regulation_amendments ADD COLUMN IF NOT EXISTS effective_date TEXT;
ALTER TABLE regulation_amendments ADD COLUMN IF NOT EXISTS provenance_id BIGINT
  REFERENCES provenance(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- analysis
-- AI interpretation lives HERE, never on the regulation itself, and is
-- PROPOSED until a human approves it.
CREATE TABLE IF NOT EXISTS regulatory_analysis (
  id             BIGSERIAL PRIMARY KEY,
  regulation_id  TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  provision_id   TEXT REFERENCES legal_provisions(id) ON DELETE CASCADE,
  analysis_type  TEXT NOT NULL,   -- INTENT | RISK | INTERPRETATION | AMBIGUITY | DEPENDENCY | RISK_CLASSIFICATION
  content        TEXT NOT NULL,
  confidence     DOUBLE PRECISION,
  produced_by    TEXT,            -- model id, or a person
  review_status  TEXT NOT NULL DEFAULT 'PROPOSED',   -- PROPOSED | APPROVED | REJECTED
  reviewed_by    TEXT,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT now()::text
);
CREATE INDEX IF NOT EXISTS idx_analysis_reg ON regulatory_analysis(regulation_id);
CREATE INDEX IF NOT EXISTS idx_analysis_status ON regulatory_analysis(review_status);
