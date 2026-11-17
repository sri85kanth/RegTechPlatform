"""
Risk intake endpoints (design §6–§7): the records scoring needs, history
attestations, leadership's risk appetite (gate G1) and the facts waiting for a
person to confirm them (gate G2).

Who may do what:
  read      everything here
  propose   add or change a site, licence, third party or history record;
            ask the system to propose facts from what onboarding holds
  approve   remove a record, sign an attestation, draft the appetite, decide a fact
  govern    approve or return the appetite — admins, and the people an admin
            names on the appetite screen (risk_governors)

The register and its review (Phase 3, gates G3–G9) are below the intake
routes. The store (risk/review.py) enforces who may decide what — four eyes
for a lower override, a different person to validate a claim, leadership to
accept a risk above tolerance — so these routes only check the floor.
"""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response

from .api_auth import require
from .db import connect
from .risk import controls_import as CI
from .risk import intake as I
from .risk import library as L
from .risk import register as G
from .risk import review as V
from .risk import rulebook as R
from .risk.intake import Conflict, IntakeError

router = APIRouter(prefix="/api/risk", tags=["risk"], dependencies=[Depends(require("read"))])
KINDS = tuple(I.SPECS)


@lru_cache(maxsize=8)
def _rulebook(name: str) -> R.Rulebook:
    return R.load(name)


def _profile(con) -> dict:
    r = con.execute("SELECT entity_type, sectors FROM company_profile ORDER BY id LIMIT 1").fetchone()
    p = dict(r) if r else {}
    try:
        p["sectors"] = json.loads(p["sectors"]) if isinstance(p.get("sectors"), str) else (p.get("sectors") or [])
    except ValueError:
        p["sectors"] = []
    return p


def _rb(con) -> R.Rulebook:
    return _rulebook(I.pack_for(_profile(con)))


def _actor(user: dict | None) -> str:
    return (user or {}).get("email") or (user or {}).get("name") or "api"


def _call(fn, *a, **kw):
    """Map the store's refusals to HTTP: a bad value 422, not yours to decide 403, a wrong state 409, nothing there 404."""
    try:
        return fn(*a, **kw)
    except IntakeError as e:
        raise HTTPException(422, str(e)) from None
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    except Conflict as e:
        raise HTTPException(409, str(e)) from None
    except KeyError:
        raise HTTPException(404, "not found") from None


@lru_cache(maxsize=8)
def _library(name: str) -> L.Library:
    return L.load(_rulebook(name))


def _lib(con) -> L.Library:
    return _library(I.pack_for(_profile(con)))


def _who(user: dict | None) -> dict:
    """The person deciding. While no users exist the API is open (api_auth.require): act as an unnamed admin."""
    return user or {"id": None, "role": "admin", "email": "api"}


def _rerun(con, user: dict | None, risk_ids: list[str] | None = None) -> dict:
    """Re-assess after a decision that changes inputs; everything when risk_ids is None."""
    return G.run(con, _rb(con), _lib(con), actor=V.actor(_who(user)), trigger="decision", risk_ids=risk_ids)


def _kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(404, f"no record kind {kind!r}")
    return kind


def _govern(con, user: dict | None) -> None:
    if not I.can_govern(con, user):
        raise HTTPException(403, "only leadership may approve the risk appetite: an admin, or someone an admin named")


# ------------------------------------------------------------------ overview and vocabulary
@router.get("/readiness")
def readiness():
    con = connect()
    return I.readiness(con, _rb(con))


