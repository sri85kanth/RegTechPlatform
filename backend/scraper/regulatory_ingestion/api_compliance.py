"""
Company compliance: what each requirement means for THIS company.

THE BOUNDARY, ENFORCED AT THE API
---------------------------------
/api/regulation/{id} returns regulatory fact and nothing else. This router
returns company state and nothing else. A screen that needs both makes two
calls, and the join happens in the reader's head — which is exactly where a
compliance officer needs to see the seam between "the regulator said" and
"we have assessed".

Every row here is read through v_company_requirements, so the applicability it
shows is the applicability_results row, never a copy. Compliance status is the
derived value with its reason; the reason is returned because a status without
one is a shrug.
"""
from __future__ import annotations

import json
from fastapi import APIRouter, Depends, Query
from .api_auth import require

from .criteria import finding_not_criterion, not_criterion
from .db import connect

router = APIRouter(prefix="/api/compliance", tags=["compliance"],
                   # every route here served company data to anyone —
                   # the login page gated the UI, not the API
                   dependencies=[Depends(require("read"))])

_REACHES = ("APPLICABLE", "CONDITIONAL")

# The plain-language area each entity family is filed under, mirrored from
# propose_controls.py so a control lands on the card for the fact that earned it.
_AREA_OF = {
    "hospital": "Clinical establishment", "pharmacy": "Pharmacy and drugs",
    "genetic clinic": "PCPNDT and imaging", "waste generator": "Biomedical waste",
    "employer": "Workforce", "food business operator": "Food safety",
    "data fiduciary": "Personal data", "building occupier": "Building and fire safety",
    "approved place": "MTP services", "principal employer": "Contract labour",
    "laboratory": "Laboratory", "blood centre": "Blood centre",
    "practitioner": "Clinical practitioners", "licensee": "Licensed activity",
    "radiation": "Radiation safety", "occupier": "Premises",
}


@router.get("/summary")
def summary():
    """The funnel, so the dashboard can say how far the chain actually runs."""
    con = connect()
    one = lambda q, *p: con.execute(q, p).fetchone()[0]
    # guidebook criteria roll up under their objective element; none of these counts include them
    rq_only = not_criterion("requirement_id")
    reach = one(f"SELECT count(*) FROM v_company_requirements WHERE applicability IN (?,?) AND {rq_only}", *_REACHES)
    return {
        "instances": one(f"SELECT count(*) FROM company_requirement_instances WHERE {rq_only}"),
        "reachCompany": reach,
        "byApplicability": {r[0] or "UNASSESSED": r[1] for r in con.execute(
            f"SELECT applicability, count(*) FROM v_company_requirements WHERE {rq_only} GROUP BY 1")},
        "byCompliance": {r[0]: r[1] for r in con.execute(
            f"SELECT compliance_status, count(*) FROM v_company_requirements WHERE {rq_only} GROUP BY 1")},
        "controls": {
            "links": one(f"SELECT count(*) FROM control_requirements WHERE {rq_only}"),
            "approved": one(f"SELECT count(*) FROM control_requirements "
                            f"WHERE review_status IN ('ACCEPTED','APPROVED') AND {rq_only}"),
            "instancesWithAnyControl": one(
                f"SELECT count(DISTINCT cri_id) FROM control_requirements WHERE cri_id IS NOT NULL AND {rq_only}"),
        },
        "evidence": one("SELECT count(*) FROM evidence"),
        "tests": one("SELECT count(*) FROM compliance_tests"),
        "findings": one(f"SELECT count(*) FROM findings f WHERE f.status<>'CLOSED' AND {finding_not_criterion('f')}"),
        # Derived, never asserted. This was a constant claiming nothing was
        # approved and no evidence existed, and it kept saying so after both
        # became false — the UI contradicted the numbers printed beside it.
        "note": _note(one),
    }



