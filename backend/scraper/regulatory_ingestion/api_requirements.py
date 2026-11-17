"""
The compliance chain, served from the tables that already hold it.

    REGULATION → CLAUSE → OBLIGATION → REQUIREMENT → APPLICABILITY
              → CONTROL → EVIDENCE → ASSESSMENT → COMPLIANCE RESULT

Nothing here computes a chain in the response that is not a row-for-row join
of persisted relationships. Where a link is missing the payload says so with a
named state, never a blank or a guess — a compliance screen that hides a gap is
worse than one that shows it.

`requirements` is the single requirements store (34,746 rows). This module
reads it; it never copies out of it.
"""
from __future__ import annotations

import time as _time

from fastapi import APIRouter, Depends, HTTPException, Query

from .api_auth import require
from .criteria import criterion_id, is_criterion, not_criterion
from .db import connect

router = APIRouter(prefix="/api", tags=["compliance-chain"],
                   dependencies=[Depends(require("read"))])


# ---------------------------------------------------------------- ttl cache
# These endpoints recompute the same corpus-wide aggregates on every call —
# COUNT(*) over 37k requirements and 105k obligations. On a healthy box that is
# a second; on this deployment, where the hypervisor is taking ~94% of the CPU,
# it is half a minute. The numbers describe a corpus that changes on an
# ingestion run, not per request, so a short TTL costs nothing real and turns
# a 30-second dashboard into an instant one for everybody after the first
# caller. Exactness is preserved — the value is a real COUNT, just briefly
# reused.
_CACHE: dict[str, tuple[float, object]] = {}


def _cached(key: str, ttl: float, fn):
    now = _time.monotonic()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = fn()
    _CACHE[key] = (now, val)
    return val


def _con():
    return connect()


def _rows(con, q, *p):
    return [dict(r) for r in con.execute(q, p).fetchall()]


def _one(con, q, *p):
    r = con.execute(q, p).fetchone()
    return dict(r) if r else None


# ---------------------------------------------------------------- list
SORTS = {
    "clause": "rq.source_clause",
    "regulation": "rq.regulation_id",
    "confidence": "rq.confidence DESC NULLS LAST",
    "review": "rq.review_status",
}


@router.get("/requirements")
def list_requirements(
    page: int = 1,
    size: int = Query(50, le=200),
    q: str | None = None,
    regulation_id: str | None = None,
    obligation_id: str | None = None,
    review_status: str | None = None,
    applicability: str | None = None,
    control_status: str | None = Query(None, description="mapped | unmapped"),
    evidence_status: str | None = Query(None, description="present | absent"),
    sort: str = "clause",
    criteria: bool = Query(False, description="include guidebook assessment criteria as rows"),
):
    """
    The requirement register. Every row carries its lineage keys and the live
    state of the three links that follow it, so the list can show a gap
    instead of implying coverage.
    """
    con = _con()
    where, params = ["1=1"], []
    if not criteria:
        where.append(not_criterion("rq.id"))
    if regulation_id:
        where.append("rq.regulation_id = ?"); params.append(regulation_id)
    if obligation_id:
        where.append("rq.obligation_id = ?"); params.append(obligation_id)
    if review_status:
        where.append("rq.review_status = ?"); params.append(review_status)
    if q:
        where.append("(rq.statement ILIKE ? OR rq.source_clause ILIKE ? OR rq.id ILIKE ?)")
        params += [f"%{q}%", f"%{q}%", f"%{q}%"]
    if applicability:
        # the requirement's own verdict (v_company_requirements falls back to the regulation's)
        where.append("""EXISTS (SELECT 1 FROM v_company_requirements v
                               WHERE v.requirement_id = rq.id AND v.applicability = ?)""")
        params.append(applicability)
    if control_status == "mapped":
        where.append("EXISTS (SELECT 1 FROM control_requirements cr WHERE cr.requirement_id = rq.id)")
    elif control_status == "unmapped":
        where.append("NOT EXISTS (SELECT 1 FROM control_requirements cr WHERE cr.requirement_id = rq.id)")
    if evidence_status == "present":
        where.append("""EXISTS (SELECT 1 FROM control_requirements cr
                               JOIN control_evidence ce ON ce.control_id = cr.control_id
                               WHERE cr.requirement_id = rq.id)""")
    elif evidence_status == "absent":
        where.append("""NOT EXISTS (SELECT 1 FROM control_requirements cr
                                   JOIN control_evidence ce ON ce.control_id = cr.control_id
                                   WHERE cr.requirement_id = rq.id)""")

    w = " AND ".join(where)
    total = con.execute(f"SELECT COUNT(*) FROM requirements rq WHERE {w}", params).fetchone()[0]
    order = SORTS.get(sort, SORTS["clause"])
    items = _rows(con, f"""
        SELECT rq.id, rq.regulation_id, rq.obligation_id, rq.statement, rq.source_clause,
               rq.source_excerpt, rq.frequency, rq.deadline, rq.responsible_role,
               rq.confidence, rq.review_status, rq.derivation_method,
               r.title  AS regulation_title, r.regulator_short,
               o.title  AS obligation_title, o.section_id, o.clause_id,
               v.applicability, v.applicability_reason, v.applicability_rule,
               v.regulation_applicability, v.compliance_status,
               (SELECT COUNT(*) FROM control_requirements cr
                 WHERE cr.requirement_id = rq.id)                     AS control_count,
               (SELECT COUNT(DISTINCT ce.evidence_id) FROM control_requirements cr
                  JOIN control_evidence ce ON ce.control_id = cr.control_id
                 WHERE cr.requirement_id = rq.id)                     AS evidence_count,
               (SELECT a.result FROM assessments a
                 WHERE a.requirement_id = rq.id ORDER BY a.assessed_at DESC LIMIT 1) AS assessment_result,
               (SELECT COUNT(*) FROM requirements c
                 WHERE c.obligation_id = rq.obligation_id AND {is_criterion("c.id")}) AS criteria_count,
               {is_criterion("rq.id")}                                   AS is_criterion
          FROM requirements rq
          LEFT JOIN regulations r ON r.id = rq.regulation_id
          LEFT JOIN obligations o ON o.id = rq.obligation_id
          LEFT JOIN v_company_requirements v ON v.requirement_id = rq.id
         WHERE {w}
         ORDER BY {order}
         LIMIT ? OFFSET ?""", *params, size, (page - 1) * size)

    for it in items:
        it["control_status"] = "MAPPED" if it["control_count"] else "UNMAPPED"
        it["evidence_status"] = "PRESENT" if it["evidence_count"] else "ABSENT"
        it["applicability"] = it["applicability"] or "NOT_ASSESSED"
        # "req-engine/1:OTHER_TYPE" → OTHER_TYPE: what kind of sentence decided it
        it["applicability_kind"] = (it.pop("applicability_rule") or "").partition(":")[2] or None
        it["compliance_status"] = it["compliance_status"] or "NOT_ASSESSED"
        it["assessment_result"] = it["assessment_result"] or "NOT_ASSESSED"
    return {"page": page, "size": size, "total": total, "items": items,
            "note": "Requirements are derived from obligations; source_clause and "
                    "source_excerpt carry the original wording they came from."
                    + ("" if criteria else " Guidebook assessment criteria are listed under "
                       "their objective element, not as requirements of their own.")}


