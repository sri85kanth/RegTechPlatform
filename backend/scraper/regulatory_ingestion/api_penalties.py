"""
Penalty exposure and enforcement history — the "what does failure cost" API.

Read-gated like every other data surface. Exposure quotes statutory ceilings
verbatim from the regulation's text; enforcement lists what RBI actually
imposed. Neither is a prediction and both say so.
"""
from fastapi import APIRouter, Depends, Query

from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api", tags=["penalties"],
                   dependencies=[Depends(require("read"))])


@router.get("/regulations/{rid}/exposure")
def regulation_exposure(rid: str):
    from . import penalties
    return penalties.exposure(connect(), rid)


@router.get("/enforcement")
def enforcement_actions(limit: int = Query(50, ge=1, le=200)):
    from . import enforcement as E
    con = connect()
    return {"items": E.listing(con, limit=limit), "stats": E.stats(con),
            "note": "Amounts actually imposed by the regulator, from its own press releases."}
