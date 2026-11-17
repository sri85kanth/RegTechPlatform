-- Rollback for 006_risk_review.sql. Drops the Phase 3 risk tables and everything in them.
DROP TABLE IF EXISTS risk_events;
DROP TABLE IF EXISTS rulebook_publications;
DROP TABLE IF EXISTS treatment_decisions;
DROP TABLE IF EXISTS risk_overrides;
DROP TABLE IF EXISTS review_tasks;
DROP TABLE IF EXISTS risk_control_ratings;
DROP TABLE IF EXISTS risk_org_facts;
DROP TABLE IF EXISTS risk_assessments;
DROP TABLE IF EXISTS risk_exposures;
DROP TABLE IF EXISTS risks;