# ---------------------------------------------------------------- metrics
@router.get("/requirements/metrics")
def requirement_metrics():
    """Header metrics, every one a real COUNT — cached briefly, never estimated."""
    return _cached("req-metrics", 60.0, _requirement_metrics)


def _requirement_metrics():
    con = _con()
    n = lambda sql, *p: con.execute(sql, p).fetchone()[0]
    mapped_regs = n("SELECT COUNT(*) FROM regulations WHERE ingestion_status='MAPPED'")
    with_req = n("SELECT COUNT(DISTINCT regulation_id) FROM requirements")
    rq_only = not_criterion("rq.id")        # guidebook criteria count under their element
    return {
        "totalRequirements": n(f"SELECT COUNT(*) FROM requirements rq WHERE {rq_only}"),
        "regulationsWithRequirements": with_req,
        "regulationsWithoutRequirements": max(mapped_regs - with_req, 0),
        "mappedRegulations": mapped_regs,
        "requirementsWithControls": n(
            f"SELECT COUNT(DISTINCT cr.requirement_id) FROM control_requirements cr WHERE {not_criterion('cr.requirement_id')}"),
        "requirementsWithoutControls": n(
            f"""SELECT COUNT(*) FROM requirements rq WHERE {rq_only} AND NOT EXISTS
               (SELECT 1 FROM control_requirements cr WHERE cr.requirement_id = rq.id)"""),
        "requirementsRequiringReview": n(
            f"SELECT COUNT(*) FROM requirements rq WHERE {rq_only} AND rq.review_status IN ('UNREVIEWED','NEEDS_REVIEW')"),
        "controlMappingsAwaitingReview": n(
            "SELECT COUNT(*) FROM control_requirements WHERE review_status='UNREVIEWED'"),
        "note": "Counts are live. 'Without controls' is a real gap, not a loading state.",
    }


