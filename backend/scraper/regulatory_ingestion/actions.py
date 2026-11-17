"""
Actions / CAPA — what happens AFTER a proposal.

THE GAP THIS CLOSES
-------------------
Until now the chain stopped at "the engine proposed a mapping". There was no
owner, no due date, no closure and no evidence — so nothing recorded that a
regulatory change was actually dealt with. That is the half a regulator asks
about.

    regulation change -> impact proposed -> ACTION (owned, dated) -> evidence -> closed

LIFECYCLE
---------
    Proposed  -- accept -->  Open  -->  In Progress  -->  Done
        |                      |             |
        +-- reject --> Rejected|             +--> Blocked
                               +--> Cancelled

Two rules are enforced in code, not left to convention:

  1. An action created by the engine starts as Proposed. Only a human moves it
     to Open. The engine can never create work that is already accepted.
  2. Done requires a closure note, and for evidence-bearing actions an evidence
     record. "Marked done" with nothing behind it is how compliance theatre
     happens; the transition is refused instead.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

STATUSES = ["Proposed", "Open", "In Progress", "Blocked", "Done", "Rejected", "Cancelled"]

# Only these moves are legal. Anything else is refused with the reason, so an
# action cannot jump from Proposed straight to Done.
TRANSITIONS = {
    "Proposed":    {"Open", "Rejected"},
    "Open":        {"In Progress", "Blocked", "Cancelled", "Done"},
    "In Progress": {"Blocked", "Done", "Cancelled"},
    "Blocked":     {"In Progress", "Open", "Cancelled"},
    "Done":        set(),          # terminal — reopening means a new action
    "Rejected":    set(),
    "Cancelled":   set(),
}

EVIDENCE_REQUIRED = {"collect_evidence", "add_control"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS actions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT,
  action_type    TEXT,                    -- update_policy | change_process | add_control | collect_evidence | assess
  priority       TEXT DEFAULT 'P2',       -- P0 | P1 | P2
  status         TEXT NOT NULL DEFAULT 'Proposed',

  -- what it came from: every action is traceable to a regulation and a clause
  regulation_id  TEXT REFERENCES regulations(id) ON DELETE SET NULL,
  obligation_id  TEXT REFERENCES obligations(id) ON DELETE SET NULL,
  entity_id      TEXT REFERENCES company_entities(id) ON DELETE SET NULL,
  source         TEXT,                    -- impact-engine | matcher | manual
  source_run_id  INTEGER,

  owner_id       TEXT REFERENCES company_entities(id) ON DELETE SET NULL,
  due_date       TEXT,
  evidence_id    TEXT REFERENCES company_entities(id) ON DELETE SET NULL,
  closure_note   TEXT,

  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_reg    ON actions(regulation_id);
CREATE INDEX IF NOT EXISTS idx_actions_owner  ON actions(owner_id);
CREATE INDEX IF NOT EXISTS idx_actions_due    ON actions(due_date);

CREATE TABLE IF NOT EXISTS action_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id INTEGER NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT,
  note      TEXT, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aevents_action ON action_events(action_id);
"""


_READY = False


def init(con: sqlite3.Connection) -> sqlite3.Connection:
    """Once per process — a write on every call makes reads need the write lock."""
    global _READY
    if _READY:
        return con
    try:
        con.executescript(SCHEMA)
        con.commit()
        _READY = True
    except sqlite3.OperationalError:
        pass
    return con


class TransitionError(Exception):
    pass


