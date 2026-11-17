"""
Accountability edges — HODs, delegates and approvers.

WHY RELATIONSHIPS, NOT COLUMNS
------------------------------
"Who is accountable?" is rarely one person. A policy has an owner AND an
approver; a department has a head AND someone covering while they are on leave.
Modelling those as columns forces a single answer and cannot express "acting
for" at all.

So they are typed edges in entity_relationships, which means they also show up
in the graph and propagate through impact analysis — the same machinery that
already answers "what does this regulation touch" can now answer "and who has to
sign it off".

    heads         Person   -> Department / Team
    delegate_for  Person   -> Person            (acting for, optionally dated)
    approves      Person   -> Policy / Control / Evidence
    owns          Person   -> anything          (mirrors owner_id, for the graph)

DELEGATION IS TIME-BOUNDED
--------------------------
A delegate who never expires is just a second owner, and quietly becomes the
real one. Delegations carry from/until dates and are reported as expired rather
than silently continuing to route approvals.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import date, datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

TYPES = {
    "heads": ("Person", ("Department", "Team")),
    "delegate_for": ("Person", ("Person",)),
    "approves": ("Person", None),      # None = any target
    "owns": ("Person", None),
}

SCHEMA = """
-- Delegations need dates and a reason, which a bare edge cannot carry.
CREATE TABLE IF NOT EXISTS delegations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_person TEXT NOT NULL REFERENCES company_entities(id) ON DELETE CASCADE,
  to_person   TEXT NOT NULL REFERENCES company_entities(id) ON DELETE CASCADE,
  scope       TEXT,                   -- entity id this covers, or NULL for all
  reason      TEXT,
  valid_from  TEXT NOT NULL,
  valid_until TEXT,                   -- NULL = open-ended, flagged as a risk
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_deleg_from ON delegations(from_person);
CREATE INDEX IF NOT EXISTS idx_deleg_to   ON delegations(to_person);
"""


_READY = False


def init(con: sqlite3.Connection) -> sqlite3.Connection:
    """Once per process — see documents.init() for why this matters."""
    global _READY
    if _READY:
        return con
    try:
        # Fail fast rather than waiting out the busy timeout on every call.
        con.execute("PRAGMA busy_timeout=500")
        con.executescript(SCHEMA)
        con.commit()
        _READY = True
    except sqlite3.OperationalError:
        pass          # delegations table pending; edge queries below still work
    finally:
        con.execute("PRAGMA busy_timeout=30000")
    return con


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _people_index(con) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = {}
    for r in con.execute(
            "SELECT id, name FROM company_entities WHERE type IN ('Person','External Person')"):
        idx.setdefault(_norm(r[1]), []).append(r[0])
    return idx


def add_edge(con, source_id: str, rel_type: str, target_id: str, *, actor: str = "system") -> bool:
    """Insert a typed accountability edge, refusing anything that would not make sense."""
    if rel_type not in TYPES:
        raise ValueError(f"unknown relationship type '{rel_type}'")
    src = con.execute("SELECT id,type FROM company_entities WHERE id=?", (source_id,)).fetchone()
    tgt = con.execute("SELECT id,type FROM company_entities WHERE id=?", (target_id,)).fetchone()
    if not src or not tgt:
        raise ValueError("both source and target must exist")
    want_src, want_tgt = TYPES[rel_type]
    if want_src and src["type"] not in (want_src, "External Person"):
        raise ValueError(f"'{rel_type}' source must be a {want_src}, not {src['type']}")
    if want_tgt and tgt["type"] not in want_tgt:
        raise ValueError(f"'{rel_type}' target must be one of {want_tgt}, not {tgt['type']}")
    if source_id == target_id:
        raise ValueError("an entity cannot be accountable to itself")

    exists = con.execute(
        "SELECT 1 FROM entity_relationships WHERE source_id=? AND type=? AND target_id=?",
        (source_id, rel_type, target_id)).fetchone()
    if exists:
        return False
    con.execute(
        "INSERT INTO entity_relationships (id, source_id, type, target_id) VALUES (?,?,?,?)",
        (f"rel-{rel_type}-{source_id}-{target_id}"[:120], source_id, rel_type, target_id))
    con.execute(
        "INSERT INTO audit_events (entity_id, action, actor, detail, at) VALUES (?,?,?,?,?)",
        (target_id, f"accountability: {rel_type}", actor, f"{source_id} {rel_type} {target_id}", _now()))
    con.commit()
    return True


def derive(con: sqlite3.Connection, *, apply: bool = False) -> dict:
    """
    Build `owns` and `approves` edges from data already present.

    Same conservative rule as owner resolution: exactly one matching person, or
    it is reported and skipped. A wrong approver is worse than a missing one.
    """
    init(con)
    people = _people_index(con)
    made = {"owns": 0, "approves": 0, "heads": 0}
    skipped: list[dict] = []

    # owns — mirror the resolved owner_id into the graph
    for r in con.execute(
            "SELECT id, owner_id FROM company_entities WHERE owner_id IS NOT NULL AND owner_id != ''"):
        owner = con.execute("SELECT type FROM company_entities WHERE id=?", (r["owner_id"],)).fetchone()
        if not owner or owner["type"] not in ("Person", "External Person"):
            continue    # a department can own something, but 'owns' here models a person
        if apply and add_edge(con, r["owner_id"], "owns", r["id"], actor="derive"):
            made["owns"] += 1
        elif not apply:
            made["owns"] += 1

    # approves — from an approvedBy attribute
    for r in con.execute("SELECT id, name, attrs FROM company_entities WHERE attrs IS NOT NULL"):
        try:
            a = json.loads(r["attrs"] or "{}")
        except Exception:
            continue
        raw = next((a[k] for k in ("approvedBy", "approver", "approved_by") if a.get(k)), None)
        if not isinstance(raw, str) or not raw.strip():
            continue
        hits = people.get(_norm(raw), [])
        if len(hits) != 1:
            skipped.append({"entity": r["id"], "approver": raw,
                            "reason": "no single matching person" if not hits else "ambiguous name"})
            continue
        if apply and add_edge(con, hits[0], "approves", r["id"], actor="derive"):
            made["approves"] += 1
        elif not apply:
            made["approves"] += 1

    # heads — a person whose owner link points at a Department they own
    for r in con.execute(
            """SELECT e.id AS dept, e.owner_id FROM company_entities e
               WHERE e.type IN ('Department','Team') AND e.owner_id IS NOT NULL"""):
        owner = con.execute("SELECT type FROM company_entities WHERE id=?", (r["owner_id"],)).fetchone()
        if not owner or owner["type"] != "Person":
            continue
        if apply and add_edge(con, r["owner_id"], "heads", r["dept"], actor="derive"):
            made["heads"] += 1
        elif not apply:
            made["heads"] += 1

    return {"applied": apply, "created": made, "total": sum(made.values()),
            "skipped": len(skipped), "skippedDetail": skipped[:10]}


# ---------------------------------------------------------------- delegation
def delegate(con, *, from_person: str, to_person: str, valid_from: str | None = None,
             valid_until: str | None = None, scope: str | None = None,
             reason: str = "", created_by: str = "system") -> dict:
    init(con)
    for pid in (from_person, to_person):
        if not con.execute("SELECT 1 FROM company_entities WHERE id=?", (pid,)).fetchone():
            raise ValueError(f"person '{pid}' does not exist")
    if from_person == to_person:
        raise ValueError("cannot delegate to the same person")
    cur = con.execute(
        """INSERT INTO delegations (from_person,to_person,scope,reason,valid_from,valid_until,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (from_person, to_person, scope, reason,
         valid_from or date.today().isoformat(), valid_until, created_by, _now()))
    add_edge(con, to_person, "delegate_for", from_person, actor=created_by)
    con.commit()
    return get_delegation(con, cur.lastrowid)