# ---------------------------------------------------------------- detail
@router.get("/requirements/{rid}")
def requirement_detail(rid: str):
    """
    One requirement with its legal lineage intact:
    regulation → chapter/part → section → clause → sub-clause → obligation.

    The payload separates what the drafter wrote from what this system derived:
      originalLegalText  — verbatim clause / section text, never rewritten
      obligation         — the extracted duty, with its own method + confidence
      requirement        — the derived statement, with its method + confidence
    """
    con = _con()
    rq = _one(con, """
        SELECT rq.*, r.title AS regulation_title, r.regulator, r.regulator_short,
               r.source_url, r.official_document_url
          FROM requirements rq LEFT JOIN regulations r ON r.id = rq.regulation_id
         WHERE rq.id = ?""", rid)
    if not rq:
        raise HTTPException(404, "no such requirement")

    obl = _one(con, """SELECT id, title, description, obligation_type, mandatory_action,
                              responsible_entity, frequency, evidence_required, source_reference,
                              confidence, extraction_method, review_status, section_id, clause_id,
                              source_excerpt, page_number
                         FROM obligations WHERE id = ?""", rq["obligation_id"])

    section = clause = None
    ancestors = []
    if obl and obl.get("section_id"):
        section = _one(con, """SELECT id, section_number, section_title, section_text, chars,
                                      parent_section_id, chapter_id
                                 FROM sections WHERE id = ?""", obl["section_id"])
    if obl and obl.get("clause_id"):
        clause = _one(con, """SELECT id, clause_number, clause_text, clause_path, depth,
                                     parent_clause_id, page_number
                                FROM clauses WHERE id = ?""", obl["clause_id"])
        # walk up the clause tree so sub-clauses show their parents
        cur, guard = clause, 0
        while cur and cur.get("parent_clause_id") and guard < 8:
            cur = _one(con, """SELECT id, clause_number, clause_text, clause_path, depth,
                                      parent_clause_id FROM clauses WHERE id = ?""",
                       cur["parent_clause_id"])
            if cur:
                ancestors.append(cur)
            guard += 1

    # the guidebook criteria that sit under this requirement's objective element
    criteria = _rows(con, f"""
        SELECT c.id, c.statement, c.test_method, c.responsible_role, c.frequency,
               (SELECT cri.compliance_status FROM company_requirement_instances cri
                 WHERE cri.requirement_id = c.id LIMIT 1) AS compliance_status
          FROM requirements c
         WHERE c.obligation_id = ? AND {is_criterion("c.id")} AND c.id <> ?
         ORDER BY length(c.id), c.id""", rq["obligation_id"], rid) if rq.get("obligation_id") else []

    return {
        "isCriterion": criterion_id(rid),
        "criteria": criteria,
        "requirement": {k: rq[k] for k in (
            "id", "obligation_id", "regulation_id", "statement", "expected_action", "threshold",
            "condition", "frequency", "deadline", "responsible_role", "test_method",
            "source_clause", "source_excerpt", "page_number", "confidence",
            "derivation_method", "review_status") if k in rq},
        "lineage": {
            "regulation": {"id": rq["regulation_id"], "title": rq.get("regulation_title"),
                           "regulator": rq.get("regulator"), "regulatorShort": rq.get("regulator_short"),
                           "sourceUrl": rq.get("source_url"),
                           "documentUrl": rq.get("official_document_url")},
            "chapter": (section or {}).get("chapter_id"),
            "section": section,
            "clause": clause,
            "clauseAncestors": list(reversed(ancestors)),
            "obligation": obl,
        },
        "provenance": {
            "originalLegalText": {
                "text": (clause or {}).get("clause_text") or (section or {}).get("section_text"),
                "citation": rq.get("source_clause"),
                "page": rq.get("page_number"),
                "kind": "clause" if clause else ("section" if section else None),
                "note": "Verbatim from the official document. Never rewritten.",
            },
            "extractedObligation": {
                "method": (obl or {}).get("extraction_method"),
                "confidence": (obl or {}).get("confidence"),
                "reviewStatus": (obl or {}).get("review_status"),
                "note": "System-extracted duty. Not the drafter's words.",
            },
            "derivedRequirement": {
                "method": rq.get("derivation_method"),
                "confidence": rq.get("confidence"),
                "reviewStatus": rq.get("review_status"),
                "note": "System-derived statement. Not the drafter's words.",
            },
            "aiInterpretation": None,
            "systemClassification": {"obligationType": (obl or {}).get("obligation_type")},
        },
    }


# ---------------------------------------------------------------- traceability
@router.get("/requirements/{rid}/traceability")
def requirement_traceability(rid: str):
    """
    The auditor's question, answered from persisted rows only:
    requirement → applicability → control → evidence → assessment → result.

    Every step reports its own state. A missing step is reported as MISSING
    with the reason, so the chain can never look complete when it is not.
    """
    con = _con()
    rq = _one(con, """SELECT rq.id, rq.statement, rq.source_clause, rq.regulation_id,
                             rq.obligation_id, r.title AS regulation_title
                        FROM requirements rq LEFT JOIN regulations r ON r.id = rq.regulation_id
                       WHERE rq.id = ?""", rid)
    if not rq:
        raise HTTPException(404, "no such requirement")

    instances = _rows(con, """
        SELECT cri.id AS cri_id, cri.compliance_status, cri.compliance_reason, cri.owner_id,
               ar.verdict AS applicability, ar.reason AS applicability_reason,
               ar.confidence AS applicability_confidence, ar.missing_facts
          FROM company_requirement_instances cri
          LEFT JOIN applicability_results ar ON ar.id = cri.applicability_result_id
         WHERE cri.requirement_id = ?""", rid)

    controls = _rows(con, """
        SELECT cr.id AS mapping_id, cr.control_id, cr.rationale, cr.mapped_by,
               cr.review_status, cr.relationship_type, cr.mapping_method, cr.confidence,
               cr.derived_from, c.name AS control_name, c.control_type, c.owner_id AS control_owner
          FROM control_requirements cr
          LEFT JOIN controls c ON c.id = cr.control_id
         WHERE cr.requirement_id = ?""", rid)

    for c in controls:
        c["evidence"] = _rows(con, """
            SELECT e.id, e.name, e.evidence_type, e.owner_id, e.source_system,
                   e.valid_from, e.valid_until, e.status, e.content_hash,
                   e.verification_status, e.last_verified_at,
                   ce.relationship_type, ce.mapping_method, ce.rationale AS link_rationale
              FROM control_evidence ce JOIN evidence e ON e.id = ce.evidence_id
             WHERE ce.control_id = ?""", c["control_id"])
        for e in c["evidence"]:
            if not e["valid_until"]:
                e["evidenceState"] = "NO_VALIDITY_PERIOD"
            elif e["verification_status"] == "VERIFIED":
                e["evidenceState"] = "VERIFIED"
            else:
                e["evidenceState"] = e["verification_status"] or "PENDING_REVIEW"

    assessments = _rows(con, """
        SELECT id, cri_id, control_id, result, method, rationale, evidence_considered,
               review_status, assessed_by, assessed_at
          FROM assessments WHERE requirement_id = ? ORDER BY assessed_at DESC""", rid)

    def step(name, present, detail, why_missing=None):
        return {"step": name, "state": "PRESENT" if present else "MISSING",
                "detail": detail, "reason": None if present else why_missing}

    chain = [
        step("REGULATION", bool(rq["regulation_id"]), rq["regulation_title"] or rq["regulation_id"]),
        step("CLAUSE", bool(rq["source_clause"]), rq["source_clause"], "no clause citation recorded"),
        step("OBLIGATION", bool(rq["obligation_id"]), rq["obligation_id"], "requirement has no parent obligation"),
        step("REQUIREMENT", True, rq["statement"]),
        step("APPLICABILITY", bool(instances and instances[0].get("applicability")),
             (instances[0].get("applicability") if instances else None),
             "no company requirement instance, or no applicability verdict"),
        step("CONTROL", bool(controls), f"{len(controls)} control mapping(s)",
             "no control is mapped to this requirement"),
        step("EVIDENCE", any(c["evidence"] for c in controls),
             sum(len(c["evidence"]) for c in controls),
             "no evidence proves the mapped control(s)"),
        step("ASSESSMENT", bool(assessments), (assessments[0]["result"] if assessments else None),
             "nothing has been assessed for this requirement"),
        step("COMPLIANCE_RESULT",
             bool(instances and (instances[0].get("compliance_status") or "NOT_ASSESSED") != "NOT_ASSESSED"),
             (instances[0].get("compliance_status") if instances else None),
             "compliance status is NOT_ASSESSED"),
    ]
    complete = all(s["state"] == "PRESENT" for s in chain)
    return {"requirement": rq, "instances": instances, "controls": controls,
            "assessments": assessments, "chain": chain, "chainComplete": complete,
            "note": "Every step above is a persisted row. A MISSING step is a real gap in the data."}


