"""
Accountability endpoints — owners, heads, approvers and delegates.

Answers the question an inspection opens with: who is responsible for this, and
who signed it off?
"""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from . import accountability as A
from . import documents as D
from . import owners as O
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/accountability", tags=["accountability"], dependencies=[Depends(require("read"))])


@router.get("/coverage")
def coverage():
    con = connect()
    out = {"owners": O.coverage(con), "edges": A.coverage(con)}
    try:
        out["documents"] = D.stats(con)
    except D.SchemaPending as e:
        # Report the reason rather than failing the whole page: ownership and
        # edges are perfectly readable even while the document migration waits.
        out["documents"] = {"total": 0, "byType": {}, "unlinked": 0,
                            "withoutVersion": 0, "withoutApprover": 0,
                            "pending": str(e)}
    return out


@router.post("/resolve-owners")
def resolve_owners(apply: bool = Query(False), _: dict = Depends(require("approve"))):
    """
    Link owner NAMES to owner RECORDS. Defaults to a dry run — see what would
    change before rewriting ownership across the estate.
    """
    return O.resolve(connect(), apply=apply)


@router.post("/derive")
def derive(apply: bool = Query(False), _: dict = Depends(require("approve"))):
    """Build owns / approves / heads edges from data already present."""
    return A.derive(connect(), apply=apply)


@router.get("/delegations")
def list_delegations(person: str | None = None, active_only: bool = False):
    return {"items": A.delegations(connect(), person=person, active_only=active_only)}


@router.post("/delegations")
def create_delegation(payload: dict[str, Any] = Body(...),
                      user: dict | None = Depends(require("approve"))):
    try:
        return A.delegate(
            connect(),
            from_person=payload.get("from_person", ""), to_person=payload.get("to_person", ""),
            valid_from=payload.get("valid_from"), valid_until=payload.get("valid_until"),
            scope=payload.get("scope"), reason=payload.get("reason", ""),
            created_by=(user or {}).get("email", "system"))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/delegations/{did}/revoke")
def revoke(did: int, user: dict | None = Depends(require("approve"))):
    return A.revoke(connect(), did, actor=(user or {}).get("email", "system"))


@router.post("/edges")
def add_edge(payload: dict[str, Any] = Body(...), user: dict | None = Depends(require("approve"))):
    try:
        created = A.add_edge(connect(), payload.get("source_id", ""),
                             payload.get("type", ""), payload.get("target_id", ""),
                             actor=(user or {}).get("email", "system"))
        return {"created": created}
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------- documents
docs = APIRouter(prefix="/api/documents", tags=["documents"], dependencies=[Depends(require("read"))])


@docs.get("")
def list_documents(document_type: str | None = None, entity_id: str | None = None):
    con = connect()
    try:
        return {"items": D.listing(con, document_type=document_type, entity_id=entity_id),
                "stats": D.stats(con), "types": list(D.TYPES) + ["Unclassified"]}
    except D.SchemaPending as e:
        raise HTTPException(503, str(e))


@docs.post("/sync")
def sync_documents(apply: bool = Query(True), _: dict = Depends(require("propose"))):
    """Promote collected files into typed document records."""
    return D.sync_from_entities(connect(), apply=apply)
