"""
Notifications — telling someone when something actually happened.

THE GAP THIS CLOSES
-------------------
A regulation could change at 2am and nobody would learn of it. Detection and
tracked work are worthless if the signal never reaches a person.

EVERY NOTIFICATION IS DERIVED FROM A REAL EVENT
-----------------------------------------------
Nothing here is scheduled "engagement". A row exists only because a source check
found a change, an action passed its due date, work was assigned, or a proposal
is waiting on a human. If none of those happened, the list is empty — and an
empty list is the correct answer, not a reason to invent something.

ROUTING
-------
Notifications target a ROLE or a specific user. Role-targeted ones are visible
to everyone with that role or above, so "a regulation changed" reaches whoever
is on duty rather than one named person who may have left.

DEDUPLICATION
-------------
Each notification carries a dedupe_key. Re-running the generator does not
produce a second copy of the same fact — an inbox that repeats itself gets
ignored, and an ignored inbox is the same as no inbox.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

SEVERITIES = ["info", "warning", "critical"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,        -- source_changed | action_overdue | action_assigned | awaiting_review
  severity    TEXT NOT NULL DEFAULT 'info',
  title       TEXT NOT NULL,
  body        TEXT,

  -- routing: one of these is set
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT,                 -- minimum role that should see it

  -- what it is about, so the UI can link straight there
  regulation_id TEXT,
  action_id     INTEGER,
  entity_id     TEXT,
  link          TEXT,

  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  dismissed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_role ON notifications(role);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(read_at);
"""

RANK = {"viewer": 0, "reviewer": 1, "compliance_manager": 2, "admin": 3}


_READY = False


def init(con: sqlite3.Connection) -> sqlite3.Connection:
    """Once per process — a write on every call makes reads need the write lock."""
    global _READY
    if _READY:
        return con
    try:
        con.executescript(SCHEMA)
        # CREATE TABLE IF NOT EXISTS skips the WHOLE statement on an existing
        # table, constraints included. This table predates the UNIQUE on
        # dedupe_key, so the declaration above silently never applied and every
        # scheduled generate() re-delivered alerts that had already been sent.
        # Retrofit it explicitly, after collapsing whatever the gap let in.
        con.execute("""DELETE FROM notifications a USING notifications b
                        WHERE a.dedupe_key = b.dedupe_key AND a.id > b.id""")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe "
                    "ON notifications(dedupe_key)")
        con.commit()
        _READY = True
    except sqlite3.OperationalError:
        pass
    return con