# ---------------------------------------------------------------- evidence
@router.get("/evidence")
def list_evidence(page: int = 1, size: int = Query(50, le=200), status: str | None = None):
    con = _con()
    where, params = ["1=1"], []
    if status:
        where.append("e.verification_status = ?"); params.append(status)
    w = " AND ".join(where)
    total = con.execute(f"SELECT COUNT(*) FROM evidence e WHERE {w}", params).fetchone()[0]
    items = _rows(con, f"""
        SELECT e.*, own.name AS owner_name,
               (SELECT COUNT(*) FROM control_evidence ce WHERE ce.evidence_id = e.id) AS control_count
          FROM evidence e LEFT JOIN company_entities own ON own.id = e.owner_id
         WHERE {w} ORDER BY e.name LIMIT ? OFFSET ?""", *params, size, (page - 1) * size)
    for e in items:
        e["evidenceState"] = ("NO_VALIDITY_PERIOD" if not e.get("valid_until")
                              else e.get("verification_status") or "PENDING_REVIEW")
    return {"page": page, "size": size, "total": total, "items": items,
            "note": "Evidence rows are migrated from the company register and uploaded "
                    "documents. None is generated."}


def _evidence_origin(con, e: dict) -> dict:
    """
    Where this evidence physically came from, resolved from the records that
    produced it — never stored twice and never guessed.

      register row  → company_entities.source_reference, e.g. "08-evidence.csv#2"
      uploaded file → company_documents.storage_path,   e.g. "09-documents/x.pdf"

    The connector supplies the root the relative path hangs off. A field that
    was never recorded comes back None so the UI can say so.
    """
    origin = {"kind": None, "file": None, "row": None, "path": None, "fullPath": None,
              "url": None, "connector": None, "connectorType": None,
              "connectorStatus": None, "rootPath": None, "originId": None,
              "documentType": None, "version": None, "approvedBy": None,
              "approvedOn": None, "uploadedAt": None, "contentHash": e.get("content_hash")}

    ref = None
    if e.get("source_document_id"):
        d = _one(con, """SELECT id, name, document_type, version, storage_path, source,
                                source_reference, content_hash, approved_by, approved_on,
                                uploaded_at
                           FROM company_documents WHERE id = ?""", e["source_document_id"])
        if d:
            origin.update(kind="document", originId=d["id"], file=d["name"],
                          path=d["storage_path"] or d["source_reference"],
                          documentType=d["document_type"], version=d["version"],
                          approvedBy=d["approved_by"], approvedOn=d["approved_on"],
                          uploadedAt=d["uploaded_at"],
                          contentHash=d["content_hash"] or e.get("content_hash"))
            ref = d["source"]
    elif e.get("source_entity_id"):
        ent = _one(con, """SELECT id, name, source, source_reference
                             FROM company_entities WHERE id = ?""", e["source_entity_id"])
        if ent:
            sr = ent["source_reference"] or ""
            # "08-evidence.csv#2" — the file, and the row inside it
            fname, _, row = sr.partition("#")
            origin.update(kind="register", originId=ent["id"], file=fname or None,
                          row=row or None, path=fname or None)
            ref = ent["source"]

    # An http(s) source_reference is a real link; a relative path is not.
    if origin["path"] and origin["path"].startswith(("http://", "https://")):
        origin["url"] = origin["path"]

    if ref and str(ref).startswith("integration:"):
        integ = _one(con, """SELECT id, connector, label, config, status
                               FROM integrations ORDER BY created_at LIMIT 1""")
        if integ:
            root = None
            try:
                import json as _json
                root = (_json.loads(integ["config"] or "{}") or {}).get("path")
            except Exception:
                root = None
            origin.update(connector=integ["label"], connectorType=integ["connector"],
                          connectorStatus=integ["status"], rootPath=root)
            if root and origin["path"]:
                origin["fullPath"] = f"{root.rstrip('/')}/{origin['path'].lstrip('/')}"
    return origin