@router.get("/meta")
def meta():
    """The vocabularies the intake screens offer, from the company's own rulebook."""
    con = connect()
    rb = _rb(con)
    return {
        "pack": rb.ref,
        "historyKinds": list(I.HISTORY_KINDS),
        "attestable": list(I.ATTESTABLE),
        "criticality": list(I.CRITICALITY),
        "outcomes": list(I.OUTCOMES),
        "bands": list(R.BANDS),
        "categories": list(R.CATEGORIES),
        "themes": [{"id": t["id"], "name": t["name"]} for t in rb.themes.values()],
        "scaleMetrics": sorted({k for lvl in (rb.data.get("scale_index") or {}).values() for k in lvl}),
        "historyWindowMonths": I.HISTORY_WINDOW_MONTHS,
        # the rulebook's band matrix: the starting point when leadership sets its own (decision D2)
        "matrix": {str(k): v for k, v in rb.data["matrix"].items()},
    }


# ------------------------------------------------------------------ records
@router.get("/records/{kind}")
def list_records(kind: str, include_retired: bool = Query(False)):
    return {"items": I.list_records(connect(), _kind(kind), include_retired)}


@router.post("/records/{kind}")
def create_record(kind: str, body: dict[str, Any] = Body(...), user=Depends(require("propose"))):
    return _call(I.create_record, connect(), _kind(kind), body, _actor(user))


@router.patch("/records/{kind}/{rid}")
def update_record(kind: str, rid: str, body: dict[str, Any] = Body(...), user=Depends(require("propose"))):
    return _call(I.update_record, connect(), _kind(kind), rid, body, _actor(user))


@router.delete("/records/{kind}/{rid}")
def retire_record(kind: str, rid: str, user=Depends(require("approve"))):
    return _call(I.retire_record, connect(), _kind(kind), rid, _actor(user))


# ------------------------------------------------------------------ attestations
@router.get("/attestations")
def attestations():
    con = connect()
    return {"items": I.attestations(con), "coverage": I.history_coverage(con)}


