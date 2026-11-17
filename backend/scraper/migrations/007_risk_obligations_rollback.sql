-- Rollback for 007_risk_obligations.sql. Obligation risks fall back to the rulebook's theme mapping.
DROP TABLE IF EXISTS risk_theme_assignments;