def push(con, *, kind: str, title: str, dedupe_key: str, body: str = "",
         severity: str = "info", role: str | None = None, user_id: str | None = None,
         regulation_id: str | None = None, action_id: int | None = None,
         entity_id: str | None = None, link: str | None = None) -> bool:
    """Insert unless this exact fact was already delivered. Returns True if new."""
    init(con)
    cur = con.execute(
        """INSERT OR IGNORE INTO notifications
           (kind, severity, title, body, user_id, role, regulation_id, action_id,
            entity_id, link, dedupe_key, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (kind, severity if severity in SEVERITIES else "info", title, body, user_id, role,
         regulation_id, action_id, entity_id, link, dedupe_key, _now()))
    con.commit()
    return cur.rowcount > 0


def for_user(con, user: dict, *, unread_only: bool = False, limit: int = 50,
             with_regulation: bool = False) -> list[dict]:
    """Everything addressed to this user directly, or to a role they hold.

    with_regulation adds what the inbox shows about the regulation a notification
    is about: its full title, its regulator, and whether it applies to this
    company. Without it the inbox would have to ask for each regulation in turn
    just to set apart changes in regulations that do not apply.
    """
    init(con)
    rank = RANK.get(user.get("role", "viewer"), 0)
    visible_roles = [r for r, n in RANK.items() if n <= rank]
    reg_cols = reg_join = ""
    if with_regulation:
        reg_cols = (", r.title AS regulation_title, r.regulator_short AS regulator_short,"
                    " r.applicability AS regulation_applicability")
        reg_join = "LEFT JOIN regulations r ON r.id = n.regulation_id"
    q = f"""SELECT n.*{reg_cols} FROM notifications n {reg_join}
            WHERE n.dismissed_at IS NULL
              AND (n.user_id = ? OR (n.user_id IS NULL AND n.role IN ({','.join('?' * len(visible_roles))})))
              {'AND n.read_at IS NULL' if unread_only else ''}
            ORDER BY
              CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
              n.id DESC
            LIMIT ?"""
    return [dict(r) for r in con.execute(q, (user["id"], *visible_roles, limit))]


def unread_count(con, user: dict) -> int:
    return len(for_user(con, user, unread_only=True, limit=500))


def mark_read(con, user: dict, ids: list[int] | None = None) -> int:
    init(con)
    mine = {n["id"] for n in for_user(con, user, limit=1000)}
    targets = [i for i in (ids or list(mine)) if i in mine]   # never touch someone else's
    if not targets:
        return 0
    con.executemany("UPDATE notifications SET read_at=? WHERE id=? AND read_at IS NULL",
                    [(_now(), i) for i in targets])
    con.commit()
    return len(targets)


def dismiss(con, user: dict, nid: int) -> bool:
    mine = {n["id"] for n in for_user(con, user, limit=1000)}
    if nid not in mine:
        return False
    con.execute("UPDATE notifications SET dismissed_at=? WHERE id=?", (_now(), nid))
    con.commit()
    return True


# ---------------------------------------------------------------- generation
def _owner_alerts(con, rid: str, change_key: str, summary: str, reg_name: str) -> int:
    """
    Walk change -> impact_relationships -> entity -> owner and tell each owner
    which of THEIR records this regulation's change touches. Addressed to the
    owner's user account when one is linked (users.person_id), otherwise to the
    reviewer role with the owner named in the title — never silently dropped.
    """
    owners: dict[str, dict] = {}
    for r in con.execute(
            """SELECT own.id AS owner_id, own.name AS owner_name, ce.name AS entity_name
               FROM impact_relationships ir
               JOIN company_entities ce  ON ce.id = ir.company_brain_entity_id
               JOIN company_entities own ON own.id = ce.owner_id
               WHERE ir.regulation_id=?""", (rid,)):
        o = owners.setdefault(r["owner_id"], {"name": r["owner_name"], "entities": set()})
        o["entities"].add(r["entity_name"])
    made = 0
    for oid, o in owners.items():
        u = con.execute("SELECT id FROM users WHERE person_id=? AND active=1", (oid,)).fetchone()
        names = sorted(o["entities"])
        shown = ", ".join(names[:5]) + (f" and {len(names) - 5} more" if len(names) > 5 else "")
        made += push(
            con, kind="owner_impact", severity="critical",
            title=f"{o['name']}: {len(names)} of your record(s) affected — {reg_name[:70]}",
            body=f"{summary} Affected: {shown}.",
            user_id=u["id"] if u else None,
            role=None if u else "reviewer",
            regulation_id=rid, link=f"/regulation/{rid}",
            dedupe_key=f"owner_impact:{change_key}:{oid}")
    return made


def generate(con) -> dict:
    """
    Derive notifications from current state. Idempotent — safe to run on a
    schedule, and produces nothing when nothing has happened.
    """
    init(con)
    made = {"source_changed": 0, "owner_impact": 0, "action_overdue": 0, "awaiting_review": 0, "action_assigned": 0}

    # 1. a source check that found a real change.
    #    CHANGED means two versions were compared section by section.
    #    CHANGED_UNVERIFIED means the bytes moved but the new copy could not be
    #    read — worth telling a reviewer about, but not at the same severity and
    #    never under a headline that claims we know what changed. A first
    #    capture (BASELINE_CAPTURED) is deliberately excluded: nothing changed.
    for r in con.execute(
            """SELECT s.id, s.regulation_id, s.checked_at, s.note, s.changes_found,
                      s.outcome, r.title
               FROM source_checks s LEFT JOIN regulations r ON r.id = s.regulation_id
               WHERE s.outcome IN ('CHANGED','CHANGED_UNVERIFIED')
               ORDER BY s.id DESC LIMIT 100"""):
        verified = r["outcome"] == "CHANGED"
        name = (r["title"] or r["regulation_id"])[:80]
        if push(con, kind="source_changed",
                severity="critical" if verified else "warning",
                title=(f"Source changed: {name}" if verified
                       else f"Source changed, content unreadable: {name}"),
                body=r["note"] or "The official document differs from the stored copy.",
                role="reviewer", regulation_id=r["regulation_id"],
                link=f"/regulation/{r['regulation_id']}",
                dedupe_key=f"source_changed:{r['id']}"):
            made["source_changed"] += 1
        if verified:
            made["owner_impact"] += _owner_alerts(
                con, r["regulation_id"], f"check:{r['id']}",
                f"The official source of this regulation changed on {str(r['checked_at'])[:10]}.",
                r["title"] or r["regulation_id"])

    # 1b. a computed section-level diff, whatever route produced it.
    #     Rule 1 only fires on a source check, so a comparison performed any
    #     other way — a backfilled prior version, a manual re-ingest — reached
    #     the screen but never reached a person. Keyed on the version pair, so
    #     re-running the comparison does not re-alert. NUMBERING_ONLY sections
    #     are excluded from the count: renumbering is not something to action.
    for r in con.execute(
            """SELECT c.regulation_id, c.from_version, c.to_version, r.title,
                      COUNT(*) FILTER (WHERE c.change_class = 'WORDING') AS wording,
                      COUNT(*) AS total
                 FROM section_changes c
                 LEFT JOIN regulations r ON r.id = c.regulation_id
                GROUP BY c.regulation_id, c.from_version, c.to_version, r.title
               HAVING COUNT(*) FILTER (WHERE c.change_class = 'WORDING') > 0"""):
        name = (r["title"] or r["regulation_id"])[:80]
        renum = r["total"] - r["wording"]
        if push(con, kind="source_changed", severity="critical",
                title=f"{r['wording']} section(s) changed: {name}",
                body=(f"A word-level comparison of two captured versions found {r['wording']} "
                      f"section(s) with changed wording"
                      + (f" and {renum} renumbered only." if renum else ".")),
                role="reviewer", regulation_id=r["regulation_id"],
                link=f"/regulation/{r['regulation_id']}",
                dedupe_key=f"section_changes:{r['regulation_id']}:{r['from_version']}:{r['to_version']}"):
            made["source_changed"] += 1
        made["owner_impact"] += _owner_alerts(
            con, r["regulation_id"],
            f"sections:{r['from_version']}:{r['to_version']}",
            f"{r['wording']} section(s) changed wording between two captured versions.",
            r["title"] or r["regulation_id"])

    # 2. work that has slipped its date
    for a in con.execute(
            """SELECT a.id, a.title, a.due_date, a.owner_id, u.id AS user_id
               FROM actions a
               LEFT JOIN users u ON u.person_id = a.owner_id
               WHERE a.due_date IS NOT NULL AND a.due_date < date('now')
                 AND a.status NOT IN ('Done','Rejected','Cancelled')"""):
        if push(con, kind="action_overdue", severity="warning",
                title=f"Overdue: {a['title'][:80]}",
                body=f"Due {a['due_date']} and still open.",
                user_id=a["user_id"], role=None if a["user_id"] else "compliance_manager",
                action_id=a["id"], link="/actions",
                # keyed by date so it re-notifies each day it stays overdue,
                # but only once per day
                dedupe_key=f"action_overdue:{a['id']}:{datetime.now(timezone.utc).date()}"):
            made["action_overdue"] += 1

    # 3. proposals waiting on a human
    n = con.execute("SELECT COUNT(*) FROM actions WHERE status='Proposed'").fetchone()[0]
    if n:
        if push(con, kind="awaiting_review", severity="info",
                title=f"{n} proposed action{'s' if n != 1 else ''} awaiting acceptance",
                body="The engine proposed these. Nothing becomes work until a human accepts it.",
                role="compliance_manager", link="/actions",
                dedupe_key=f"awaiting_review:{datetime.now(timezone.utc).date()}:{n}"):
            made["awaiting_review"] += 1

    # 4. work assigned to a person who has an account
    for a in con.execute(
            """SELECT a.id, a.title, u.id AS user_id FROM actions a
               JOIN users u ON u.person_id = a.owner_id
               WHERE a.status IN ('Open','In Progress')"""):
        if push(con, kind="action_assigned", severity="info",
                title=f"Assigned to you: {a['title'][:80]}",
                user_id=a["user_id"], action_id=a["id"], link="/actions",
                dedupe_key=f"action_assigned:{a['id']}:{a['user_id']}"):
            made["action_assigned"] += 1

    return {"created": made, "total": sum(made.values()), "at": _now()}
