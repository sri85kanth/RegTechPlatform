"""
Control library and obligation lifecycle endpoints.

The control layer is what makes 44,203 obligations tractable: one control
satisfies many, so the unit of work becomes the control, not the clause.
"""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from . import controls as C
from .api_auth import require
from .criteria import not_criterion
from .db import connect

router = APIRouter(prefix="/api/controls", tags=["controls"], dependencies=[Depends(require("read"))])


@router.get("")
def list_controls():
    con = connect()
    return {"items": C.listing(con), "posture": C.posture(con),
            "coverage": C.coverage_report(con, limit=25)}


@router.get("/posture")
def posture():
    """Where every obligation sits between 'discovered' and 'provably compliant'."""
    return C.posture(connect())


@router.get("/{cid}")
def get_control(cid: str):
    """
    One control with what it covers: the regulations its duties come from, and
    the requirements it is linked to — unmet and most severe first — with the
    gap the assessment recorded. Links come from control_requirements, the
    mapping this system actually writes.
    """
    con = connect()
    c = C.get_control(con, cid)
    if not c:
        raise HTTPException(404, "no such control")
    status_rank = ("CASE i.compliance_status WHEN 'NON_COMPLIANT' THEN 0 WHEN 'PARTIALLY_COMPLIANT' THEN 1 "
                   "WHEN 'EVIDENCE_MISSING' THEN 2 WHEN 'NOT_ASSESSED' THEN 3 WHEN 'COMPLIANT' THEN 5 ELSE 4 END")
    rq_only = not_criterion("rq.id")         # guidebook criteria count under their element
    c["regulations_list"] = [dict(r) for r in con.execute(
        f"""SELECT rq.regulation_id AS id, coalesce(nullif(g.short_title,''), g.title) AS title,
                   count(*) AS duties,
                   count(*) FILTER (WHERE i.compliance_status IN
                       ('NON_COMPLIANT','PARTIALLY_COMPLIANT','EVIDENCE_MISSING')) AS unmet
              FROM control_requirements cr
              JOIN requirements rq ON rq.id = cr.requirement_id
              JOIN regulations g   ON g.id = rq.regulation_id
              LEFT JOIN company_requirement_instances i ON i.id = cr.cri_id
             WHERE cr.control_id = ? AND {rq_only}
             GROUP BY 1, 2 ORDER BY unmet DESC, duties DESC LIMIT 25""", (cid,))]
    c["requirements"] = [dict(r) for r in con.execute(
        f"""SELECT rq.id, rq.regulation_id, rq.source_clause, rq.statement,
                   i.compliance_status, cr.relationship_type, cr.review_status,
                   (SELECT f.severity FROM findings f WHERE f.cri_id = cr.cri_id AND f.status <> 'CLOSED'
                     ORDER BY CASE upper(f.severity) WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                              WHEN 'MEDIUM' THEN 2 ELSE 3 END LIMIT 1) AS risk,
                   (SELECT f.title FROM findings f WHERE f.cri_id = cr.cri_id AND f.status <> 'CLOSED'
                     LIMIT 1) AS gap
              FROM control_requirements cr
              JOIN requirements rq ON rq.id = cr.requirement_id
              LEFT JOIN company_requirement_instances i ON i.id = cr.cri_id
             WHERE cr.control_id = ? AND {rq_only}
             ORDER BY {status_rank}, rq.regulation_id, rq.source_clause
             LIMIT 50""", (cid,))]
    c["duties"] = con.execute(f"SELECT count(*) FROM control_requirements cr WHERE cr.control_id=? "
                              f"AND {not_criterion('cr.requirement_id')}", (cid,)).fetchone()[0]
    c["evidence_list"] = [dict(r) for r in con.execute(
        """SELECT el.evidence_id, e.name, e.type FROM evidence_links el
             LEFT JOIN company_entities e ON e.id = el.evidence_id
            WHERE el.control_id = ? LIMIT 25""", (cid,))]
    return c


@router.post("")
def upsert(payload: dict[str, Any] = Body(...), _: dict | None = Depends(require("propose"))):
    if not (payload.get("name") or "").strip():
        raise HTTPException(400, "name is required")
    return C.upsert_control(
        connect(), control_id=payload.get("id") or f"ctl-{payload['name'][:40].lower().replace(' ', '-')}",
        name=payload["name"], description=payload.get("description", ""),
        control_type=payload.get("control_type"), frequency=payload.get("frequency"),
        automated=payload.get("automated"), entity_id=payload.get("entity_id"),
        owner_id=payload.get("owner_id"))


@router.post("/{cid}/obligations")
def link(cid: str, payload: dict[str, Any] = Body(...),
         user: dict | None = Depends(require("propose"))):
    oid = payload.get("obligation_id", "")
    if not oid:
        raise HTTPException(400, "obligation_id is required")
    created = C.link(connect(), cid, oid, coverage=payload.get("coverage", "Full"),
                     rationale=payload.get("rationale", ""),
                     actor=(user or {}).get("email", "user"))
    return {"created": created}


# ---------------------------------------------------------------- lifecycle
obl = APIRouter(prefix="/api/obligations", tags=["obligations"], dependencies=[Depends(require("read"))])


@obl.get("/{oid}/status")
def status(oid: str):
    con = connect()
    st = C.state_of(con, oid)
    events = [dict(r) for r in con.execute(
        "SELECT * FROM obligation_events WHERE obligation_id=? ORDER BY id", (oid,))]
    return {"obligation_id": oid, "state": st,
            "allowedNext": sorted(C.TRANSITIONS.get(st, set())),
            "needsReason": sorted(C.NEEDS_REASON), "events": events}


@obl.post("/{oid}/status")
def set_status(oid: str, payload: dict[str, Any] = Body(...),
               user: dict | None = Depends(require("approve"))):
    try:
        return C.set_state(connect(), oid, payload.get("to", ""),
                           actor=(user or {}).get("email", "user"),
                           reason=payload.get("reason", ""),
                           owner_id=payload.get("owner_id"),
                           due_date=payload.get("due_date"))
    except C.TransitionError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@obl.get("/by-state")
def by_state(state: str = Query(...), limit: int = 100):
    con = connect()
    return {"items": [dict(r) for r in con.execute(
        """SELECT o.id, o.title, o.regulation_id, r.title AS regulation_title,
                  s.state, s.reason, s.updated_at
           FROM obligation_status s
           JOIN obligations o ON o.id = s.obligation_id
           LEFT JOIN regulations r ON r.id = o.regulation_id
           WHERE s.state = ? ORDER BY s.updated_at DESC LIMIT ?""", (state, limit))]}
