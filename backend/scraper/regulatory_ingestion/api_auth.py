"""
Authentication endpoints and the dependency other routers use to require a user.

ENFORCEMENT IS CONDITIONAL BY DESIGN
------------------------------------
Until the first user exists the API stays open, so shipping this does not lock
an existing deployment out of its own data. The moment an admin is created,
enforcement turns on everywhere. /api/auth/status always states which mode is
active — a security posture nobody can see is one nobody can trust.

ONE SIGN-IN FOR EVERY COMPANY (workspaces.py)
---------------------------------------------
Sign-in, sessions and the users list live on the main installation. A company
workspace has no sign-in of its own: nginx asks /api/auth/gate whether the
session may work in the company named by X-Company, and passes the user's id
on with a secret only nginx and the workspaces know (CB_GATE_SECRET).
"""
import hmac
import os
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Response

from . import auth as A
from . import workspaces as W
from .db import connect

router = APIRouter(prefix="/api/auth", tags=["auth"])
TENANT = os.environ.get("CB_TENANT", "")


def _bearer(authorization: str | None) -> str:
    if not authorization:
        return ""
    return authorization[7:].strip() if authorization.lower().startswith("bearer ") else authorization.strip()


def _gated_user(gate: str | None, company: str | None, uid: str | None) -> dict | None:
    """Inside a workspace: the user nginx vouched for, if they are a member here."""
    secret = os.environ.get("CB_GATE_SECRET", "")
    if not (secret and uid and company == TENANT and hmac.compare_digest(gate or "", secret)):
        return None
    return W.member_here(connect(), uid)


def current_user(authorization: str | None = Header(default=None), x_cb_gate: str | None = Header(default=None),
                 x_company: str | None = Header(default=None),
                 x_cb_user_id: str | None = Header(default=None)) -> dict | None:
    """Resolves the caller, or None when unauthenticated."""
    if TENANT:
        return _gated_user(x_cb_gate, x_company, x_cb_user_id)
    return A.resolve(connect(), _bearer(authorization))


def _check(user: dict | None, capability: str) -> dict:
    if not user:
        raise HTTPException(401, "authentication required")
    if not A.can(user, capability):
        raise HTTPException(
            403, f"your role '{user['role']}' cannot '{capability}' "
                 f"(requires '{A.CAPABILITIES[capability]}' or higher)")
    return user


def _require_home(authorization: str | None, capability: str) -> dict | None:
    con = connect()
    st = A.status(con)
    user = A.resolve(con, _bearer(authorization))
    if not st["enforcing"]:
        return user               # open mode — no users configured yet
    return _check(user, capability)


def require(capability: str):
    """
    Dependency factory. While no users exist the API is open; once one does,
    the capability is enforced. Inside a workspace it is always enforced.
    """
    def dep(authorization: str | None = Header(default=None), x_cb_gate: str | None = Header(default=None),
            x_company: str | None = Header(default=None),
            x_cb_user_id: str | None = Header(default=None)) -> dict | None:
        if TENANT:
            return _check(_gated_user(x_cb_gate, x_company, x_cb_user_id), capability)
        return _require_home(authorization, capability)
    return dep


def require_here(capability: str):
    """
    Like require(), for the company the browser is working in (X-Company) rather
    than the home company: the users screen of a workspace manages its members.
    """
    def dep(authorization: str | None = Header(default=None),
            x_company: str | None = Header(default=None)) -> tuple[dict | None, str]:
        slug = (x_company or "").strip()
        if not slug:
            return _require_home(authorization, capability), ""
        con = connect()
        user = A.resolve(con, _bearer(authorization))
        if not user:
            raise HTTPException(401, "authentication required")
        role = W.company_role(con, user, slug)
        if not role:
            raise HTTPException(403, "you do not work in this company")
        return _check(dict(user, role=role), capability), slug
    return dep


@router.get("/gate")
def gate(authorization: str | None = Header(default=None), x_company: str | None = Header(default=None)):
    """nginx auth_request: may this session work in the company it names? (main installation only)"""
    slug = (x_company or "").strip()
    if not slug:
        return Response(status_code=204)
    if TENANT:
        raise HTTPException(404, "not found")
    con = connect()
    user = A.resolve(con, _bearer(authorization))
    if not user:
        raise HTTPException(401, "authentication required")
    if not W.company_role(con, user, slug):
        raise HTTPException(403, "you do not work in this company")
    return Response(status_code=204, headers={"X-CB-User-Id": user["id"]})


@router.get("/status")
def status():
    return A.status(connect())