@router.post("/attestations")
def attest(body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = connect()
    return _call(I.attest, con, kind=body.get("kind"), months=body.get("months"), name=body.get("name"),
                 designation=body.get("designation"), statement=body.get("statement"), site_id=body.get("siteId"),
                 document_id=body.get("documentId"), attested_on=body.get("attestedOn"),
                 actor=_actor(user), actor_user_id=(user or {}).get("id"))


# ------------------------------------------------------------------ appetite (gate G1)
@router.get("/appetite")
def appetite(user=Depends(require("read"))):
    con = connect()
    return {**I.appetite_state(con), "canGovern": I.can_govern(con, user), "governors": I.governors(con)}


@router.put("/appetite/draft")
def save_draft(body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    return _call(I.save_draft, connect(), body, _actor(user))


@router.post("/appetite/approve")
def approve(body: dict[str, Any] = Body(...), user=Depends(require("read"))):
    con = connect()
    _govern(con, user)
    return _call(I.approve_appetite, con, actor=_actor(user), actor_user_id=(user or {}).get("id"),
                 approver_name=body.get("approverName"), designation=body.get("designation"),
                 minutes_document_id=body.get("minutesDocumentId"), note=body.get("note"))


@router.post("/appetite/return")
def return_draft(body: dict[str, Any] = Body(...), user=Depends(require("read"))):
    con = connect()
    _govern(con, user)
    return _call(I.return_appetite, con, actor=_actor(user), note=body.get("note"))


@router.post("/governors")
def grant(body: dict[str, Any] = Body(...), user=Depends(require("administer"))):
    return {"items": _call(I.grant_governor, connect(), body.get("userId"), body.get("designation"), _actor(user))}


@router.delete("/governors/{user_id}")
def revoke(user_id: str, user=Depends(require("administer"))):
    return {"items": _call(I.revoke_governor, connect(), user_id, _actor(user))}


# ------------------------------------------------------------------ facts (gate G2)
@router.get("/facts")
def facts(status: str | None = Query("PROPOSED")):
    status = None if (status or "").upper() == "ALL" else (status or "PROPOSED").upper()
    return {"items": I.list_facts(connect(), status)}


@router.post("/facts/propose")
def propose(user=Depends(require("propose"))):
    """Propose facts from what onboarding already holds. Nothing is used until a person decides."""
    return I.propose_from_records(connect())


@router.post("/facts/{fact_id}/decide")
def decide(fact_id: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    return _call(I.decide_fact, connect(), fact_id, body.get("decision"), _actor(user),
                 value=body.get("value"), note=body.get("note"))


# ------------------------------------------------------------------ the register (Phase 3)
@router.get("/register")
def register(include_retired: bool = Query(False)):
    con = connect()
    rb = _rb(con)
    return {"items": V.list_risks(con, include_retired), "queue": V.queue_summary(con),
            "rulebook": {**rb.ref, "published": V.publication_state(con, rb)["current"]},
            "appetite": bool(I.appetite_state(con)["approved"]), "controls": CI.coverage(con)}


@router.post("/register/run")
def run_register(user=Depends(require("propose"))):
    """Identify risks from the library on the company's graph, assess them, and route what needs a person."""
    con = connect()
    return G.run(con, _rb(con), _lib(con), actor=V.actor(_who(user)))


@router.post("/register")
def add_risk(body: dict[str, Any] = Body(...), user=Depends(require("propose"))):
    con = connect()
    risk = _call(V.create_custom, con, _rb(con), body, _who(user))
    _rerun(con, user, [risk["id"]])
    return risk


@router.get("/register/{rid}")
def risk_detail(rid: str):
    con = connect()
    return _call(V.risk_detail, con, _lib(con), rid)


@router.put("/register/{rid}/owner")
def set_owner(rid: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = connect()
    out = _call(V.set_owner, con, rid, body.get("userId"), body.get("name"), _who(user))
    _rerun(con, user, [rid])
    return out


@router.post("/register/{rid}/controls")
def record_control(rid: str, body: dict[str, Any] = Body(...), user=Depends(require("propose"))):
    con = connect()
    out = _call(V.record_control, con, rid, body, _who(user))
    _rerun(con, user, [rid])
    return out


@router.post("/controls/{rating_id}/validate")
def validate_control(rating_id: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = connect()
    out = _call(V.validate_control, con, rating_id, body.get("grade"), _who(user), evidence=body.get("evidence"),
                evidence_on=body.get("evidenceOn"), note=body.get("note"))
    _rerun(con, user, [out["risk_id"]])
    return out


@router.post("/register/{rid}/treatment")
def treat(rid: str, body: dict[str, Any] = Body(...), user=Depends(require("read"))):
    con = connect()
    out = _call(V.decide_treatment, con, rid, {
        "decision": body.get("decision"), "rationale": body.get("rationale"), "name": body.get("name"),
        "designation": body.get("designation"), "accept_until": body.get("acceptUntil"),
        "transfer_to": body.get("transferTo"), "instrument": body.get("instrument"),
        "actions": [{"title": a.get("title"), "due_date": a.get("dueDate"), "kind": a.get("kind")}
                    for a in (body.get("actions") or [])]}, _who(user))
    _rerun(con, user, [rid])
    return out


@router.post("/register/{rid}/overrides")
def override(rid: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = connect()
    out = _call(V.propose_override, con, rid, body, _who(user))
    _rerun(con, user, [rid])
    return out


@router.post("/overrides/{oid}/decide")
def decide_override(oid: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = connect()
    out = _call(V.decide_override, con, oid, bool(body.get("approve")), _who(user), body.get("note"))
    _rerun(con, user, [out["risk_id"]])
    return out


@router.post("/overrides/{oid}/revoke")
def revoke_override(oid: str, body: dict[str, Any] = Body(default={}), user=Depends(require("approve"))):
    con = connect()
    out = _call(V.revoke_override, con, oid, _who(user), body.get("note"))
    _rerun(con, user, [out["risk_id"]])
    return out


@router.post("/exposures/{xid}/decide")
def decide_exposure(xid: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = connect()
    out = _call(V.decide_exposure, con, xid, body.get("decision"), body.get("reason"), _who(user))
    _rerun(con, user, [out["risk_id"]])
    return out


@router.post("/register/{rid}/triage")
def triage(rid: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    con = connect()
    out = _call(V.decide_candidate, con, rid, body.get("decision"), body.get("reason"), _who(user),
                merge_into=body.get("mergeInto"))
    _rerun(con, user, [rid])
    return out


@router.put("/themes/{regulation_id}")
def assign_theme(regulation_id: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    """G3: place a regulation the rulebook's mapping cannot place; its duties move to that theme's risk."""
    con = connect()
    out = _call(V.assign_theme, con, _rb(con), regulation_id, body.get("theme"), _who(user), body.get("note"))
    return {**out, "run": _rerun(con, user)}


@router.get("/questions")
def questions():
    con = connect()
    return {"items": V.questions(con), "possible": V.possible_total(con)}


@router.put("/questions/{key}")
def answer(key: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    """Answer what decides the library risks; the register is rebuilt so every template it decides follows."""
    con = connect()
    _call(V.answer_question, con, key, body.get("value"), body.get("note"), _who(user))
    run = _rerun(con, user)
    return {"items": V.questions(con), "possible": V.possible_total(con), "run": run}


# ------------------------------------------------------------------ the review queue
@router.get("/tasks")
def tasks(status: str = Query("OPEN"), gate: str | None = Query(None), mine: bool = Query(False),
          user=Depends(require("read"))):
    con = connect()
    return {"items": V.list_tasks(con, status=status.upper(), gate=gate, user=_who(user), mine=mine),
            "summary": V.queue_summary(con)}


@router.post("/tasks/{tid}/assign")
def assign(tid: str, body: dict[str, Any] = Body(...), user=Depends(require("approve"))):
    return _call(V.assign_task, connect(), tid, body.get("userId"), body.get("role"), _who(user))


@router.post("/tasks/{tid}/acknowledge")
def acknowledge(tid: str, body: dict[str, Any] = Body(default={}), user=Depends(require("approve"))):
    return _call(V.acknowledge, connect(), tid, _who(user), note=body.get("note"), escalate=bool(body.get("escalate")))


# ------------------------------------------------------------------ rulebook publication (G8)
@router.get("/rulebook")
def rulebook_state():
    con = connect()
    return V.publication_state(con, _rb(con))


@router.post("/rulebook/publish")
def request_publish(user=Depends(require("approve"))):
    con = connect()
    return _call(V.request_publication, con, _rb(con), _lib(con), _who(user))


@router.post("/rulebook/publish/{pid}/decide")
def decide_publish(pid: str, body: dict[str, Any] = Body(...), user=Depends(require("read"))):
    con = connect()
    return _call(V.decide_publication, con, _rb(con), pid, bool(body.get("approve")), _who(user), body.get("note"))


# ------------------------------------------------------------------ controls in bulk
@router.get("/controls/matches")
def control_matches():
    """The company's own controls matched to each risk's unknown typical controls, with a proposed grade."""
    con = connect()
    return CI.matches(con, _lib(con))


@router.post("/controls/matches/apply")
def apply_control_matches(body: dict[str, Any] = Body(...), user=Depends(require("propose"))):
    con = connect()
    return _call(CI.apply_matches, con, _rb(con), _lib(con), body.get("items") or [], _who(user))


@router.get("/controls/workbook")
def control_workbook():
    """Every risk and its controls, prefilled, as an Excel workbook to fill in."""
    con = connect()
    rb = _rb(con)
    data = CI.workbook(con, _lib(con), {t["id"]: t["name"] for t in rb.themes.values()})
    return Response(content=data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="risk-controls.xlsx"'})


@router.post("/controls/import")
def import_controls(body: dict[str, Any] = Body(...), user=Depends(require("propose"))):
    """Check a filled workbook (.xlsx or .csv, base64); with apply, record the rows that pass."""
    con = connect()
    return _call(CI.import_workbook, con, _rb(con), _lib(con), body.get("fileName") or "", body.get("content") or "",
                 _who(user), apply=bool(body.get("apply")))
