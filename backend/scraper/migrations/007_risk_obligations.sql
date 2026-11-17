-- =====================================================================
-- 007 · Risk module, Phase 4 (lens 1): obligations in the risk register
-- =====================================================================
--
-- Design: scraper/docs/risk-module-design.md §4.1, §14.3, §15.
--
-- Every requirement that applies to the company becomes an obligation exposure
-- in risk_exposures (kind 'obligation', regulation_id, requirement_id — stable
-- keys, no foreign key to company_requirement_instances). One risk per theme.
-- No new columns are needed for that; this migration adds only:
--
--   risk_theme_assignments   a person's choice of theme for a regulation the
--                            rulebook's mapping cannot place (gate G3). It wins
--                            over the mapping on the next run.
--
-- Additive only. Rollback: 007_risk_obligations_rollback.sql.
-- =====================================================================

CREATE TABLE IF NOT EXISTS risk_theme_assignments (
  regulation_id  TEXT PRIMARY KEY,
  theme          TEXT NOT NULL,
  note           TEXT,
  set_by         TEXT NOT NULL,
  set_at         TEXT NOT NULL
);