def create(con, *, title: str, action_type: str = "assess", priority: str = "P2",
           regulation_id: str | None = None, obligation_id: str | None = None,
           entity_id: str | None = None, description: str = "",
           owner_id: str | None = None, due_date: str | None = None,
           source: str = "manual", source_run_id: int | None = None,
           created_by: str = "system", status: str = "Proposed") -> dict:
    init(con)
    if status not in STATUSES:
        raise ValueError(f"unknown status {status}")
    # The engine may only ever create Proposed work.
    if source != "manual" and status != "Proposed":
        raise TransitionError("engine-created actions must start as Proposed")
    for col, val, table in (("entity_id", entity_id, "company_entities"),
                            ("owner_id", owner_id, "company_entities"),
                            ("obligation_id", obligation_id, "obligations")):
        if val and not con.execute(f"SELECT 1 FROM {table} WHERE id=?", (val,)).fetchone():
            raise ValueError(f"{col} '{val}' does not exist in {table}")

    cur = con.execute(
        """INSERT INTO actions (title, description, action_type, priority, status,
             regulation_id, obligation_id, entity_id, source, source_run_id,
             owner_id, due_date, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (title, description, action_type, priority, status, regulation_id, obligation_id,
         entity_id, source, source_run_id, owner_id, due_date, created_by, _now(), _now()))
    aid = cur.lastrowid
    con.execute(
        "INSERT INTO action_events (action_id, from_status, to_status, note, actor, at) VALUES (?,?,?,?,?,?)",
        (aid, None, status, "created", created_by, _now()))
    con.commit()
    return get(con, aid)


def transition(con, aid: int, to: str, *, actor: str, note: str = "",
               evidence_id: str | None = None, owner_id: str | None = None,
               due_date: str | None = None) -> dict:
    """Move an action, enforcing the lifecycle and the closure requirements."""
    init(con)
    row = con.execute("SELECT * FROM actions WHERE id=?", (aid,)).fetchone()
    if not row:
        raise ValueError("no such action")
    cur_status = row["status"]
    if to not in STATUSES:
        raise ValueError(f"unknown status {to}")
    if to not in TRANSITIONS.get(cur_status, set()):
        raise TransitionError(
            f"cannot move {cur_status} -> {to}. Allowed: {sorted(TRANSITIONS.get(cur_status, set())) or 'none (terminal)'}")

    if to == "Done":
        if not (note or row["closure_note"]):
            raise TransitionError("closing requires a closure note saying what was actually done")
        if row["action_type"] in EVIDENCE_REQUIRED and not (evidence_id or row["evidence_id"]):
            raise TransitionError(
                f"'{row['action_type']}' cannot be closed without an evidence record — "
                "that is the artefact a regulator would ask for")
    if evidence_id and not con.execute(
            "SELECT 1 FROM company_entities WHERE id=?", (evidence_id,)).fetchone():
        raise ValueError(f"evidence_id '{evidence_id}' does not exist")
    if owner_id and not con.execute(
            "SELECT 1 FROM company_entities WHERE id=?", (owner_id,)).fetchone():
        raise ValueError(f"owner_id '{owner_id}' does not exist")

    sets = {"status": to, "updated_at": _now()}
    if note:
        sets["closure_note"] = note if to == "Done" else row["closure_note"]
    if evidence_id:
        sets["evidence_id"] = evidence_id
    if owner_id:
        sets["owner_id"] = owner_id
    if due_date:
        sets["due_date"] = due_date
    if to in ("Done", "Rejected", "Cancelled"):
        sets["closed_at"] = _now()

    con.execute(f"UPDATE actions SET {', '.join(f'{k}=?' for k in sets)} WHERE id=?",
                (*sets.values(), aid))
    con.execute(
        "INSERT INTO action_events (action_id, from_status, to_status, note, actor, at) VALUES (?,?,?,?,?,?)",
        (aid, cur_status, to, note, actor, _now()))
    con.commit()
    return get(con, aid)


def get(con, aid: int) -> dict | None:
    """
    Joins the same display names as listing(). Without them the detail view
    showed LESS than the row that opened it — owner and affected entity read as
    unassigned when they were in fact set.
    """
    init(con)
    r = con.execute(
        """SELECT a.*, r.title AS regulation_title, e.name AS entity_name,
                  o.name AS owner_name, ev.name AS evidence_name
           FROM actions a
           LEFT JOIN regulations r       ON r.id  = a.regulation_id
           LEFT JOIN company_entities e  ON e.id  = a.entity_id
           LEFT JOIN company_entities o  ON o.id  = a.owner_id
           LEFT JOIN company_entities ev ON ev.id = a.evidence_id
           WHERE a.id=?""", (aid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["events"] = [dict(e) for e in con.execute(
        "SELECT * FROM action_events WHERE action_id=? ORDER BY id", (aid,))]
    d["allowedTransitions"] = sorted(TRANSITIONS.get(d["status"], set()))
    return d


def listing(con, *, status: str | None = None, regulation_id: str | None = None,
            owner_id: str | None = None, overdue: bool = False, limit: int = 200) -> list[dict]:
    init(con)
    w, p = [], []
    if status:
        w.append("a.status = ?"); p.append(status)
    if regulation_id:
        w.append("a.regulation_id = ?"); p.append(regulation_id)
    if owner_id:
        w.append("a.owner_id = ?"); p.append(owner_id)
    if overdue:
        w.append("a.due_date IS NOT NULL AND a.due_date < date('now') AND a.status NOT IN ('Done','Rejected','Cancelled')")
    where = ("WHERE " + " AND ".join(w)) if w else ""
    rows = con.execute(
        f"""SELECT a.*, r.title AS regulation_title, e.name AS entity_name,
                   o.name AS owner_name, ev.name AS evidence_name
            FROM actions a
            LEFT JOIN regulations r      ON r.id  = a.regulation_id
            LEFT JOIN company_entities e ON e.id  = a.entity_id
            LEFT JOIN company_entities o ON o.id  = a.owner_id
            LEFT JOIN company_entities ev ON ev.id = a.evidence_id
            {where} ORDER BY
              CASE a.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
              a.due_date IS NULL, a.due_date, a.id DESC
            LIMIT ?""", (*p, limit)).fetchall()
    return [dict(r) for r in rows]


def stats(con) -> dict:
    init(con)
    by_status = dict(con.execute("SELECT status, COUNT(*) FROM actions GROUP BY 1").fetchall())
    return {
        "byStatus": by_status,
        "total": sum(by_status.values()),
        "open": sum(v for k, v in by_status.items() if k in ("Open", "In Progress", "Blocked")),
        "awaitingAcceptance": by_status.get("Proposed", 0),
        "overdue": con.execute(
            """SELECT COUNT(*) FROM actions WHERE due_date IS NOT NULL AND due_date < date('now')
               AND status NOT IN ('Done','Rejected','Cancelled')""").fetchone()[0],
        "unowned": con.execute(
            """SELECT COUNT(*) FROM actions WHERE owner_id IS NULL
               AND status NOT IN ('Done','Rejected','Cancelled')""").fetchone()[0],
    }


def from_impact_run(con, run_id: int, created_by: str = "impact-engine") -> dict:
    """
    Turn an impact run's proposed actions into tracked work — as Proposed, so a
    human still has to accept each one.
    """
    init(con)
    r = con.execute("SELECT payload, regulation_id FROM impact_runs WHERE id=?", (run_id,)).fetchone()
    if not r:
        raise ValueError("no such impact run")
    payload = json.loads(r["payload"])
    made, skipped = [], []
    for a in payload.get("actions", []) or []:
        try:
            made.append(create(
                con, title=a.get("title") or "Untitled action",
                description=a.get("rationale") or "",
                action_type=a.get("action_type") or "assess",
                priority=a.get("priority") or "P2",
                regulation_id=r["regulation_id"], entity_id=a.get("entity_id"),
                source="impact-engine", source_run_id=run_id, created_by=created_by)["id"])
        except Exception as e:
            skipped.append({"action": a.get("title"), "reason": str(e)[:160]})
    return {"created": made, "skipped": skipped,
            "note": "Created as Proposed. A human must accept each before it becomes work."}