@router.post("/bootstrap")
def bootstrap(payload: dict[str, Any] = Body(...)):
    """
    Create the FIRST admin. Refused once any user exists, so this can never be
    used to mint a second admin from outside.

    A new company workspace is reachable before its admin has signed up, so
    whoever found the address first could claim it. When CB_SETUP_CODE is set
    (tenantctl.py sets it for every new workspace and hands it to the person
    setting the company up), the first admin must also give that code.
    """
    code = os.environ.get("CB_SETUP_CODE", "")
    if code and not hmac.compare_digest(str(payload.get("setup_code", "")), code):
        raise HTTPException(403, "this workspace needs its setup code to create the first admin")
    con = A.init(connect())
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
        raise HTTPException(409, "users already exist — ask an admin to create your account")
    try:
        return A.create_user(con, email=payload.get("email", ""), name=payload.get("name", "Admin"),
                             password=payload.get("password", ""), role="admin",
                             person_id=payload.get("person_id"))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/login")
def login(payload: dict[str, Any] = Body(...)):
    try:
        return A.login(connect(), payload.get("email", ""), payload.get("password", ""),
                       otp=payload.get("otp"))
    except PermissionError as e:
        raise HTTPException(401, str(e))


@router.post("/mfa/enroll")
def mfa_enroll(user: dict | None = Depends(current_user)):
    if not user:
        raise HTTPException(401, "not signed in")
    return A.mfa_enroll(connect(), user["id"])


@router.post("/mfa/confirm")
def mfa_confirm(payload: dict[str, Any] = Body(...), user: dict | None = Depends(current_user)):
    if not user:
        raise HTTPException(401, "not signed in")
    try:
        return A.mfa_confirm(connect(), user["id"], payload.get("otp", ""))
    except (ValueError, PermissionError) as e:
        raise HTTPException(400, str(e))


@router.post("/mfa/disable")
def mfa_disable(payload: dict[str, Any] = Body(...), user: dict | None = Depends(current_user)):
    if not user:
        raise HTTPException(401, "not signed in")
    try:
        return A.mfa_disable(connect(), user["id"], payload.get("otp", ""))
    except PermissionError as e:
        raise HTTPException(400, str(e))


@router.post("/logout")
def logout(authorization: str | None = Header(default=None)):
    return A.logout(connect(), _bearer(authorization))


@router.get("/me")
def me(user: dict | None = Depends(current_user)):
    if not user:
        raise HTTPException(401, "not signed in")
    if TENANT:
        return user
    # the companies this person may switch between, home first; an admin of the
    # home company also adds companies (Company workspaces screen)
    return dict(user, companies=W.companies_for(connect(), user), platformAdmin=user["role"] == "admin")


@router.get("/users")
def users(ctx: tuple = Depends(require_here("administer"))):
    _, slug = ctx
    con = connect()
    if slug:
        return {"items": W.members(con, slug), "roles": A.ASSIGNABLE_ROLES, "company": slug}
    return {"items": A.list_users(con), "roles": A.HOME_ROLES, "company": ""}


@router.post("/users")
def add_user(payload: dict[str, Any] = Body(...), ctx: tuple = Depends(require_here("administer"))):
    """
    Home company: a new account. Another company: add the person to it — an
    existing account by email, or a new account that works only there.
    """
    admin, slug = ctx
    con = connect()
    role = payload.get("role", "viewer")
    try:
        if not slug:
            return A.create_user(con, email=payload.get("email", ""), name=payload.get("name", ""),
                                 password=payload.get("password", ""), role=role,
                                 person_id=payload.get("person_id"))
        if role not in A.ASSIGNABLE_ROLES:
            raise ValueError(f"role must be one of {A.ASSIGNABLE_ROLES}")
        email = str(payload.get("email", "")).strip().lower()
        row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if row and not row["active"]:
            raise ValueError("that account is deactivated — reactivate it in the home company first")
        u = A._public(row) if row else A.create_user(
            con, email=email, name=payload.get("name", ""), password=payload.get("password", ""), role=A.NO_ACCESS)
        if u["role"] == "admin":
            raise ValueError("that person is an administrator and already works in every company")
        W.set_member(con, u["id"], slug, role, (admin or {}).get("email", "admin"))
        return dict(u, role=role, existing=bool(row))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.patch("/users/{uid}/role")
def change_role(uid: str, payload: dict[str, Any] = Body(...), ctx: tuple = Depends(require_here("administer"))):
    admin, slug = ctx
    con = connect()
    try:
        if not slug:
            return A.set_role(con, uid, payload.get("role", ""))
        if not con.execute("SELECT 1 FROM workspace_members WHERE user_id = ? AND slug = ?", (uid, slug)).fetchone():
            raise ValueError("an administrator's role is set in the home company")
        W.set_member(con, uid, slug, payload.get("role", ""), (admin or {}).get("email", "admin"))
        return {"id": uid, "role": payload.get("role")}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/users/{uid}/deactivate")
def deactivate(uid: str, ctx: tuple = Depends(require_here("administer"))):
    """Home company: switch the account off everywhere. Another company: remove the person from it."""
    _, slug = ctx
    con = connect()
    if not slug:
        return A.deactivate(con, uid)
    W.remove_member(con, uid, slug)
    return {"removed": uid, "company": slug}