@router.get("/controls/{cid}/evidence")
def control_evidence(cid: str):
    """What proves this control is operating — and an explicit answer when nothing does."""
    con = _con()
    ctl = _one(con, "SELECT id, name, control_type, owner_id, entity_id FROM controls WHERE id=?", cid)
    if not ctl:
        raise HTTPException(404, "no such control")
    items = _rows(con, """
        SELECT e.*, ce.relationship_type, ce.verification_status AS link_verification,
               ce.mapping_method, ce.rationale AS link_rationale, ce.verified_by, ce.verified_at
          FROM control_evidence ce JOIN evidence e ON e.id = ce.evidence_id
         WHERE ce.control_id = ? ORDER BY e.name""", cid)
    for e in items:
        e["evidenceState"] = ("NO_VALIDITY_PERIOD" if not e.get("valid_until")
                              else e.get("verification_status") or "PENDING_REVIEW")
        e["origin"] = _evidence_origin(con, e)
        if e.get("owner_id"):
            own = _one(con, "SELECT name FROM company_entities WHERE id = ?", e["owner_id"])
            e["owner_name"] = own["name"] if own else None
    return {"control": ctl, "items": items,
            "state": "MISSING" if not items else "PRESENT",
            "note": ("No evidence is linked to this control. That is a gap in the "
                     "compliance record, not a display problem." if not items else
                     "Links come from the company graph's own 'proves' edges.")}


# ---------------------------------------------------------------- assessment
@router.get("/regulations/{rid}/compliance")
def regulation_compliance(rid: str):
    """
    Assessment and compliance state for one regulation, rolled up from the
    same persisted rows the traceability view walks.

    Every bucket is a real count. Where a stage has not run, the bucket is
    named (NOT_ASSESSED, NO_EVIDENCE, INSUFFICIENT_EVIDENCE) rather than
    folded into a total that would imply coverage.
    """
    con = _con()
    reg = _one(con, "SELECT id, title, regulator_short, ingestion_status FROM regulations WHERE id=?", rid)
    if not reg:
        raise HTTPException(404, "no such regulation")

    n = lambda sql, *p: con.execute(sql, p).fetchone()[0]
    # guidebook criteria roll up under their objective element; they are not counted here
    rq_only = not_criterion("rq.id")
    req_total = n(f"SELECT COUNT(*) FROM requirements rq WHERE rq.regulation_id=? AND {rq_only}", rid)

    by_applicability = {r["verdict"]: r["n"] for r in _rows(con, f"""
        SELECT COALESCE(ar.verdict,'NOT_ASSESSED') AS verdict, COUNT(*) AS n
          FROM requirements rq
          JOIN company_requirement_instances cri ON cri.requirement_id = rq.id
          LEFT JOIN applicability_results ar ON ar.id = cri.applicability_result_id
         WHERE rq.regulation_id = ? AND {rq_only} GROUP BY 1 ORDER BY 2 DESC""", rid)}

    by_result = {r["result"]: r["n"] for r in _rows(con, f"""
        SELECT a.result, COUNT(*) AS n FROM assessments a
          JOIN requirements rq ON rq.id = a.requirement_id
         WHERE rq.regulation_id = ? AND {rq_only} GROUP BY 1 ORDER BY 2 DESC""", rid)}

    by_compliance = {r["compliance_status"]: r["n"] for r in _rows(con, f"""
        SELECT COALESCE(cri.compliance_status,'NOT_ASSESSED') AS compliance_status, COUNT(*) AS n
          FROM requirements rq
          JOIN company_requirement_instances cri ON cri.requirement_id = rq.id
         WHERE rq.regulation_id = ? AND {rq_only} GROUP BY 1 ORDER BY 2 DESC""", rid)}

    assessments = _rows(con, f"""
        SELECT a.id, a.result, a.method, a.rationale, a.review_status, a.assessed_by,
               a.assessed_at, a.evidence_considered,
               a.requirement_id, rq.statement, rq.source_clause,
               a.control_id, c.name AS control_name,
               (SELECT COUNT(*) FROM control_evidence ce WHERE ce.control_id = a.control_id) AS evidence_count
          FROM assessments a
          JOIN requirements rq ON rq.id = a.requirement_id
          LEFT JOIN controls c ON c.id = a.control_id
         WHERE rq.regulation_id = ? AND {rq_only}
         ORDER BY CASE a.result WHEN 'NO_EVIDENCE' THEN 0 WHEN 'INSUFFICIENT_EVIDENCE' THEN 1
                                WHEN 'FAILED' THEN 2 ELSE 3 END, a.assessed_at DESC
         LIMIT 200""", rid)

    assessed = sum(by_result.values())
    passed = by_result.get("PASSED", 0)
    return {
        "regulation": reg,
        "summary": {
            "requirements": req_total,
            "withApplicability": sum(v for k, v in by_applicability.items() if k != "NOT_ASSESSED"),
            "withControl": n(f"""SELECT COUNT(DISTINCT cr.requirement_id) FROM control_requirements cr
                                JOIN requirements rq ON rq.id = cr.requirement_id
                               WHERE rq.regulation_id = ? AND {rq_only}""", rid),
            "withEvidence": n(f"""SELECT COUNT(DISTINCT cr.requirement_id) FROM control_requirements cr
                                   JOIN requirements rq ON rq.id = cr.requirement_id
                                   JOIN control_evidence ce ON ce.control_id = cr.control_id
                                  WHERE rq.regulation_id = ? AND {rq_only}""", rid),
            "criteria": n(f"SELECT COUNT(*) FROM requirements rq WHERE rq.regulation_id=? AND {is_criterion('rq.id')}", rid),
            "assessed": assessed,
            "notAssessed": max(req_total - assessed, 0),
            "passed": passed,
            "compliantPct": round(100.0 * passed / req_total, 1) if req_total else 0.0,
        },
        "byApplicability": by_applicability,
        "byResult": by_result,
        "byComplianceStatus": by_compliance,
        "assessments": assessments,
        "note": ("An assessment is a RULE-derived observation, written UNREVIEWED — never a "
                 "compliance decision. PASSED is impossible unless evidence carries a validity "
                 "period, so a control with undated evidence reads INSUFFICIENT_EVIDENCE."),
    }


