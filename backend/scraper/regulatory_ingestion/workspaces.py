"""
The companies on this installation and who may work in each.

ONE ADDRESS, ONE SIGN-IN
------------------------
Everybody signs in on the main installation (public.users / public.sessions).
The home company is the main installation's own data; every other company is a
workspace with its own schema and API process (deploy/tenancy/tenantctl.py).
The browser says which company it is working in with an X-Company header and
nginx sends the request to that company's API, after /api/auth/gate has checked
the session and the membership.

WHO MAY WORK IN A COMPANY
-------------------------
  home company   users.role ('none' = an account that works only elsewhere)
  workspace      an admin of the home company is admin everywhere (they add the
                 companies); anybody else needs a row in workspace_members

A workspace's own API never sees public.users. It reads company_members, a
view that shows each workspace role only its own members, and keeps a copy of
them in its own users table so owners, notifications and audit names work.
"""
from __future__ import annotations

import time

from . import auth as A
from . import tenancy

SCHEMA = """
CREATE TABLE IF NOT EXISTS workspace_requests (
  id            BIGSERIAL PRIMARY KEY,
  company_name  TEXT NOT NULL,
  slug          TEXT NOT NULL,
  sector        TEXT,
  contact_name  TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  message       TEXT,
  url           TEXT,
  setup_code    TEXT,
  requested_ip  TEXT,
  created_at    TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT,
  finished_at   TEXT
);
DROP INDEX IF EXISTS uq_workspace_requests_slug;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_requests_live_slug
  ON workspace_requests (slug) WHERE status NOT IN ('DECLINED', 'FAILED', 'REMOVED');
CREATE TABLE IF NOT EXISTS workspace_members (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug      TEXT NOT NULL,
  role      TEXT NOT NULL,
  added_by  TEXT,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE OR REPLACE VIEW company_members AS
  SELECT u.id, u.email, u.name,
         CASE WHEN u.role = 'admin' THEN 'admin' ELSE m.role END AS role
    FROM users u
    LEFT JOIN workspace_members m ON m.user_id = u.id AND m.slug = substr(current_user::text, 4)
   WHERE u.active = 1 AND left(current_user::text, 3) = 'cb_'
     AND (u.role = 'admin' OR m.user_id IS NOT NULL);
"""
_ready = False


def init(con):
    global _ready
    if not _ready:
        A.init(con)
        con.executescript(SCHEMA)
        con.execute("ALTER TABLE workspace_requests ALTER COLUMN contact_name SET DEFAULT ''")
        con.execute("ALTER TABLE workspace_requests ALTER COLUMN contact_email SET DEFAULT ''")
        con.commit()
        _ready = True
    return con


def home_name(con) -> str:
    try:
        r = con.execute("SELECT legal_name FROM company_profile WHERE coalesce(legal_name, '') <> '' LIMIT 1").fetchone()
        return r[0] if r else "Main company"
    except Exception:                                                   # noqa: BLE001
        con.rollback()
        return "Main company"


def ready(con, slug: str):
    return con.execute("SELECT slug, company_name, sector FROM workspace_requests WHERE slug = ? AND status = 'READY'",
                       (slug,)).fetchone()


def company_role(con, user: dict | None, slug: str) -> str | None:
    """The user's role in one company ('' = home), or None when they may not work there."""
    if not user:
        return None
    if not slug:
        return user["role"] if user["role"] != A.NO_ACCESS else None
    init(con)
    if not ready(con, slug):
        return None
    if user["role"] == "admin":
        return "admin"
    r = con.execute("SELECT role FROM workspace_members WHERE user_id = ? AND slug = ?", (user["id"], slug)).fetchone()
    return r[0] if r else None


