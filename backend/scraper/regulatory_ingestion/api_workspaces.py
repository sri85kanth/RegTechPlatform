"""
Companies on this installation: the admin's "Add new company" and the list
behind the company switcher (workspaces.py has who may work in each).

HOW A NEW COMPANY COMES TO EXIST
--------------------------------
  APPROVED   an admin of the home company adds it here
  CREATING   deploy/tenancy/tenantctl.py process (a root timer) claims it
  READY      its database schema and API process exist and nginx routes to it;
             it appears in everybody's switcher who may work there
  FAILED     the message says why

The API never creates a workspace itself: it runs as an unprivileged user and
creating one needs a Linux user, a service and an nginx route. It only records
the decision; the root timer acts on it.

Only the main installation serves this. A company workspace answers 404, so
one company's admin can never add another company.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from . import tenancy
from . import workspaces as W
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")  # noqa: E731

# sector names as the regulation library uses them, so applicability can match
SECTORS = ["Healthcare & Hospitals", "Banking", "NBFC", "Insurance", "Payments",
           "Securities / Capital Markets", "Telecom", "Food", "Other"]
# names that would confuse in logs, schemas and service names
RESERVED = {"www", "api", "app", "admin", "mail", "smtp", "ftp", "static", "assets", "auth", "login",
            "status", "help", "support", "docs", "demo", "test", "staging", "premier", "aems", "brain",
            "public", "none", "home"}


def _main_only() -> None:
    if tenancy.current():
        raise HTTPException(404, "not found")


def _con():
    return W.init(connect())


def _slug_problem(con, slug: str) -> str | None:
    if not tenancy.valid_slug(slug):
        return "2–24 lowercase letters or digits, starting with a letter"
    if slug in RESERVED:
        return "that name is reserved"
    if con.execute("SELECT 1 FROM pg_namespace WHERE nspname = ?", (tenancy.schema_of(slug),)).fetchone():
        return "a company with that short name already exists"
    if con.execute("SELECT 1 FROM workspace_requests WHERE slug = ? AND status NOT IN ('DECLINED','FAILED','REMOVED')",
                   (slug,)).fetchone():
        return "a company with that short name already exists"
    return None


@router.get("/options")
def options(_: dict = Depends(require("administer"))):
    _main_only()
    return {"sectors": SECTORS}


@router.get("/slug-check")
def slug_check(slug: str = Query("", max_length=40), _: dict = Depends(require("administer"))):
    _main_only()
    problem = _slug_problem(_con(), slug.strip().lower())
    return {"available": problem is None, "reason": problem}


@router.get("/companies")
def list_companies(_: dict = Depends(require("administer"))):
    _main_only()
    con = _con()
    rows = [dict(r) for r in con.execute(
        """SELECT w.id, w.company_name, w.slug, w.sector, w.status, w.message, w.created_at, w.decided_by,
                  w.finished_at, (SELECT COUNT(*) FROM workspace_members m WHERE m.slug = w.slug) AS members
             FROM workspace_requests w
            WHERE w.status NOT IN ('DECLINED', 'REMOVED')
            ORDER BY (w.status IN ('APPROVED','CREATING')) DESC, w.company_name LIMIT 500""")]
    team = con.execute("""SELECT count(*) FILTER (WHERE role <> 'none') AS home_team,
                                 count(*) FILTER (WHERE role = 'admin') AS admins
                            FROM users WHERE active = 1""").fetchone()
    # admins of the main company work in every company, so they count in each team
    return {"home": W.home_name(con), "home_team": team["home_team"], "admins": team["admins"], "items": rows}


def _free_slug(con, name: str) -> str:
    """A short name made from the company name, numbered when it is taken."""
    words = re.sub(r"\b(pvt|private|ltd|limited|llp|inc|the|and|co|company)\b", " ", name.lower())
    base = re.sub(r"[^a-z0-9]", "", words).lstrip("0123456789")[:20] or "company"
    if len(base) < 2:
        base = f"co{base}"
    for n in range(1, 100):
        slug = base if n == 1 else f"{base[:20]}{n}"
        if _slug_problem(con, slug) is None:
            return slug
    raise HTTPException(409, "could not find a free short name — give one")


@router.post("/companies")
def add_company(payload: dict[str, Any] = Body(...), user: dict | None = Depends(require("administer"))):
    """
    Add a company. The root timer creates it within a minute. The short name is
    made from the company name when none is given; the sector is the company's
    main sector from Company Setup (the full profile is saved into the company
    once it exists).
    """
    _main_only()
    name = " ".join(str(payload.get("company_name", "")).split())[:120]
    sector = " ".join(str(payload.get("sector", "")).split())[:80]
    if len(name) < 2:
        raise HTTPException(400, "enter the company name")
    if not sector:
        raise HTTPException(400, "choose a sector")
    con = _con()
    slug = str(payload.get("slug", "")).strip().lower() or _free_slug(con, name)
    problem = _slug_problem(con, slug)
    if problem:
        raise HTTPException(400, f"short name: {problem}")
    who = (user or {}).get("email", "admin")
    row = con.execute("""INSERT INTO workspace_requests
                           (company_name, slug, sector, status, message, created_at, decided_by, decided_at)
                         VALUES (?,?,?,'APPROVED','Setting up — this takes about a minute.',?,?,?) RETURNING id""",
                      (name, slug, sector, _now(), who, _now())).fetchone()
    con.execute("INSERT INTO audit_events (entity_id, action, actor, detail, at) VALUES (?,?,?,?,?)",
                (f"company-{slug}", "company added", who, json.dumps({"name": name, "sector": sector}), _now()))
    con.commit()
    return {"id": row[0], "slug": slug, "status": "APPROVED"}


@router.post("/companies/{cid}/delete")
def delete_company(cid: int, payload: dict[str, Any] = Body(...), user: dict | None = Depends(require("administer"))):
    """
    Delete a company and ALL its data. The root timer does it within a minute.
    The company's name must be typed back, so a slip of the mouse cannot do it;
    the main company is not in this list and cannot be deleted here.
    """
    _main_only()
    con = _con()
    r = con.execute("SELECT slug, company_name, status FROM workspace_requests WHERE id = ?", (cid,)).fetchone()
    if not r or r["status"] in ("REMOVED", "DECLINED"):
        raise HTTPException(404, "no such company")
    if r["status"] not in ("READY", "FAILED"):
        raise HTTPException(409, f"this company is {r['status'].lower()} — try again in a minute")
    typed = " ".join(str(payload.get("confirm_name", "")).split()).lower()
    if typed != " ".join(r["company_name"].split()).lower():
        raise HTTPException(400, "type the company's name exactly to confirm")
    who = (user or {}).get("email", "admin")
    con.execute("UPDATE workspace_requests SET status = 'DELETING', message = 'Deleting — this takes about a minute.' WHERE id = ?",
                (cid,))
    con.execute("INSERT INTO audit_events (entity_id, action, actor, detail, at) VALUES (?,?,?,?,?)",
                (f"company-{r['slug']}", "company deleted", who, json.dumps({"name": r["company_name"]}), _now()))
    con.commit()
    return {"id": cid, "status": "DELETING"}
