"""SQLite storage for the Regulatory Intelligence Engine (spec §6-§8, §38)."""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "output" / "PostgreSQL (company_brain)"

SCHEMA = """
CREATE TABLE IF NOT EXISTS regulations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, short_title TEXT,
  regulator TEXT, regulator_short TEXT, regulation_type TEXT, reference_number TEXT,
  jurisdiction TEXT DEFAULT 'India', sector TEXT, sub_sector TEXT, ministry TEXT,
  issued_on TEXT, effective_from TEXT, last_updated TEXT, current_version TEXT,
  status TEXT DEFAULT 'Active', impact_level TEXT, impact_score INTEGER,
  applicability TEXT,
  source_url TEXT, official_document_url TEXT,
  document_id TEXT, ingestion_status TEXT DEFAULT 'DISCOVERED',
  source_verified INTEGER DEFAULT 0, verified_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, regulation_id TEXT REFERENCES regulations(id),
  file_name TEXT, file_type TEXT, file_size INTEGER, storage_path TEXT,
  source_url TEXT, document_hash TEXT, page_count INTEGER,
  extraction_method TEXT, ocr_used INTEGER DEFAULT 0, extraction_status TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY, regulation_id TEXT REFERENCES regulations(id),
  section_number TEXT, section_title TEXT, section_text TEXT,
  chars INTEGER, parent_section_id TEXT
);
CREATE TABLE IF NOT EXISTS clauses (
  id TEXT PRIMARY KEY, section_id TEXT REFERENCES sections(id),
  clause_number TEXT, clause_text TEXT, page_number INTEGER
);
CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY, regulation_id TEXT, section_id TEXT, clause_id TEXT,
  title TEXT, description TEXT, obligation_type TEXT,
  mandatory_action TEXT, responsible_entity TEXT, frequency TEXT,
  applicability TEXT, evidence_required TEXT,
  source_reference TEXT, confidence REAL, extraction_method TEXT,
  verified INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS applicability_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, regulation_id TEXT,
  entity_type TEXT, applicability TEXT, applicability_rule TEXT,
  source_clause TEXT, confidence REAL
);
CREATE TABLE IF NOT EXISTS impact_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT, regulation_id TEXT, obligation_id TEXT,
  company_brain_entity_id TEXT NOT NULL, entity_name TEXT, entity_domain TEXT,
  relationship_type TEXT, match_reason TEXT, match_signals TEXT,
  confidence REAL, regulation_clause_id TEXT, source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS impact_scores (
  regulation_id TEXT PRIMARY KEY, score INTEGER, level TEXT, factors TEXT,
  computed_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS verification_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, regulation_id TEXT,
  field TEXT, value TEXT, source_document TEXT, page TEXT, section TEXT, clause TEXT,
  extraction_method TEXT, confidence REAL, verified INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS regulation_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, regulation_id TEXT, version_number TEXT,
  published_on TEXT, effective_from TEXT, change_type TEXT, change_summary TEXT,
  previous_version_id INTEGER, document_id TEXT
);
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, regulation_id TEXT, step TEXT,
  status TEXT, detail TEXT, at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sections_reg ON sections(regulation_id);
CREATE INDEX IF NOT EXISTS idx_obl_reg ON obligations(regulation_id);
CREATE INDEX IF NOT EXISTS idx_imp_reg ON impact_relationships(regulation_id);
"""


_SCHEMA_READY = False


def connect():
    """
    Connect to PostgreSQL.

    The store moved off SQLite: several processes write concurrently, the impact
    graph is 200k+ rows, and the retrieval index was already in Postgres. The
    returned object is sqlite3.Connection-shaped (see pgdb.py) so existing call
    sites keep working, and `?` placeholders are translated for you.

    Set COMPANY_BRAIN_DSN to point at a different database.
    """
    from .pgdb import connect as _pg
    return _pg()


def sqlite_legacy_path():
    """The pre-migration SQLite file, kept only as a fallback reference."""
    return DB_PATH
