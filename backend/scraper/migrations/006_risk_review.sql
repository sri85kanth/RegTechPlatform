-- =====================================================================
-- 006 · Risk module, Phase 3: the register, its assessments, and the people
--       who review, override and treat them
-- =====================================================================
--
-- Design: scraper/docs/risk-module-design.md §7 (gates G3–G9), §8, §14.
--
--   risks                  one row per identified risk; group_key keeps a rebuild
--                          from creating it twice
--   risk_exposures         what a risk is made of (a template on a graph node, an
--                          obligation at a site); a person's applicability call
--                          (G3) is kept beside the engine's
--   risk_assessments       append-only engine output; a new row only when the
--                          inputs hash changes; superseded_at closes the old one
--   risk_org_facts         answers to the questions that decide whether a library
--                          template applies ("do you develop software?"), G9
--   risk_control_ratings   what a person recorded about a risk's controls;
--                          CLAIMED on a HIGH risk waits for validation (G4)
--   review_tasks           the queue: every gate opens one, routed to a person or
--                          a role, with a due date; closes itself when the
--                          condition goes away
--   risk_overrides         a person's value beside the computed one (G7); a lower
--                          value needs a second approver; STALE when inputs change
--   treatment_decisions    accept / avoid / mitigate / transfer / escalate (G6),
--                          always by a named person, linked to actions
--   rulebook_publications  a rulebook version, its dry-run diff and its two
--                          approvers (G8)
--   risk_events            append-only history of each risk
--
-- Keys on regulation / requirement ids are stable text, never foreign keys to
-- company_requirement_instances (rebuilt by materialise_cri; design §1.6 #1).
-- Every id is TEXT from the application; JSON is TEXT. Additive only.
-- Rollback: 006_risk_review_rollback.sql.
-- =====================================================================

CREATE TABLE IF NOT EXISTS risks (
  id            TEXT PRIMARY KEY,
  group_key     TEXT NOT NULL UNIQUE,    -- template:<id>@<site|org>, custom:<id>, obligation:<theme>@<site>
  title         TEXT NOT NULL,
  theme         TEXT,
  site_id       TEXT,
  template_id   TEXT,
  origin        TEXT NOT NULL CHECK (origin IN ('derived','imported','manual')),
  lifecycle     TEXT NOT NULL DEFAULT 'IDENTIFIED'
                  CHECK (lifecycle IN ('IDENTIFIED','ASSESSED','IN_TREATMENT','ACCEPTED','CLOSED','RETIRED')),
  owner_user    TEXT,
  owner_name    TEXT,
  description   TEXT,
  impact_basis  TEXT,                    -- JSON, custom risks: {seeds: {dimension: 1..5}, base_likelihood}
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  retired_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_risks_lifecycle ON risks(lifecycle);

CREATE TABLE IF NOT EXISTS risk_exposures (
  id                    TEXT PRIMARY KEY,
  risk_id               TEXT NOT NULL REFERENCES risks(id),
  exposure_key          TEXT NOT NULL,   -- the engine's exposure id, stable across rebuilds
  kind                  TEXT NOT NULL CHECK (kind IN ('obligation','template','event')),
  label                 TEXT,
  node_ref              TEXT,            -- graph node (org, SITE-…, TP-…, entity id)
  site_id               TEXT,
  regulation_id         TEXT,
  requirement_id        TEXT,
  engine_applicability  TEXT,            -- what the rules said on the last rebuild
  missing               TEXT,            -- JSON: the facts that left it undecided
  decided_applicability TEXT CHECK (decided_applicability IS NULL OR decided_applicability IN ('APPLICABLE','NOT_APPLICABLE')),
  decision_reason       TEXT,
  decided_by            TEXT,
  decided_at            TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  UNIQUE (risk_id, exposure_key)
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id              TEXT PRIMARY KEY,
  risk_id         TEXT NOT NULL REFERENCES risks(id),
  seq             INTEGER NOT NULL,
  rulebook        TEXT NOT NULL,
  rulebook_hash   TEXT NOT NULL,
  inputs_hash     TEXT NOT NULL,
  as_of           TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  inherent_band   TEXT,
  residual_band   TEXT,
  target_band     TEXT,
  confidence      INTEGER,
  provisional     INTEGER NOT NULL DEFAULT 0,
  result          TEXT NOT NULL,         -- JSON: the engine's whole assessment (derivation, rationale, …)
  inputs          TEXT NOT NULL,         -- JSON: the snapshot it was computed from
  diff            TEXT,                  -- JSON: before → after against the previous version
  trigger         TEXT,
  recorded_at     TEXT NOT NULL,
  superseded_at   TEXT,
  UNIQUE (risk_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_assess_current ON risk_assessments(risk_id, superseded_at);

CREATE TABLE IF NOT EXISTS risk_org_facts (
  fact_key   TEXT PRIMARY KEY,           -- develops_software, remote_work, …
  value      TEXT NOT NULL,              -- JSON
  note       TEXT,
  set_by     TEXT NOT NULL,
  set_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_control_ratings (
  id              TEXT PRIMARY KEY,
  risk_id         TEXT NOT NULL REFERENCES risks(id),
  control_key     TEXT NOT NULL,         -- tc-<n> for a template's typical control, or c-<hex> for one a person named
  label           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'preventive' CHECK (kind IN ('preventive','detective','corrective')),
  grade           TEXT NOT NULL CHECK (grade IN ('ABSENT','CLAIMED','DOCUMENTED','TESTED')),
  evidence        TEXT,                  -- what shows it: a document name, link or evidence id
  evidence_on     TEXT,                  -- date of the newest test, or of the document review
  interval_days   INTEGER,
  note            TEXT,
  source          TEXT NOT NULL DEFAULT 'person',  -- person, workbook, control:<id>, entity:<id> (mapped from the company's own records)
  rated_by        TEXT NOT NULL,
  rated_by_user   TEXT,
  validated_by    TEXT,                  -- G4: who upgraded or rejected a claim
  recorded_at     TEXT NOT NULL,
  superseded_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ratings_risk ON risk_control_ratings(risk_id, superseded_at);

CREATE TABLE IF NOT EXISTS review_tasks (
  id             TEXT PRIMARY KEY,
  gate           TEXT NOT NULL CHECK (gate IN ('G3','G4','G5','G6','G7','G8','G9')),
  reason_code    TEXT NOT NULL,
  reason         TEXT NOT NULL,          -- in words, for logs and mail
  detail         TEXT,                   -- JSON: the same facts, structured, for the screen to word in each language
  risk_id        TEXT,
  subject_kind   TEXT NOT NULL,          -- risk, exposure, control, override, rulebook
  subject_id     TEXT NOT NULL,
  assignee_user  TEXT,
  assignee_role  TEXT,                   -- compliance_manager, governor, admin, owner
  priority       TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2')),
  due_at         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CANCELLED')),
  decision       TEXT,
  note           TEXT,
  decided_by     TEXT,
  decided_at     TEXT,
  created_by     TEXT NOT NULL,          -- engine, or the person
  created_at     TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON review_tasks(status, gate);

CREATE TABLE IF NOT EXISTS risk_overrides (
  id                  TEXT PRIMARY KEY,
  risk_id             TEXT NOT NULL REFERENCES risks(id),
  assessment_id       TEXT NOT NULL,
  inputs_hash         TEXT NOT NULL,     -- the inputs it was made against: a change makes it STALE
  field               TEXT NOT NULL CHECK (field IN ('residual_band','verdict')),
  computed_value      TEXT NOT NULL,
  override_value      TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('raise','lower')),
  reason              TEXT NOT NULL,
  evidence            TEXT,
  proposed_by         TEXT NOT NULL,
  proposed_by_user    TEXT,
  second_by           TEXT,
  second_by_user      TEXT,
  status              TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','REJECTED','STALE','REVOKED')),
  note                TEXT,
  created_at          TEXT NOT NULL,
  decided_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_overrides_risk ON risk_overrides(risk_id, status);

CREATE TABLE IF NOT EXISTS treatment_decisions (
  id                  TEXT PRIMARY KEY,
  risk_id             TEXT NOT NULL REFERENCES risks(id),
  assessment_id       TEXT NOT NULL,
  decision            TEXT NOT NULL CHECK (decision IN ('ACCEPT','AVOID','MITIGATE','TRANSFER','ESCALATE')),
  rationale           TEXT NOT NULL,
  decided_by          TEXT NOT NULL,
  decided_by_user     TEXT,
  decider_name        TEXT NOT NULL,     -- a named person, always
  decider_designation TEXT NOT NULL,
  accept_until        TEXT,              -- ACCEPT: when it must be looked at again
  transfer_to         TEXT,              -- TRANSFER: the insurer or party
  instrument          TEXT,              -- TRANSFER: the policy or contract
  action_ids          TEXT,              -- JSON list: MITIGATE's actions
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED','EXPIRED')),
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_treatment_risk ON treatment_decisions(risk_id, status);

CREATE TABLE IF NOT EXISTS rulebook_publications (
  id                 TEXT PRIMARY KEY,
  rulebook           TEXT NOT NULL,
  version            TEXT NOT NULL,
  rulebook_hash      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('PENDING','PUBLISHED','REJECTED','SUPERSEDED')),
  diff               TEXT,               -- JSON: verdicts that change, top movers
  requested_by       TEXT NOT NULL,
  admin_by           TEXT,
  admin_by_user      TEXT,
  governor_by        TEXT,
  governor_by_user   TEXT,
  note               TEXT,
  created_at         TEXT NOT NULL,
  decided_at         TEXT
);

CREATE TABLE IF NOT EXISTS risk_events (
  id        TEXT PRIMARY KEY,
  risk_id   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  actor     TEXT NOT NULL,
  detail    TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_events ON risk_events(risk_id, at);