def companies_for(con, user: dict) -> list[dict]:
    """Every company this user may switch to, home first."""
    init(con)
    out = []
    if user["role"] != A.NO_ACCESS:
        out.append({"slug": "", "name": home_name(con), "role": user["role"]})
    if user["role"] == "admin":
        rows = con.execute("""SELECT slug, company_name, sector, 'admin' AS role FROM workspace_requests
                               WHERE status = 'READY' ORDER BY company_name""").fetchall()
    else:
        rows = con.execute("""SELECT w.slug, w.company_name, w.sector, m.role FROM workspace_requests w
                                JOIN workspace_members m ON m.slug = w.slug AND m.user_id = ?
                               WHERE w.status = 'READY' ORDER BY w.company_name""", (user["id"],)).fetchall()
    out += [{"slug": r["slug"], "name": r["company_name"], "sector": r["sector"], "role": r["role"]} for r in rows]
    return out


# ---------------------------------------------------------------- members (main installation)
def members(con, slug: str) -> list[dict]:
    init(con)
    rows = con.execute("""SELECT u.*, CASE WHEN u.role = 'admin' THEN 'admin' ELSE m.role END AS company_role,
                                 m.added_at
                            FROM users u LEFT JOIN workspace_members m ON m.user_id = u.id AND m.slug = ?
                           WHERE u.role = 'admin' OR m.user_id IS NOT NULL
                           ORDER BY (u.role = 'admin') DESC, u.name""", (slug,)).fetchall()
    out = []
    for r in rows:
        d = A._public(r)
        d["platformAdmin"] = d["role"] == "admin"
        d["role"] = d.pop("company_role")
        d.pop("added_at", None)
        out.append(d)
    return out


def set_member(con, user_id: str, slug: str, role: str, by: str) -> None:
    if role not in A.ASSIGNABLE_ROLES:
        raise ValueError(f"role must be one of {A.ASSIGNABLE_ROLES}")
    init(con)
    con.execute("""INSERT INTO workspace_members (user_id, slug, role, added_by, added_at) VALUES (?,?,?,?,?)
                   ON CONFLICT (user_id, slug) DO UPDATE SET role = excluded.role""",
                (user_id, slug, role, by, A._iso(A._now())))
    con.commit()


def remove_member(con, user_id: str, slug: str) -> None:
    init(con)
    con.execute("DELETE FROM workspace_members WHERE user_id = ? AND slug = ?", (user_id, slug))
    con.commit()


# ---------------------------------------------------------------- inside a workspace
_synced = 0.0
SYNC_SECONDS = 15


def sync_members(con, force: bool = False) -> None:
    """Copy this workspace's members (public.company_members) into its own users table."""
    global _synced
    if not force and time.monotonic() - _synced < SYNC_SECONDS:
        return
    rows = con.execute("SELECT id, email, name, role FROM public.company_members").fetchall()
    keep = set()
    for r in rows:
        keep.add(r["id"])
        # an earlier local account with the same email gives way to the shared one
        con.execute("UPDATE users SET email = id || '@replaced.invalid', active = 0 WHERE email = ? AND id <> ?",
                    (r["email"], r["id"]))
        con.execute("""INSERT INTO users (id, email, name, role, password_hash, password_salt, active, created_at)
                       VALUES (?,?,?,?,'!','',1,?)
                       ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name,
                                                      role = excluded.role, active = 1""",
                    (r["id"], r["email"], r["name"], r["role"], A._iso(A._now())))
    for (uid,) in con.execute("SELECT id FROM users WHERE active = 1").fetchall():
        if uid not in keep:
            con.execute("UPDATE users SET active = 0 WHERE id = ?", (uid,))
    con.commit()
    _synced = time.monotonic()


def member_here(con, user_id: str) -> dict | None:
    """The signed-in user as this workspace knows them, or None when not a member."""
    if not tenancy.current():
        return None
    A.init(con)
    sync_members(con)
    row = con.execute("SELECT * FROM users WHERE id = ? AND active = 1", (user_id,)).fetchone()
    if not row:
        sync_members(con, force=True)                                   # just added, or just removed
        row = con.execute("SELECT * FROM users WHERE id = ? AND active = 1", (user_id,)).fetchone()
    return A._public(row) if row else None