# ---------------------------------------------------------------- coverage
@router.get("/compliance/coverage")
def coverage():
    return _cached("coverage", 60.0, _coverage)


def _coverage():
    """
    Coverage across the whole chain, every number a live COUNT. Nothing here is
    hard-coded; the denominator is the count of mapped regulations at read time.
    """
    con = _con()
    n = lambda sql: con.execute(sql).fetchone()[0]
    total = n("SELECT COUNT(*) FROM regulations WHERE ingestion_status='MAPPED'") or 0
    pct = lambda x: round(100.0 * x / total, 1) if total else 0.0

    stages = {
        "sections": n("SELECT COUNT(DISTINCT regulation_id) FROM sections"),
        "obligations": n("SELECT COUNT(DISTINCT regulation_id) FROM obligations"),
        "requirements": n("SELECT COUNT(DISTINCT regulation_id) FROM requirements"),
        "applicabilityResults": n("SELECT COUNT(DISTINCT regulation_id) FROM applicability_results"),
        "impactRelationships": n("SELECT COUNT(DISTINCT regulation_id) FROM impact_relationships"),
        "controlMappings": n("""SELECT COUNT(DISTINCT rq.regulation_id) FROM control_requirements cr
                                JOIN requirements rq ON rq.id = cr.requirement_id"""),
        "evidence": n("""SELECT COUNT(DISTINCT rq.regulation_id)
                           FROM control_requirements cr
                           JOIN requirements rq ON rq.id = cr.requirement_id
                           JOIN control_evidence ce ON ce.control_id = cr.control_id"""),
        "assessments": n("""SELECT COUNT(DISTINCT rq.regulation_id) FROM assessments a
                              JOIN requirements rq ON rq.id = a.requirement_id"""),
    }
    # guidebook criteria are counted under their element, not as requirements
    req_total = n(f"SELECT COUNT(*) FROM requirements rq WHERE {not_criterion('rq.id')}") or 0
    rpct = lambda x: round(100.0 * x / req_total, 1) if req_total else 0.0
    cr_only = not_criterion("cr.requirement_id")

    req_with_control = n(f"SELECT COUNT(DISTINCT cr.requirement_id) FROM control_requirements cr WHERE {cr_only}")
    req_with_evidence = n(f"""SELECT COUNT(DISTINCT cr.requirement_id) FROM control_requirements cr
                               JOIN control_evidence ce ON ce.control_id = cr.control_id WHERE {cr_only}""")
    ctl_total = n("SELECT COUNT(*) FROM controls") or 0
    ctl_with_evidence = n("SELECT COUNT(DISTINCT control_id) FROM control_evidence")
    full_chain = n(f"""
        SELECT COUNT(DISTINCT cr.requirement_id)
          FROM control_requirements cr
          JOIN company_requirement_instances cri ON cri.requirement_id = cr.requirement_id
          JOIN applicability_results ar ON ar.id = cri.applicability_result_id
          JOIN control_evidence ce ON ce.control_id = cr.control_id
          JOIN assessments a ON a.requirement_id = cr.requirement_id
         WHERE {cr_only}""")

    return {
        "mappedRegulations": total,
        "byStage": {k: {"regulations": v, "pct": pct(v)} for k, v in stages.items()},
        "requirements": {
            "total": req_total,
            "withControl": {"n": req_with_control, "pct": rpct(req_with_control)},
            "withEvidence": {"n": req_with_evidence, "pct": rpct(req_with_evidence)},
            "fullChain": {"n": full_chain, "pct": rpct(full_chain)},
        },
        "controls": {"total": ctl_total, "withEvidence": ctl_with_evidence,
                     "withoutEvidence": max(ctl_total - ctl_with_evidence, 0)},
        "note": "Live counts at read time. Denominator is regulations with ingestion_status='MAPPED'.",
    }


# ---------------------------------------------------------------- source registers
@router.get("/source-registers")
def source_registers():
    """
    Curated registers loaded into the system — what a person compiled, kept as
    they compiled it, including how far they got verifying each row.
    """
    con = _con()
    regs = _rows(con, """
        SELECT register, source_file, source_sha256, MIN(imported_at) AS imported_at,
               COUNT(*) AS instruments,
               COUNT(*) FILTER (WHERE is_statute) AS statutes,
               COUNT(*) FILTER (WHERE NOT is_statute) AS not_legislation,
               COUNT(DISTINCT domain) AS domains,
               COUNT(DISTINCT portal) AS portals
          FROM source_register GROUP BY 1,2,3 ORDER BY 1""")
    for r in regs:
        r["byStatus"] = {x["status"]: x["n"] for x in _rows(con,
            """SELECT status, COUNT(*) AS n FROM source_register
                WHERE register = ? GROUP BY 1 ORDER BY 2 DESC""", r["register"])}
        r["byDomain"] = {x["domain"]: x["n"] for x in _rows(con,
            """SELECT domain, COUNT(*) AS n FROM source_register
                WHERE register = ? GROUP BY 1 ORDER BY 2 DESC""", r["register"])}
        r["resolved"] = con.execute(
            """SELECT COUNT(*) FROM source_register sr JOIN regulations g ON g.id = sr.regulation_id
                WHERE sr.register = ? AND g.ingestion_status = 'MAPPED'""",
            (r["register"],)).fetchone()[0]
    return {"registers": regs,
            "note": ("A register records ROOT PORTALS, not deep links, because deep paths on "
                     "government portals rot. Rows marked 'S' are standards or guidance, not "
                     "legislation, and are typed that way rather than filed beside statutes.")}


