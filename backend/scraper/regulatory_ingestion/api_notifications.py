"""
Notification endpoints.

Everything is scoped to the caller: a user only ever sees what is addressed to
them or to a role they hold, and can only mark their own as read.
"""
from fastapi import APIRouter, Body, Depends, HTTPException

from . import notifications as N
from .api_auth import current_user, require
from .db import connect

router = APIRouter(prefix="/api/notifications", tags=["notifications"], dependencies=[Depends(require("read"))])


def _user_or_anon(user: dict | None) -> dict:
    # Before any account exists the API is open; treat the caller as an admin-
    # equivalent reader so the bell is not silently empty in that mode.
    return user or {"id": "__anon__", "role": "admin"}


@router.get("")
def list_notifications(unread_only: bool = False, limit: int = 50,
                       user: dict | None = Depends(current_user)):
    con = connect()
    u = _user_or_anon(user)
    return {"items": N.for_user(con, u, unread_only=unread_only, limit=limit, with_regulation=True),
            "unread": N.unread_count(con, u)}


@router.get("/count")
def count(user: dict | None = Depends(current_user)):
    return {"unread": N.unread_count(connect(), _user_or_anon(user))}


@router.post("/read")
def read(payload: dict = Body(default={}), user: dict | None = Depends(current_user)):
    return {"marked": N.mark_read(connect(), _user_or_anon(user), payload.get("ids"))}


@router.post("/{nid}/dismiss")
def dismiss(nid: int, user: dict | None = Depends(current_user)):
    if not N.dismiss(connect(), _user_or_anon(user), nid):
        raise HTTPException(404, "not found, or not addressed to you")
    return {"dismissed": nid}


@router.post("/generate")
def generate(_: dict | None = Depends(require("propose"))):
    """Derive notifications from current state. Idempotent."""
    return N.generate(connect())