def _note(one) -> str:
    """Name the first missing link in control -> evidence -> test, from the data."""
    approved = one("SELECT count(*) FROM control_requirements "
                   "WHERE review_status IN ('ACCEPTED','APPROVED')")
    evidence = one("SELECT count(*) FROM evidence")
    tests = one("SELECT count(*) FROM compliance_tests")
    compliant = one("SELECT count(*) FROM company_requirement_instances "
                    "WHERE compliance_status = 'COMPLIANT'")
    if not approved:
        return ("Compliance is derived from approved control -> evidence -> test. "
                "No control has been approved, so every instance is NOT_ASSESSED.")
    if not evidence:
        return (f"{approved:,} control links are approved but no evidence is recorded, "
                "so those instances are EVIDENCE_MISSING.")
    if not tests:
        return (f"{approved:,} control links are approved and {evidence:,} evidence items "
                "are recorded, but nothing has been tested yet.")
    return (f"{approved:,} approved control links, {evidence:,} evidence items, "
            f"{tests:,} tests run, {compliant:,} duties COMPLIANT. Every other status "
            "names the first missing link in control -> evidence -> test.")

_SEV_RANK = ("CASE upper(coalesce({col},'')) WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 "
             "WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END")


@router.get("/requirements")
def requirements(
    regulation_id: str | None = None,
    applicability: str | None = Query(None, description="APPLICABLE|CONDITIONAL|NOT_APPLICABLE|REVIEW_REQUIRED|reach"),
    compliance: str | None = None,
    q: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(25, ge=1, le=200),
):
    con = connect()
    # guidebook criteria are shown under their objective element, not as rows here
    where, params = [not_criterion("v.requirement_id")], []
    if regulation_id:
        where.append("v.regulation_id = ?"); params.append(regulation_id)
    if applicability == "reach":
        where.append("v.applicability IN (?,?)"); params.extend(_REACHES)
    elif applicability:
        where.append("v.applicability = ?"); params.append(applicability)
    if compliance:
        where.append("v.compliance_status = ?"); params.append(compliance)
    if q:
        where.append("v.statement ILIKE ?"); params.append(f"%{q}%")
    w = ("WHERE " + " AND ".join(where)) if where else ""

    total = con.execute(f"SELECT count(*) FROM v_company_requirements v {w}", params).fetchone()[0]
    rows = con.execute(f"""
        SELECT v.*, r.title AS regulation_title, r.regulator_short,
               (SELECT count(*) FROM control_requirements cr WHERE cr.cri_id = v.cri_id) AS control_links,
               (SELECT count(*) FROM control_requirements cr WHERE cr.cri_id = v.cri_id
                  AND cr.review_status IN ('ACCEPTED','APPROVED')) AS controls_approved,
               (SELECT string_agg(c.name, ' · ') FROM control_requirements cr
                  JOIN controls c ON c.id = cr.control_id WHERE cr.cri_id = v.cri_id) AS control_names,
               (SELECT count(*) FROM evidence_links el
                 WHERE el.requirement_id = v.requirement_id
                    OR el.control_id IN (SELECT cr.control_id
                                           FROM control_requirements cr
                                          WHERE cr.cri_id = v.cri_id)) AS evidence_links,
               (SELECT count(*) FROM compliance_tests t WHERE t.cri_id = v.cri_id) AS tests,
               (SELECT count(*) FROM findings f WHERE f.cri_id = v.cri_id AND f.status <> 'CLOSED') AS open_findings,
               -- the worst open finding: its risk band and what is missing, so the
               -- list says what the gap is without opening each row
               fw.severity AS risk, fw.title AS gap
          FROM v_company_requirements v
          JOIN regulations r ON r.id = v.regulation_id
          -- one pass over the few thousand open findings, hash-joined, instead of
          -- a per-row lookup across all 255k requirements the sort has to visit
          LEFT JOIN (
               SELECT DISTINCT ON (f.cri_id) f.cri_id, f.severity, f.title FROM findings f
                WHERE f.status <> 'CLOSED'
                ORDER BY f.cri_id, {_SEV_RANK.format(col='f.severity')}) fw ON fw.cri_id = v.cri_id
          {w}
         -- what needs action first: requirements that reach us, unmet before met,
         -- critical before low; regulation and clause keep the order stable
         ORDER BY (v.applicability IN ('APPLICABLE','CONDITIONAL')) DESC,
                  CASE v.compliance_status WHEN 'NON_COMPLIANT' THEN 0 WHEN 'PARTIALLY_COMPLIANT' THEN 1
                       WHEN 'EVIDENCE_MISSING' THEN 2 WHEN 'NOT_TESTED' THEN 3 WHEN 'NOT_ASSESSED' THEN 4
                       WHEN 'REVIEW_REQUIRED' THEN 5 WHEN 'COMPLIANT' THEN 6 ELSE 7 END,
                  {_SEV_RANK.format(col='fw.severity')},
                  v.regulation_id, v.source_clause
         LIMIT ? OFFSET ?
    """, (*params, size, (page - 1) * size)).fetchall()

    return {"page": page, "size": size, "total": total,
            "items": [dict(r) for r in rows]}