@router.get("/source-registers/entries")
def source_register_entries(
    page: int = 1,
    size: int = Query(50, le=200),
    register: str | None = None,
    domain: str | None = None,
    status: str | None = None,
    statutes_only: bool = False,
    q: str | None = None,
):
    con = _con()
    where, params = ["1=1"], []
    if register:
        where.append("sr.register = ?"); params.append(register)
    if domain:
        where.append("sr.domain = ?"); params.append(domain)
    if status:
        where.append("sr.status = ?"); params.append(status)
    if statutes_only:
        where.append("sr.is_statute")
    if q:
        where.append("(sr.instrument ILIKE ? OR sr.authority ILIKE ? OR sr.portal ILIKE ?)")
        params += [f"%{q}%"] * 3
    w = " AND ".join(where)
    total = con.execute(f"SELECT COUNT(*) FROM source_register sr WHERE {w}", params).fetchone()[0]
    items = _rows(con, f"""
        SELECT sr.*, g.ingestion_status, g.official_document_url
          FROM source_register sr LEFT JOIN regulations g ON g.id = sr.regulation_id
         WHERE {w} ORDER BY sr.seq LIMIT ? OFFSET ?""", *params, size, (page - 1) * size)
    return {"page": page, "size": size, "total": total, "items": items,
            "note": "Status meanings travel with each row; nothing is normalised away."}


# ---------------------------------------------------------------- regulation quality
@router.get("/regulations/quality")
def regulation_quality():
    """Regulation-side validation: coverage, lineage, defects — all real counts."""
    from .regulation_quality import report
    return _cached("reg-quality", 120.0, lambda: report(_con()))


@router.get("/regulations/{rid}/legal-chain")
def regulation_legal_chain(rid: str):
    """
    One regulation, walked the way an auditor reads it: source document,
    version, structure, then each legal object with the clause it came from.

    Counts and samples are joined from persisted rows. Any layer that is empty
    is returned as an empty list with a reason, never omitted — omitting it
    would let the caller assume the layer does not apply.
    """
    con = _con()
    # Phase 4: every field the regulatory model asks a source document to keep.
    reg = _one(con, """SELECT id, title, short_title, regulator, regulator_short,
                              regulation_type, reference_number, notification_number,
                              circular_number, jurisdiction, country, state, sector,
                              issuing_authority, issuing_department, legal_authority,
                              enabling_act, enabling_section, issued_on, published_date,
                              effective_from, effective_basis, effective_evidence,
                              last_updated, current_version, status, ingestion_status,
                              source_url, official_document_url, document_id,
                              source_verified, verified_at, last_verified_at, language
                         FROM regulations WHERE id = ?""", rid)
    if not reg:
        raise HTTPException(404, "no such regulation")

    doc = _one(con, """SELECT id, file_name, file_type, file_size, source_url, storage_path,
                              document_hash, page_count, extraction_method, ocr_used,
                              extraction_status, created_at AS retrieved_at
                         FROM documents WHERE regulation_id = ?
                        ORDER BY created_at DESC LIMIT 1""", rid)
    versions = _rows(con, """SELECT id, captured_at, document_hash, content_hash, page_count,
                                    section_count, source_url, retrieved_at
                               FROM document_versions WHERE regulation_id = ?
                              ORDER BY captured_at DESC LIMIT 10""", rid)

    n = lambda sql: con.execute(sql, (rid,)).fetchone()[0]
    layers = {
        "sections": n("SELECT COUNT(*) FROM sections WHERE regulation_id=?"),
        "clauses": n("SELECT COUNT(*) FROM clauses WHERE regulation_id=?"),
        "obligations": n("SELECT COUNT(*) FROM obligations WHERE regulation_id=?"),
        "requirements": n("SELECT COUNT(*) FROM requirements WHERE regulation_id=?"),
        "definitions": n("SELECT COUNT(*) FROM definitions WHERE regulation_id=?"),
        "penalties": n("SELECT COUNT(*) FROM penalty_provisions WHERE regulation_id=?"),
        "crossReferences": n("SELECT COUNT(*) FROM cross_references WHERE source_regulation_id=?"),
        "tables": n("SELECT COUNT(*) FROM regulation_tables WHERE regulation_id=?"),
        "amendments": n("SELECT COUNT(*) FROM regulation_amendments WHERE regulation_id=?"),
        "changes": n("SELECT COUNT(*) FROM section_changes WHERE regulation_id=?"),
        "provenanceRecords": n("SELECT COUNT(*) FROM verification_records WHERE regulation_id=?"),
        "conditions": n("""SELECT COUNT(*) FROM provision_conditions pc
                             JOIN legal_provisions lp ON lp.id = pc.provision_id
                            WHERE lp.regulation_id = ?"""),
        "exceptions": n("""SELECT COUNT(*) FROM provision_exceptions pe
                             JOIN legal_provisions lp ON lp.id = pe.provision_id
                            WHERE lp.regulation_id = ?"""),
        "thresholds": n("""SELECT COUNT(*) FROM thresholds t
                             JOIN legal_provisions lp ON lp.id = t.provision_id
                            WHERE lp.regulation_id = ?"""),
        "timingRules": n("""SELECT COUNT(*) FROM timing_rules tr
                              JOIN legal_provisions lp ON lp.id = tr.provision_id
                             WHERE lp.regulation_id = ?"""),
        "reportingObligations": n(
            "SELECT COUNT(*) FROM obligations WHERE regulation_id=? AND obligation_type='REPORTING'"),
        "recordKeepingObligations": n(
            "SELECT COUNT(*) FROM obligations WHERE regulation_id=? AND obligation_type='DOCUMENTATION'"),
    }

    amendments = _rows(con, """SELECT id, section_number, action, meaning, instrument,
                                      reference, amended_on, url, extraction_method, raw
                                 FROM regulation_amendments WHERE regulation_id = ?
                                ORDER BY amended_on DESC NULLS LAST LIMIT 25""", rid)
    changes = _rows(con, """SELECT id, section_number, change_type, words_added, words_removed,
                                   detected_at FROM section_changes WHERE regulation_id = ?
                             ORDER BY detected_at DESC LIMIT 15""", rid)

    return {"regulation": reg, "sourceDocument": doc, "versions": versions,
            "layers": layers, "amendments": amendments, "changes": changes,
            "note": ("A zero layer means the extractor found nothing in this document, "
                     "not that the concept does not apply. Source document and hash are "
                     "recorded at fetch time and never regenerated.")}


