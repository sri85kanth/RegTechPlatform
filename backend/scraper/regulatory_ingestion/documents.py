"""
Company documents — the artefacts a regulator actually asks to see.

THE GAP THIS CLOSES
-------------------
Files collected by the folder integration became entities with a `file` attr and
nothing else. `company_documents` stayed empty, so there was no answer to
"show me the approved KYC policy, its version, who approved it, and when" —
which is the first question in any inspection.

DOCUMENT TYPE IS NOT FILE FORMAT
--------------------------------
A PDF can be a policy, a procedure, a board minute or an audit report, and the
regulatory weight of each is completely different. Type is inferred from the
name and the domain it was filed under, never from the extension — and where it
cannot be determined it is recorded as Unclassified rather than guessed.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# Document types that matter in a compliance file, with the words that signal them.
TYPES = {
    "Policy":        ["policy", "policies", "charter"],
    "Procedure":     ["procedure", "sop", "manual", "guideline", "workflow"],
    "Control Evidence": ["evidence", "test", "attestation", "certificate", "sign-off", "signoff"],
    "Register":      ["register", "log", "inventory", "extract", "listing"],
    "Report":        ["report", "review", "assessment", "audit", "findings"],
    "Minutes":       ["minutes", "board", "committee", "meeting"],
    "Agreement":     ["agreement", "contract", "mou", "nda", "sla"],
    "Filing":        ["filing", "return", "submission", "disclosure"],
}

DOMAIN_DEFAULT = {
    "policies": "Policy", "processes": "Procedure", "controls": "Control Evidence",
    "evidence": "Control Evidence", "risks": "Report",
}

SCHEMA_EXTRA = [
    ("document_type", "TEXT"),
    ("version", "TEXT"),
    ("approved_by", "TEXT"),
    ("approved_on", "TEXT"),
    ("source", "TEXT"),
    ("source_reference", "TEXT"),
    ("storage_path", "TEXT"),
    ("content_hash", "TEXT"),
]


class SchemaPending(RuntimeError):
    """Raised when a needed migration cannot run because the database is busy."""


_READY = False


def init(con: sqlite3.Connection) -> sqlite3.Connection:
    """Once per process — an ALTER TABLE on every call makes reads need a write lock."""
    global _READY
    if _READY:
        return con
    try:
        # Fail fast. This migration genuinely needs the write lock, so if another
        # process holds it we want a quick, honest error — not a request that
        # hangs for 30s and then times out with no explanation.
        con.execute("PRAGMA busy_timeout=500")
        _init_schema(con)
        _READY = True
    except sqlite3.OperationalError as e:
        raise SchemaPending(
            "The company_documents migration has not run yet and the database is "
            "currently locked by another process. Retry once it completes."
        ) from e
    finally:
        con.execute("PRAGMA busy_timeout=30000")
    return con


def _init_schema(con: sqlite3.Connection) -> sqlite3.Connection:
    con.executescript("""
    CREATE TABLE IF NOT EXISTS company_documents (
      id TEXT PRIMARY KEY, name TEXT, kind TEXT, size INTEGER,
      linked_entity_id TEXT, status TEXT, uploaded_at TEXT);
    """)
    have = {r[1] for r in con.execute("PRAGMA table_info(company_documents)")}
    for col, ddl in SCHEMA_EXTRA:
        if col not in have:
            con.execute(f"ALTER TABLE company_documents ADD COLUMN {col} {ddl}")
    con.executescript(
        "CREATE INDEX IF NOT EXISTS idx_cdocs_entity ON company_documents(linked_entity_id);"
        "CREATE INDEX IF NOT EXISTS idx_cdocs_type ON company_documents(document_type);")
    con.commit()
    return con


def classify(name: str, domain: str | None = None) -> tuple[str, str]:
    """Returns (document_type, why). Never guesses silently."""
    low = re.sub(r"[^a-z0-9]+", " ", (name or "").lower())
    for t, words in TYPES.items():
        for w in words:
            if w in low:
                return t, f"filename contains '{w}'"
    if domain and domain in DOMAIN_DEFAULT:
        return DOMAIN_DEFAULT[domain], f"filed under the '{domain}' domain"
    return "Unclassified", "no type signal in the name or domain"


def _version_of(name: str) -> str | None:
    m = re.search(r"\bv(?:er(?:sion)?)?[\s._-]?(\d+(?:\.\d+)*)\b", name or "", re.I)
    return m.group(1) if m else None


def sync_from_entities(con: sqlite3.Connection, *, apply: bool = True) -> dict:
    """
    Promote entities carrying a file attribute into real document records.

    Idempotent: keyed on the source reference, so re-running an integration does
    not create a second row for the same file.
    """
    init(con)
    made = updated = 0
    by_type: dict[str, int] = {}
    unclassified: list[str] = []

    for e in con.execute(
            """SELECT id, name, domain, attrs, source, source_reference
               FROM company_entities WHERE attrs IS NOT NULL"""):
        try:
            a = json.loads(e["attrs"] or "{}")
        except Exception:
            continue
        path = a.get("file")
        if not path:
            continue

        dtype, why = classify(e["name"] or path, e["domain"])
        by_type[dtype] = by_type.get(dtype, 0) + 1
        if dtype == "Unclassified":
            unclassified.append(e["name"])

        doc_id = f"cdoc-{re.sub(r'[^a-z0-9]+', '-', str(path).lower()).strip('-')}"[:120]
        if not apply:
            made += 1
            continue

        exists = con.execute("SELECT 1 FROM company_documents WHERE id=?", (doc_id,)).fetchone()
        con.execute(
            """INSERT INTO company_documents
               (id,name,kind,size,linked_entity_id,status,uploaded_at,document_type,
                version,approved_by,approved_on,source,source_reference,storage_path)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name, size=excluded.size,
                 linked_entity_id=excluded.linked_entity_id,
                 document_type=excluded.document_type,
                 version=COALESCE(excluded.version, company_documents.version),
                 approved_by=COALESCE(excluded.approved_by, company_documents.approved_by)""",
            (doc_id, e["name"], a.get("format") or "file", a.get("bytes"),
             e["id"], "Collected", _now(), dtype,
             _version_of(e["name"] or "") or a.get("version"),
             a.get("approvedBy") or a.get("approver"), a.get("approvedOn"),
             e["source"], e["source_reference"], str(path)))
        made += 0 if exists else 1
        updated += 1 if exists else 0
    con.commit()
    return {"applied": apply, "created": made, "updated": updated,
            "byType": by_type, "unclassified": unclassified[:10],
            "note": "Type is inferred from the document's name and domain, not its file "
                    "extension — a PDF may be a policy, a register or board minutes."}


def listing(con, *, document_type: str | None = None, entity_id: str | None = None) -> list[dict]:
    init(con)
    w, p = [], []
    if document_type:
        w.append("d.document_type = ?"); p.append(document_type)
    if entity_id:
        w.append("d.linked_entity_id = ?"); p.append(entity_id)
    where = ("WHERE " + " AND ".join(w)) if w else ""
    return [dict(r) for r in con.execute(
        f"""SELECT d.*, e.name AS entity_name, e.domain AS entity_domain
            FROM company_documents d
            LEFT JOIN company_entities e ON e.id = d.linked_entity_id
            {where} ORDER BY d.document_type, d.name""", p)]


def stats(con) -> dict:
    init(con)
    by_type = dict(con.execute(
        "SELECT COALESCE(document_type,'Unclassified'), COUNT(*) FROM company_documents GROUP BY 1").fetchall())
    return {
        "total": sum(by_type.values()), "byType": by_type,
        "unlinked": con.execute(
            "SELECT COUNT(*) FROM company_documents WHERE linked_entity_id IS NULL").fetchone()[0],
        "withoutVersion": con.execute(
            "SELECT COUNT(*) FROM company_documents WHERE version IS NULL").fetchone()[0],
        "withoutApprover": con.execute(
            "SELECT COUNT(*) FROM company_documents WHERE approved_by IS NULL").fetchone()[0],
    }