@router.get("/requirements/{cri_id}")
def requirement(cri_id: str):
    """One instance with the whole chain, and the scopes it has been asked about."""
    con = connect()
    v = con.execute("SELECT * FROM v_company_requirements WHERE cri_id=?", (cri_id,)).fetchone()
    if not v:
        return {"found": False}
    d = dict(v)
    d["checks"] = con.execute(
        "SELECT checks FROM applicability_results ar JOIN company_requirement_instances cri "
        "ON cri.applicability_result_id = ar.id WHERE cri.id=?", (cri_id,)).fetchone()
    d["checks"] = d["checks"][0] if d["checks"] else None
    d["scopes"] = [dict(r) for r in con.execute(
        "SELECT scope_type, scope_label, applicability_status, reason "
        "FROM company_requirement_scopes WHERE cri_id=? ORDER BY scope_type, scope_label", (cri_id,))]
    d["controls"] = [dict(r) for r in con.execute(
        "SELECT cr.id, c.name, cr.review_status, cr.rationale, cr.derived_from "
        "FROM control_requirements cr JOIN controls c ON c.id=cr.control_id WHERE cr.cri_id=?", (cri_id,))]
    d["tests"] = [dict(r) for r in con.execute(
        "SELECT id, result, performed_by, performed_at FROM compliance_tests WHERE cri_id=?", (cri_id,))]
    d["findings"] = [dict(r) for r in con.execute(
        "SELECT id, severity, title, status FROM findings WHERE cri_id=?", (cri_id,))]
    return {"found": True, **d}