# ---------------------------------------------------------------- data quality
@router.get("/compliance/data-quality")
def data_quality():
    """Named defects with counts and a sample, so each can be worked, not guessed at."""
    con = _con()
    checks = {
        "requirementsWithoutObligation":
            "SELECT COUNT(*) FROM requirements WHERE obligation_id IS NULL OR obligation_id=''",
        "requirementsWithOrphanObligation":
            """SELECT COUNT(*) FROM requirements rq WHERE rq.obligation_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM obligations o WHERE o.id = rq.obligation_id)""",
        "requirementsWithoutSourceClause":
            "SELECT COUNT(*) FROM requirements WHERE source_clause IS NULL OR source_clause=''",
        "obligationsWithoutClause":
            "SELECT COUNT(*) FROM obligations WHERE clause_id IS NULL OR clause_id=''",
        "obligationsWithoutSection":
            "SELECT COUNT(*) FROM obligations WHERE section_id IS NULL OR section_id=''",
        "requirementsWithoutControl":
            """SELECT COUNT(*) FROM requirements rq WHERE NOT EXISTS
               (SELECT 1 FROM control_requirements cr WHERE cr.requirement_id = rq.id)""",
        "controlsWithoutRequirement":
            """SELECT COUNT(*) FROM controls c WHERE NOT EXISTS
               (SELECT 1 FROM control_requirements cr WHERE cr.control_id = c.id)""",
        "controlsWithoutEvidence":
            """SELECT COUNT(*) FROM controls c WHERE NOT EXISTS
               (SELECT 1 FROM control_evidence ce WHERE ce.control_id = c.id)""",
        "evidenceWithoutControl":
            """SELECT COUNT(*) FROM evidence e WHERE NOT EXISTS
               (SELECT 1 FROM control_evidence ce WHERE ce.evidence_id = e.id)""",
        "evidenceWithoutValidityPeriod":
            "SELECT COUNT(*) FROM evidence WHERE valid_until IS NULL",
        "evidenceExpired":
            "SELECT COUNT(*) FROM evidence WHERE valid_until IS NOT NULL AND valid_until < now()::text",
        "evidenceWithoutHash":
            "SELECT COUNT(*) FROM evidence WHERE content_hash IS NULL OR content_hash=''",
        "controlMappingsUnreviewed":
            "SELECT COUNT(*) FROM control_requirements WHERE review_status='UNREVIEWED'",
        "controlMappingsWithoutRationale":
            "SELECT COUNT(*) FROM control_requirements WHERE rationale IS NULL OR rationale=''",
        "duplicateControlMappings":
            """SELECT COALESCE(SUM(c-1),0) FROM (SELECT COUNT(*) c FROM control_requirements
               GROUP BY control_id, requirement_id HAVING COUNT(*)>1) d""",
        "assessmentsUnreviewed":
            "SELECT COUNT(*) FROM assessments WHERE review_status='UNREVIEWED'",
        # control_requirements FK-cascades on requirement_id, so a chain that
        # rebuilds requirements without re-running the wiring leaves assessments
        # pointing at mappings that no longer exist. This is that alarm.
        "assessmentsWithoutMapping":
            """SELECT COUNT(*) FROM assessments a WHERE NOT EXISTS
               (SELECT 1 FROM control_requirements cr
                 WHERE cr.requirement_id = a.requirement_id AND cr.control_id = a.control_id)""",
        "assessmentsWithOrphanRequirement":
            """SELECT COUNT(*) FROM assessments a WHERE NOT EXISTS
               (SELECT 1 FROM requirements rq WHERE rq.id = a.requirement_id)""",
        "criWithoutApplicabilityResult":
            "SELECT COUNT(*) FROM company_requirement_instances WHERE applicability_result_id IS NULL",
        "criNotAssessed":
            "SELECT COUNT(*) FROM company_requirement_instances WHERE compliance_status='NOT_ASSESSED'",
    }
    out, failing = {}, 0
    for name, sql in checks.items():
        try:
            v = con.execute(sql).fetchone()[0]
        except Exception as e:  # noqa: BLE001 — a broken check must not hide the rest
            out[name] = {"error": f"{type(e).__name__}"}
            continue
        out[name] = {"count": v}
        failing += 1 if v else 0
    return {"checks": out, "checksWithFindings": failing,
            "note": "A non-zero count is a real gap in the compliance record, not a bug."}
