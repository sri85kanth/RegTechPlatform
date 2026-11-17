-- Rollback for 005_risk_intake.sql. Drops the Phase 2 risk tables and their rows.
-- Take a database backup first: confirmed facts, attestations and approved
-- appetite versions are records of human decisions and cannot be recreated.
DROP TABLE IF EXISTS fact_citations;
DROP TABLE IF EXISTS extracted_facts;
DROP TABLE IF EXISTS risk_governors;
DROP TABLE IF EXISTS risk_appetite;
DROP TABLE IF EXISTS history_attestations;
DROP TABLE IF EXISTS history_records;
DROP TABLE IF EXISTS company_third_parties;
DROP TABLE IF EXISTS company_licences;
DROP TABLE IF EXISTS company_sites;
