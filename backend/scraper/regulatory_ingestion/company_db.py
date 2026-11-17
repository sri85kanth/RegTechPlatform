"""
Company Brain persistence — the half of the graph that was previously only
seed data in the frontend. Everything the onboarding screens collect lands
here, so it survives a refresh and the matcher can read it.

Same SQLite file as the regulatory side, so a mapping is a plain join rather
than a cross-store lookup.
"""
import json
import sqlite3
from datetime import datetime, timezone

from .db import connect

SCHEMA = """
CREATE TABLE IF NOT EXISTS company_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name TEXT, registration_no TEXT, entity_type TEXT, incorporated TEXT,
  hq_state TEXT, jurisdictions TEXT, sectors TEXT, licences TEXT,
  employees TEXT, turnover_cr TEXT, customers TEXT,
  listed INTEGER DEFAULT 0, handles_personal_data INTEGER DEFAULT 0,
  imports_exports INTEGER DEFAULT 0, updated_at TEXT,
  -- 0 until a person confirms it. A profile derived from uploaded documents is
  -- a proposal: applicability for the whole corpus is computed against these
  -- fields, so "nobody has checked this yet" has to be visible in the row.
  source_verified INTEGER DEFAULT 0,
  derived_from TEXT                    -- {field: {file, evidence}} when derived
);

CREATE TABLE IF NOT EXISTS company_entities (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  description TEXT,
  owner_id TEXT,
  criticality TEXT,
  lifecycle TEXT,
  status TEXT,
  verification TEXT,
  attrs TEXT,
  source TEXT,
  source_reference TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ce_domain ON company_entities(domain);

CREATE TABLE IF NOT EXISTS entity_relationships (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  confidence INTEGER DEFAULT 100,
  status TEXT DEFAULT 'Pending',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_er_src ON entity_relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_er_tgt ON entity_relationships(target_id);

CREATE TABLE IF NOT EXISTS company_mappings (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_domain TEXT,
  status TEXT DEFAULT 'Proposed',
  confidence INTEGER,
  reason TEXT,
  source TEXT,
  created_by TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  rationale TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cm_obl ON company_mappings(obligation_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT, action TEXT, actor TEXT, detail TEXT, at TEXT
);

CREATE TABLE IF NOT EXISTS company_documents (
  id TEXT PRIMARY KEY,
  name TEXT, kind TEXT, size INTEGER, linked_entity_id TEXT,
  status TEXT DEFAULT 'Queued', uploaded_at TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


_SCHEMA_READY = False


# (table, column, ddl) for anything added to SCHEMA after the first release.
ADDED_COLUMNS = [
    ("company_profile", "source_verified", "INTEGER DEFAULT 0"),
    ("company_profile", "derived_from", "TEXT"),
    # The legal form is the register's answer ("Private Limited Company") and
    # is kept apart from entity_type, which says what kind of organisation it
    # is ("Hospital — multispecialty") — the answer applicability runs on.
    ("company_profile", "legal_form", "TEXT"),
    ("company_profile", "registered_address", "TEXT"),
    ("company_profile", "lei", "TEXT"),
    ("company_profile", "public_record", "TEXT"),   # {source, record, lastUpdated, values}
    # Quantitative facts a threshold check evaluates against. turnover_cr and
    # employees already exist; bed count is the one healthcare thresholds ("≥100
    # beds", "non-bedded facility") turn on, so it becomes a first-class fact.
    ("company_profile", "beds", "INTEGER"),
    # Which node of the company's OWN structure this record belongs to. The
    # `domain` column stays — it is what an entity IS (a person, a policy) —
    # while this is where the company FILES it. The eleven domains are the same
    # for every company; the structure is not.
    ("company_entities", "org_node_id", "TEXT"),
]


def init(con: sqlite3.Connection | None = None) -> sqlite3.Connection:
    """
    Ensure the company tables exist, ONCE per process.

    executescript() is a write. Running it on every call meant every request
    needed the database write lock, so a long-running reader (the RAG indexer)
    could stall the whole API. The tables already exist in any live deployment,
    so a busy database is not a reason to refuse a connection.
    """
    global _SCHEMA_READY
    con = con or connect()
    if _SCHEMA_READY:
        return con
    try:
        have = con.execute(
            """SELECT COUNT(*) FROM information_schema.tables
               WHERE table_schema='public' AND table_name='company_entities'"""
        ).fetchone()[0]
        if not have:
            try:
                con.executescript(SCHEMA)
                con.commit()
            except Exception:
                # Two first requests can reach this at the same moment on a new
                # install. CREATE TABLE IF NOT EXISTS is not concurrency-safe in
                # PostgreSQL: the loser raises a duplicate-object error although
                # the table it wanted now exists. Either way the schema is there.
                con.rollback()
        # Columns added after a deployment already exists. executescript above
        # only runs on a fresh install, and CREATE TABLE IF NOT EXISTS no-ops
        # on a table that is already there — so a column declared in SCHEMA but
        # never ALTERed in is a column that silently does not exist. That has
        # already cost one debugging session on the `evidence` table.
        for table, col, ddl in ADDED_COLUMNS:
            con.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {ddl}")
        con.commit()
        _SCHEMA_READY = True
    except sqlite3.OperationalError:
        pass          # busy right now; the caller still gets a usable connection
    return con


def log(con, entity_id: str, action: str, detail: str = "", actor: str = "system") -> None:
    con.execute(
        "INSERT INTO audit_events (entity_id,action,actor,detail,at) VALUES (?,?,?,?,?)",
        (entity_id, action, actor, detail, now()),
    )


def upsert_entity(con, e: dict, actor: str = "onboarding") -> None:
    con.execute(
        """INSERT INTO company_entities
           (id,domain,name,type,description,owner_id,criticality,lifecycle,status,
            verification,attrs,source,source_reference,org_node_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, type=excluded.type, description=excluded.description,
             -- COALESCE, not overwrite: an incoming record with no owner must not
             -- erase a link a human or the resolver established. A re-sync that
             -- silently wipes ownership is worse than one that adds nothing.
             -- Table-qualified, not bare: inside ON CONFLICT DO UPDATE a bare
             -- column is ambiguous between the target row and excluded, and
             -- PostgreSQL refuses the statement. That broke every collection
             -- which touched a record already present.
             owner_id=COALESCE(excluded.owner_id, company_entities.owner_id),
             criticality=COALESCE(excluded.criticality, company_entities.criticality),
             lifecycle=excluded.lifecycle, status=excluded.status,
             verification=excluded.verification, attrs=excluded.attrs,
             source=excluded.source, source_reference=excluded.source_reference,
             -- COALESCE for the same reason as owner_id: a re-collection that
             -- happens to carry no context must not unfile a record somebody
             -- has already placed.
             org_node_id=COALESCE(excluded.org_node_id, company_entities.org_node_id),
             updated_at=excluded.updated_at""",
        (
            e["id"], e["domain"], e["name"], e.get("type"), e.get("description"),
            e.get("ownerId"), e.get("criticality"), e.get("lifecycle", "Discovered"),
            e.get("status", "Active"), e.get("verification", "Pending"),
            json.dumps(e.get("attrs") or {}),
            # accept either the nested provenance{} shape or flat source keys,
            # so an importer that uses column names cannot silently lose provenance
            (e.get("provenance") or {}).get("source") or e.get("source") or "Manual",
            (e.get("provenance") or {}).get("sourceReference") or e.get("source_reference") or "",
            e.get("orgNodeId") or e.get("org_node_id"),
            now(), now(),
        ),
    )
    log(con, e["id"], "entity upserted", e["name"], actor)


def add_relationship(con, r: dict) -> None:
    con.execute(
        """INSERT INTO entity_relationships
           (id,source_id,type,target_id,confidence,status,created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (r["id"], r["sourceId"], r["type"], r["targetId"],
         r.get("confidence", 100), r.get("status", "Pending"), now()),
    )


def entity_rows(con) -> list[dict]:
    out = []
    for r in con.execute("SELECT * FROM company_entities ORDER BY rowid DESC"):
        d = dict(r)
        d["attrs"] = json.loads(d.get("attrs") or "{}")
        out.append(d)
    return out


AMENDMENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS regulation_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regulation_id TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  section_number TEXT,
  section_title TEXT,
  action TEXT,
  meaning TEXT,
  instrument TEXT,
  reference TEXT,
  amended_on TEXT,
  context TEXT,
  raw TEXT,
  UNIQUE (regulation_id, section_number, reference, action)
);
CREATE INDEX IF NOT EXISTS idx_amd_reg  ON regulation_amendments(regulation_id);
CREATE INDEX IF NOT EXISTS idx_amd_date ON regulation_amendments(amended_on);
"""


def init_amendments(con):
    con.executescript(AMENDMENTS_SCHEMA)
    con.commit()
    return con
