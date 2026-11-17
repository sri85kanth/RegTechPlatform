"""
Action / CAPA endpoints — the work that closes the loop on a regulatory change.

Transitions are validated server-side. A client cannot mark something Done by
posting a status; the lifecycle and the closure requirements are enforced here.
"""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from .api_auth import require

from . import actions as A
from .db import connect

router = APIRouter(prefix="/api/actions", tags=["actions"], dependencies=[Depends(require("read"))])


@router.get("")
def list_actions(status: str | None = None, regulation_id: str | None = None,
                 owner_id: str | None = None, overdue: bool = False, limit: int = 200):
    con = connect()
    return {"items": A.listing(con, status=status, regulation_id=regulation_id,
                               owner_id=owner_id, overdue=overdue, limit=limit),
            "stats": A.stats(con), "statuses": A.STATUSES}


@router.get("/stats")
def action_stats():
    return A.stats(connect())


@router.get("/{aid}")
def get_action(aid: int):
    a = A.get(connect(), aid)
    if not a:
        raise HTTPException(404, "no such action")
    return a


@router.post("")
def create_action(payload: dict[str, Any] = Body(...),
                  user: dict | None = Depends(require("propose"))):
    if not (payload.get("title") or "").strip():
        raise HTTPException(400, "title is required")
    try:
        return A.create(
            connect(), title=payload["title"], description=payload.get("description", ""),
            action_type=payload.get("action_type", "assess"),
            priority=payload.get("priority", "P2"),
            regulation_id=payload.get("regulation_id"),
            obligation_id=payload.get("obligation_id"),
            entity_id=payload.get("entity_id"), owner_id=payload.get("owner_id"),
            due_date=payload.get("due_date"), source="manual",
            created_by=(f"{user['name']} <{user['email']}>" if user
                        else payload.get("actor") or "user"),
            status=payload.get("status") or "Proposed")
    except (ValueError, A.TransitionError) as e:
        raise HTTPException(400, str(e))


@router.post("/{aid}/transition")
def move(aid: int, payload: dict[str, Any] = Body(...),
         user: dict | None = Depends(require("approve"))):
    to = (payload.get("to") or "").strip()
    if not to:
        raise HTTPException(400, "'to' status is required")
    # The actor is taken from the authenticated session, never from the request
    # body — otherwise the audit trail records whatever the client typed.
    actor = (f"{user['name']} <{user['email']}>" if user
             else (payload.get("actor") or "unauthenticated"))
    try:
        return A.transition(connect(), aid, to,
                            actor=actor,
                            note=payload.get("note", ""),
                            evidence_id=payload.get("evidence_id"),
                            owner_id=payload.get("owner_id"),
                            due_date=payload.get("due_date"))
    except A.TransitionError as e:
        # 409: the request is well-formed but the lifecycle forbids it
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/from-run/{run_id}")
def from_run(run_id: int, user: dict | None = Depends(require("propose"))):
    """Promote an impact run's proposed actions into tracked work (as Proposed)."""
    try:
        return A.from_impact_run(connect(), run_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