def get_delegation(con, did: int) -> dict | None:
    r = con.execute(
        """SELECT d.*, f.name AS from_name, t.name AS to_name
           FROM delegations d
           LEFT JOIN company_entities f ON f.id = d.from_person
           LEFT JOIN company_entities t ON t.id = d.to_person
           WHERE d.id=?""", (did,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["status"] = _delegation_status(d)
    return d


def _delegation_status(d: dict) -> str:
    if d.get("revoked_at"):
        return "revoked"
    today = date.today().isoformat()
    if d.get("valid_from") and d["valid_from"] > today:
        return "pending"
    if d.get("valid_until") and d["valid_until"] < today:
        return "expired"
    if not d.get("valid_until"):
        # Called out deliberately: an open-ended delegation is indistinguishable
        # from a permanent transfer of accountability.
        return "active_open_ended"
    return "active"


def delegations(con, *, person: str | None = None, active_only: bool = False) -> list[dict]:
    init(con)
    rows = con.execute(
        """SELECT d.*, f.name AS from_name, t.name AS to_name
           FROM delegations d
           LEFT JOIN company_entities f ON f.id = d.from_person
           LEFT JOIN company_entities t ON t.id = d.to_person
           WHERE (?::text IS NULL OR d.from_person = ? OR d.to_person = ?)
           ORDER BY d.id DESC""", (person, person, person)).fetchall()
    out = [dict(r, status=_delegation_status(dict(r))) for r in rows]
    if active_only:
        out = [d for d in out if d["status"].startswith("active")]
    return out


def revoke(con, did: int, actor: str = "system") -> dict:
    init(con)
    con.execute("UPDATE delegations SET revoked_at=? WHERE id=?", (_now(), did))
    d = get_delegation(con, did)
    if d:
        con.execute("DELETE FROM entity_relationships WHERE source_id=? AND type='delegate_for' AND target_id=?",
                    (d["to_person"], d["from_person"]))
    con.commit()
    return d or {"revoked": did}


def coverage(con) -> dict:
    init(con)
    # ANY(array) instead of IN (?,?,?): Postgres cannot infer the type of a bare
    # placeholder list, and this also avoids rebuilding the SQL per call.
    counts = dict(con.execute(
        "SELECT type, COUNT(*) FROM entity_relationships WHERE type = ANY(%s::text[]) GROUP BY 1",
        (list(TYPES),)).fetchall())
    try:
        dels = delegations(con)
    except sqlite3.OperationalError:
        dels = []      # table not created yet — report zero, not an error page
    return {
        "edges": counts,
        "delegations": {
            "total": len(dels),
            "active": sum(1 for d in dels if d["status"].startswith("active")),
            "openEnded": sum(1 for d in dels if d["status"] == "active_open_ended"),
            "expired": sum(1 for d in dels if d["status"] == "expired"),
        },
        "departmentsWithHead": con.execute(
            """SELECT COUNT(DISTINCT target_id) FROM entity_relationships WHERE type='heads'""").fetchone()[0],
        "departmentsTotal": con.execute(
            "SELECT COUNT(*) FROM company_entities WHERE type IN ('Department','Team')").fetchone()[0],
    }