@router.get("/by-fact")
def by_fact(limit: int = Query(12, ge=1, le=100)):
    """
    Which fact about this company brings each regulation onto it.

    The answer to "why does this apply to us" is already inside the verdict —
    the entity-type check records the family it matched and the profile field,
    licence or headcount it came from. This groups the verdicts by that origin.
    Nothing is recomputed: the sentence on this screen is the sentence on the
    regulation page, so the two can never disagree.
    """
    con = connect()
    prof = con.execute("SELECT sectors FROM company_profile ORDER BY id LIMIT 1").fetchone()
    try:
        sectors = json.loads((prof[0] if prof else None) or "[]")
    except (TypeError, ValueError):
        sectors = []
    # Our own sector first, then by weight. Ordering by weight alone put "NSE on
    # Trading Holidays for Calendar Year 2026" — a holiday list whose rows became
    # 967 "duties" — at the top of a hospital's page, ahead of the health
    # instruments that actually explain why the regulation reaches us.
    rows = con.execute(f"""
        SELECT r.id, r.title, r.regulator_short, ar.verdict, ar.checks,
               (SELECT s2.score FROM impact_scores s2 WHERE s2.regulation_id = r.id) AS impact,
               (SELECT COUNT(*) FROM company_requirement_instances cri
                 WHERE cri.applicability_result_id = ar.id AND {not_criterion('cri.requirement_id')}) AS requirements
          FROM applicability_results ar
          JOIN regulations r ON r.id = ar.regulation_id
         WHERE ar.verdict IN ('APPLICABLE','CONDITIONAL')
         ORDER BY (r.sector = ANY(?::text[])) DESC NULLS LAST, 6 DESC""",
        (sectors,)).fetchall()

    facts: dict[str, dict] = {}
    unattributed = 0
    for row in rows:
        d = dict(row)
        origin = family = None
        for c in json.loads(d.get("checks") or "[]"):
            if c.get("name") == "Entity type" and c.get("result") == "MATCH":
                origin, family = c.get("origin"), c.get("family")
                break
        if not origin:
            # An umbrella match ("Regulated Entities") names no fact of ours.
            unattributed += 1
            continue
        f = facts.setdefault(origin, {"fact": origin, "family": family,
                                      "regulations": 0, "requirements": 0, "examples": []})
        f["regulations"] += 1
        f["requirements"] += d["requirements"] or 0
        f.setdefault("_regs", []).append(d["id"])
        if len(f["examples"]) < limit:
            f["examples"].append({"id": d["id"], "title": d["title"],
                                  "regulator": d["regulator_short"],
                                  "verdict": d["verdict"],
                                  "impact": d["impact"],
                                  "requirements": d["requirements"] or 0})

    # The controls proposed for each fact, with the duty count and the role that
    # would own it. Grouped by the same family the verdict matched, so a card
    # reads as one thing: what we are, what reaches us, who would answer for it.
    for row in con.execute("""
        SELECT c.id, c.name, c.control_type, c.owner_id, e.name AS owner,
               d.name AS department, COUNT(cr.id) AS duties,
               COUNT(*) FILTER (WHERE cr.review_status <> 'UNREVIEWED') AS reviewed
          FROM controls c
          LEFT JOIN company_entities e ON e.id = c.owner_id
          LEFT JOIN company_entities d ON d.id = c.entity_id
          LEFT JOIN control_requirements cr ON cr.control_id = c.id
         WHERE c.id LIKE 'ctl-%'
         GROUP BY 1,2,3,4,5,6 ORDER BY 7 DESC""").fetchall():
        d = dict(row)
        # "ctl-<family slug>-<type slug>" — the family is how it was grouped
        area = (d["name"] or "").split(" — ")[0]
        for f in facts.values():
            if _AREA_OF.get(f.get("family")) == area:
                f.setdefault("controls", []).append({
                    "id": d["id"], "name": d["name"], "type": d["control_type"],
                    "owner": d["owner"], "department": d["department"],
                    "duties": d["duties"] or 0,
                    "reviewed": bool(d["reviewed"]),
                })

    # What each fact puts at risk, not only how many duties it carries: the
    # impact engine's own links from a regulation's text to the equipment,
    # departments and records this company holds.
    all_regs = sorted({r for f in facts.values() for r in f.get("_regs", [])})
    touches: dict[str, list] = {}
    if all_regs:
        for ir in con.execute(
                "SELECT regulation_id, company_brain_entity_id, entity_name, entity_domain "
                "FROM impact_relationships WHERE regulation_id = ANY(?::text[])",
                (all_regs,)).fetchall():
            d = dict(ir)
            touches.setdefault(d["regulation_id"], []).append(
                (d["company_brain_entity_id"], d["entity_name"], d["entity_domain"]))

    out = sorted(facts.values(), key=lambda f: -f["regulations"])
    for f in out:
        f.setdefault("controls", [])
        seen, by_domain, names = set(), {}, []
        for rid in f.pop("_regs", []):
            for eid, name, domain in touches.get(rid, []):
                if eid in seen:
                    continue
                seen.add(eid)
                by_domain[domain] = by_domain.get(domain, 0) + 1
                if len(names) < 8 and name:
                    names.append(name)
        f["touches"] = {"records": len(seen), "byDomain": by_domain, "examples": names}
    return {
        "company": (con.execute("SELECT legal_name FROM company_profile ORDER BY id LIMIT 1")
                    .fetchone() or ["—"])[0],
        "regulations": len(rows),
        "requirements": sum(f["requirements"] for f in out),
        "facts": out,
        # Stated rather than hidden: these reach us as "Regulated Entities",
        # which names no fact of ours to group them under.
        "notAttributed": unattributed,
    }
