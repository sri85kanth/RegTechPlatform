"""
The regulation detail tabs: Impact, Controls, Updates and the Full Text outline.

THE SEAM IS KEPT
----------------
`/regulation/{id}` states what the regulator wrote. Everything in this module is
what THIS COMPANY'S engine inferred about it — a score, a control, a verdict.
They are different claims with different reliability, so they are served from
separate endpoints and the UI labels them as ours, not the regulator's.

NO DIMENSION IS INVENTED
------------------------
The impact score is read from impact_scores.factors, which records the real
formula — gross exposure, severity, likelihood, a deadline multiplier and
mitigation coverage, producing an inherent and a residual score. Anything the
factors do not contain is returned null and the UI omits that panel. A score
presented without its inputs is a number nobody can argue with, which is the
opposite of useful.
"""
from __future__ import annotations

import json
from fastapi import APIRouter, Depends, HTTPException, Query

from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/regulation", tags=["regulation-tabs"],
                   dependencies=[Depends(require("read"))])


def _rows(con, sql, params=()):
    return [dict(r) for r in con.execute(sql, params).fetchall()]


def _one(con, sql, params=()):
    r = con.execute(sql, params).fetchone()
    return (list(r.values())[0] if hasattr(r, "values") else r[0]) if r else 0


def _json(raw):
    try:
        return json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}


# --------------------------------------------------------------- the header
@router.get("/{rid}/header")
def header(rid: str):
    con = connect()
    r = con.execute("SELECT * FROM regulations WHERE id = ?", (rid,)).fetchone()
    if not r:
        raise HTTPException(404, "no such regulation")
    g = dict(r)

    verdict = con.execute(
        "SELECT verdict, confidence, reason FROM applicability_results WHERE regulation_id = ?",
        (rid,)).fetchone()

    counts = {
        "sections": _one(con, "SELECT COUNT(*) FROM sections WHERE regulation_id = ?", (rid,)),
        "obligations": _one(con, "SELECT COUNT(*) FROM obligations WHERE regulation_id = ?", (rid,)),
        "requirements": _one(con, "SELECT COUNT(*) FROM requirements WHERE regulation_id = ?", (rid,)),
        "controls": _one(con, """SELECT COUNT(DISTINCT cr.control_id)
                                   FROM control_requirements cr
                                   JOIN requirements q ON q.id = cr.requirement_id
                                  WHERE q.regulation_id = ?""", (rid,)),
        "updates": _one(con, "SELECT COUNT(*) FROM section_changes WHERE regulation_id = ?", (rid,)),
    }
    return {
        "id": g["id"], "title": g["title"], "shortTitle": g.get("short_title"),
        "regulator": g.get("regulator"), "regulatorShort": g.get("regulator_short"),
        "type": g.get("regulation_type"), "jurisdiction": g.get("jurisdiction"),
        "country": g.get("country"), "state": g.get("state"),
        "sector": g.get("sector"), "status": g.get("status"),
        "effectiveFrom": g.get("effective_from"), "issuedOn": g.get("issued_on"),
        "lastUpdated": g.get("last_updated") or g.get("updated_at"),
        "version": g.get("current_version"),
        "sourceUrl": g.get("source_url") or g.get("official_document_url"),
        "applicability": dict(verdict) if verdict else None,
        "counts": counts,
    }


# --------------------------------------------------------- the applicability
@router.get("/{rid}/applicability")
def applicability(rid: str):
    """
    The engine's own working, as it recorded it.

    `applicability_results.checks` already holds a row per criterion — what was
    expected, what this company has, where in the instrument it was found, and
    the verdict. Rendering it unchanged is the point: a screen that restates the
    conclusion without the criteria is the screen an auditor cannot use.

    UNKNOWN is reported as UNKNOWN, never folded into "not met". The engine does
    not extract thresholds or exemptions from regulation text, so those two are
    unknown on every regulation in the corpus — a limitation of ours, not a
    finding about the company.
    """
    con = connect()
    a = con.execute("""SELECT verdict, confidence, reason, checks, missing_facts,
                              engine_version, computed_at
                         FROM applicability_results WHERE regulation_id = ?""",
                    (rid,)).fetchone()
    if not a:
        return {"assessed": False, "checks": [], "summary": None}
    row = dict(a)
    checks = _json(row.get("checks")) or []
    missing = _json(row.get("missing_facts")) or []

    tally = {"MATCH": 0, "NO_MATCH": 0, "UNKNOWN": 0}
    for c in checks:
        tally[c.get("result", "UNKNOWN")] = tally.get(c.get("result", "UNKNOWN"), 0) + 1

    # The rules this regulation carries, so "who it covers" sits beside the test.
    addressees = _rows(con, """
        SELECT entity_type, role, confidence, applicability_rule
          FROM applicability_rules WHERE regulation_id = ?
         ORDER BY CASE WHEN role LIKE 'ADDRESSEE%' THEN 0 ELSE 1 END LIMIT 12""", (rid,))

    # The company facts each passing check rested on — the "evidence for
    # applicability" a reviewer asks for. Taken from the check's own `origin`,
    # so it cites what the engine actually used rather than the whole profile.
    evidence_for = []
    seen = set()
    for c in checks:
        if c.get("result") != "MATCH":
            continue
        # Most checks record the company fact in `origin`; the rest carry it in
        # `found`. Falling back keeps every satisfied criterion citable instead
        # of showing one row because only one check happens to set `origin`.
        found = c.get("found")
        if isinstance(found, list):
            found = ", ".join(str(x) for x in found if x)
        origin = (c.get("origin") or "").strip() or (str(found or "").strip())
        key = f'{c.get("name")}|{origin}'
        if not origin or key in seen:
            continue
        seen.add(key)
        evidence_for.append({
            "check": c.get("name"),
            "origin": origin,
            "found": found,
            "family": c.get("family"),
            "sourceClause": c.get("sourceClause"),
        })

    # Duties inside this instrument that the engine evaluated and ruled out.
    # read through v_company_requirements: a NOT_APPLICABLE counts only where the
    # requirement's own verdict agrees
    not_applicable = _one(con, """
        SELECT COUNT(*) FROM v_company_requirements
         WHERE regulation_id = ? AND compliance_status = 'NOT_APPLICABLE'""", (rid,))
    owed = _one(con, """
        SELECT COUNT(*) FROM v_company_requirements
         WHERE regulation_id = ? AND compliance_status <> 'NOT_APPLICABLE'""", (rid,))

    return {
        "assessed": True,
        "evidenceFor": evidence_for,
        "dutiesOwed": owed,
        "dutiesRuledOut": not_applicable,
        "verdict": row.get("verdict"),
        "confidence": row.get("confidence"),
        "reason": row.get("reason"),
        "engineVersion": row.get("engine_version"),
        "computedAt": row.get("computed_at"),
        "checks": checks,
        "missingFacts": missing,
        "summary": {"total": len(checks), **tally},
        "addressees": addressees,
    }


# ---------------------------------------------------------------- the impact
@router.get("/{rid}/impact")
def impact(rid: str):
    con = connect()
    s = con.execute("SELECT * FROM impact_scores WHERE regulation_id = ?", (rid,)).fetchone()
    score = dict(s) if s else None
    factors = _json(score.get("factors")) if score else {}

    # What the engine says it weighed. Only keys actually present are returned,
    # so a missing input shows as a missing row rather than a zero.
    drivers = []
    for key, label in (("gross_exposure", "Gross exposure"),
                       ("obligations", "Obligations in this instrument")):
        if factors.get(key) is not None:
            drivers.append({"key": key, "label": label, "value": factors[key], "kind": "count"})
    for key, label in (("severity", "Severity"), ("likelihood", "Likelihood")):
        f = factors.get(key) or {}
        if f.get("factor") is not None:
            drivers.append({"key": key, "label": label, "value": f["factor"],
                            "note": f.get("from"), "kind": "factor"})
    dl = factors.get("deadline") or {}
    if dl.get("multiplier") is not None:
        drivers.append({"key": "deadline", "label": "Deadline pressure",
                        "value": dl["multiplier"], "note": dl.get("why"), "kind": "factor"})
    mit = factors.get("mitigation") or {}
    if mit.get("coverage") is not None:
        drivers.append({"key": "mitigation", "label": "Mitigation coverage",
                        "value": mit["coverage"], "kind": "ratio",
                        "note": f"{mit.get('covered_entities', 0)} of "
                                f"{mit.get('surface_entities', 0)} affected entities covered"})

    # Everything this regulation touches, by the domain it touches.
    by_domain = _rows(con, """
        SELECT entity_domain AS domain, COUNT(*) AS n,
               COUNT(DISTINCT company_brain_entity_id) AS entities
          FROM impact_relationships WHERE regulation_id = ?
         GROUP BY 1 ORDER BY n DESC""", (rid,))

    touched = _rows(con, """
        SELECT entity_name, entity_domain, relationship_type, confidence, match_reason
          FROM impact_relationships WHERE regulation_id = ?
         ORDER BY confidence DESC NULLS LAST LIMIT 12""", (rid,))

    # Departments reached, through the controls that cover this regulation's duties.
    departments = _rows(con, """
        SELECT COALESCE(o.name, '(unassigned)') AS department,
               COUNT(DISTINCT cr.requirement_id) AS requirements,
               COUNT(DISTINCT c.id) AS controls
          FROM control_requirements cr
          JOIN requirements q ON q.id = cr.requirement_id
          JOIN controls c ON c.id = cr.control_id
          LEFT JOIN company_entities e ON e.id = c.entity_id
          LEFT JOIN org_nodes o ON o.id = e.org_node_id
         WHERE q.regulation_id = ?
         GROUP BY 1 ORDER BY requirements DESC LIMIT 10""", (rid,))

    # Open risks on the controls that cover this regulation.
    risks = _rows(con, """
        SELECT DISTINCT e.id, e.name, e.criticality, e.status
          FROM control_requirements cr
          JOIN requirements q ON q.id = cr.requirement_id
          JOIN controls c ON c.id = cr.control_id
          JOIN company_entities e ON e.owner_id = c.owner_id AND e.domain = 'risks'
         WHERE q.regulation_id = ? LIMIT 8""", (rid,))
    if not risks:
        risks = _rows(con, """SELECT id, name, criticality, status FROM company_entities
                               WHERE domain = 'risks' AND status <> 'Closed' LIMIT 6""")

    # The duties with the most control attention — a real proxy for "high impact".
    top_reqs = _rows(con, """
        SELECT q.id, LEFT(q.statement, 160) AS statement, q.source_clause,
               COUNT(DISTINCT cr.control_id) AS controls,
               COALESCE(i.compliance_status, 'NOT_ASSESSED') AS status
          FROM requirements q
          LEFT JOIN control_requirements cr ON cr.requirement_id = q.id
          LEFT JOIN company_requirement_instances i ON i.requirement_id = q.id
         WHERE q.regulation_id = ?
         GROUP BY q.id, q.statement, q.source_clause, i.compliance_status
         ORDER BY controls DESC, q.source_clause LIMIT 10""", (rid,))

    return {
        "hasScore": score is not None,
        "score": score.get("score") if score else None,
        "level": score.get("level") if score else None,
        "computedAt": score.get("computed_at") if score else None,
        "inherent": factors.get("inherentScore"),
        "residual": factors.get("residualScore"),
        "confidence": factors.get("confidence"),
        "confidenceSignals": factors.get("confidenceSignals") or {},
        "reachesCompany": factors.get("reachesCompany"),
        "applicability": factors.get("applicability"),
        "formula": factors.get("formula"),
        "drivers": drivers,
        "affectedByDomain": factors.get("affected_by_domain") or {},
        "relationshipsByDomain": by_domain,
        "touchedEntities": touched,
        "departments": departments,
        "risks": risks,
        "topRequirements": top_reqs,
    }


# -------------------------------------------------------------- the controls
@router.get("/{rid}/controls")
def controls(rid: str, page: int = Query(1, ge=1), size: int = Query(25, ge=1, le=200),
             q: str | None = None):
    con = connect()
    where, params = ["qq.regulation_id = ?"], [rid]
    if q:
        where.append("(c.name ILIKE ? OR c.description ILIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    w = " AND ".join(where)

    total = _one(con, f"""SELECT COUNT(DISTINCT c.id)
                            FROM control_requirements cr
                            JOIN requirements qq ON qq.id = cr.requirement_id
                            JOIN controls c ON c.id = cr.control_id
                           WHERE {w}""", tuple(params))

    items = _rows(con, f"""
        SELECT c.id, c.name, c.description, c.control_type, c.frequency,
               c.owner_id, c.effectiveness, c.last_tested, c.next_test_due,
               COALESCE(o.name, '') AS department,
               COUNT(DISTINCT cr.requirement_id) AS linked_requirements,
               COUNT(DISTINCT el.id) AS evidence,
               COUNT(DISTINCT t.id) FILTER (WHERE t.result = 'PASS') AS tests_passed,
               COUNT(DISTINCT t.id) AS tests_run,
               COUNT(DISTINCT f.id) FILTER (WHERE f.status <> 'CLOSED') AS open_findings
          FROM control_requirements cr
          JOIN requirements qq ON qq.id = cr.requirement_id
          JOIN controls c ON c.id = cr.control_id
          LEFT JOIN company_entities e ON e.id = c.entity_id
          LEFT JOIN org_nodes o ON o.id = e.org_node_id
          LEFT JOIN evidence_links el ON el.control_id = c.id
          LEFT JOIN compliance_tests t ON t.control_id = c.id
          LEFT JOIN findings f ON f.control_id = c.id
         WHERE {w}
         GROUP BY c.id, c.name, c.description, c.control_type, c.frequency,
                  c.owner_id, c.effectiveness, c.last_tested, c.next_test_due, o.name
         ORDER BY linked_requirements DESC, c.name
         LIMIT ? OFFSET ?""", tuple(params) + (size, (page - 1) * size))

    # Coverage, stated as the chain states it rather than as a single "status".
    for it in items:
        if it["open_findings"]:
            it["coverage"] = "GAP"
        elif it["evidence"] and it["tests_passed"]:
            it["coverage"] = "IN_PLACE"
        elif it["evidence"]:
            it["coverage"] = "PARTIAL"
        else:
            it["coverage"] = "NO_EVIDENCE"

    tally = {k: 0 for k in ("IN_PLACE", "PARTIAL", "GAP", "NO_EVIDENCE")}
    for row in _rows(con, f"""
            SELECT c.id,
                   COUNT(DISTINCT el.id) AS ev,
                   COUNT(DISTINCT t.id) FILTER (WHERE t.result='PASS') AS passed,
                   COUNT(DISTINCT f.id) FILTER (WHERE f.status <> 'CLOSED') AS findings
              FROM control_requirements cr
              JOIN requirements qq ON qq.id = cr.requirement_id
              JOIN controls c ON c.id = cr.control_id
              LEFT JOIN evidence_links el ON el.control_id = c.id
              LEFT JOIN compliance_tests t ON t.control_id = c.id
              LEFT JOIN findings f ON f.control_id = c.id
             WHERE {w} GROUP BY c.id""", tuple(params)):
        if row["findings"]:
            tally["GAP"] += 1
        elif row["ev"] and row["passed"]:
            tally["IN_PLACE"] += 1
        elif row["ev"]:
            tally["PARTIAL"] += 1
        else:
            tally["NO_EVIDENCE"] += 1

    return {"page": page, "size": size, "total": total, "tally": tally, "items": items}


@router.get("/{rid}/controls/{cid}")
def control_detail(rid: str, cid: str):
    con = connect()
    c = con.execute("SELECT * FROM controls WHERE id = ?", (cid,)).fetchone()
    if not c:
        raise HTTPException(404, "no such control")
    linked = _rows(con, """
        SELECT q.id, q.source_clause, LEFT(q.statement, 200) AS statement,
               COALESCE(i.compliance_status, 'NOT_ASSESSED') AS status
          FROM control_requirements cr
          JOIN requirements q ON q.id = cr.requirement_id
          LEFT JOIN company_requirement_instances i ON i.requirement_id = q.id
         WHERE cr.control_id = ? AND q.regulation_id = ?
         ORDER BY q.source_clause LIMIT 50""", (cid, rid))
    evidence = _rows(con, """
        SELECT e.id, e.name, e.evidence_type, e.valid_until, e.verification_status
          FROM evidence_links el JOIN evidence e ON e.id = el.evidence_id
         WHERE el.control_id = ?""", (cid,))
    findings = _rows(con, """
        SELECT id, severity, title, status, raised_at FROM findings
         WHERE control_id = ? AND status <> 'CLOSED'
         ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                                WHEN 'MEDIUM' THEN 2 ELSE 3 END LIMIT 20""", (cid,))
    tests = _rows(con, """
        SELECT id, result, performed_at, result_notes FROM compliance_tests
         WHERE control_id = ? ORDER BY performed_at DESC NULLS LAST LIMIT 10""", (cid,))
    return {**dict(c), "linkedRequirements": linked, "evidence": evidence,
            "findings": findings, "tests": tests}


# ----------------------------------------------------------- the obligations
@router.get("/{rid}/obligations")
def obligations(rid: str, page: int = Query(1, ge=1), size: int = Query(25, ge=1, le=200),
                q: str | None = None):
    """
    The duties this instrument imposes, and how far each one is discharged.

    "Addressed" is read off the chain, never stored: a duty is fully addressed
    when every requirement under it has an approved control AND evidence;
    partially when some do; not addressed when none do. A duty whose own
    instances are all NOT_APPLICABLE is reported as not applicable rather than
    as a failure — the engine evaluated it and it does not bind this company.
    """
    con = connect()
    where, params = ["o.regulation_id = ?"], [rid]
    if q:
        where.append("(o.description ILIKE ? OR o.title ILIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    w = " AND ".join(where)

    total = _one(con, f"SELECT COUNT(*) FROM obligations o WHERE {w}", tuple(params))

    rows = _rows(con, f"""
        SELECT o.id, o.title, o.description, o.obligation_type, o.responsible_entity,
               o.frequency, o.source_reference, s.section_number, s.section_title,
               COALESCE(dept.name, '') AS department,
               COUNT(DISTINCT q.id) AS requirements,
               COUNT(DISTINCT cr.control_id) AS controls,
               COUNT(DISTINCT el.id) AS evidence,
               COUNT(DISTINCT q.id) FILTER (WHERE i.compliance_status = 'COMPLIANT') AS met,
               COUNT(DISTINCT q.id) FILTER (WHERE i.compliance_status = 'NOT_APPLICABLE') AS na,
               COUNT(DISTINCT q.id) FILTER (
                   WHERE i.compliance_status IN ('PARTIALLY_COMPLIANT','EVIDENCE_MISSING')) AS partial
          FROM obligations o
          LEFT JOIN sections s ON s.id = o.section_id
          LEFT JOIN requirements q ON q.obligation_id = o.id
          LEFT JOIN v_company_requirements i ON i.requirement_id = q.id
          LEFT JOIN control_requirements cr ON cr.requirement_id = q.id
          LEFT JOIN controls c ON c.id = cr.control_id
          LEFT JOIN company_entities ce ON ce.id = c.entity_id
          LEFT JOIN org_nodes dept ON dept.id = ce.org_node_id
          LEFT JOIN evidence_links el ON el.control_id = cr.control_id
         WHERE {w}
         GROUP BY o.id, o.title, o.description, o.obligation_type, o.responsible_entity,
                  o.frequency, o.source_reference, s.section_number, s.section_title, dept.name
         ORDER BY s.section_number NULLS LAST, o.id
         LIMIT ? OFFSET ?""", tuple(params) + (size, (page - 1) * size))

    def status_of(r):
        """
        Read from what the row itself shows, so the label never contradicts the
        numbers beside it. An earlier version counted EVIDENCE_MISSING instances
        as "partially addressed", which printed that label next to "0 controls,
        0 evidence" — true to the stored status, but unreadable as a row.
        """
        reqs, na = r["requirements"], r["na"]
        if reqs and na == reqs:
            return "NOT_APPLICABLE"
        owed = reqs - na
        if owed and r["met"] == owed:
            return "FULLY_ADDRESSED"
        if r["met"] or r["controls"]:
            return "PARTIALLY_ADDRESSED"
        return "NOT_ADDRESSED"

    for r in rows:
        r["status"] = status_of(r)

    tally = {k: 0 for k in
             ("FULLY_ADDRESSED", "PARTIALLY_ADDRESSED", "NOT_ADDRESSED", "NOT_APPLICABLE")}
    for r in _rows(con, f"""
            SELECT o.id,
                   COUNT(DISTINCT q.id) AS requirements,
                   COUNT(DISTINCT cr.control_id) AS controls,
                   COUNT(DISTINCT q.id) FILTER (WHERE i.compliance_status='COMPLIANT') AS met,
                   COUNT(DISTINCT q.id) FILTER (WHERE i.compliance_status='NOT_APPLICABLE') AS na,
                   COUNT(DISTINCT q.id) FILTER (
                       WHERE i.compliance_status IN ('PARTIALLY_COMPLIANT','EVIDENCE_MISSING')) AS partial
              FROM obligations o
              LEFT JOIN requirements q ON q.obligation_id = o.id
              LEFT JOIN v_company_requirements i ON i.requirement_id = q.id
              LEFT JOIN control_requirements cr ON cr.requirement_id = q.id
             WHERE {w} GROUP BY o.id""", tuple(params)):
        tally[status_of(row)] = tally.get(status_of(row), 0) + 1 if False else tally[status_of(row)] + 1 \
            if (row := r) else 0

    return {"page": page, "size": size, "total": total, "tally": tally, "items": rows}


@router.get("/{rid}/obligations/{oid}")
def obligation_detail(rid: str, oid: str):
    con = connect()
    o = con.execute("SELECT * FROM obligations WHERE id = ? AND regulation_id = ?",
                    (oid, rid)).fetchone()
    if not o:
        raise HTTPException(404, "no such obligation")
    reqs = _rows(con, """
        SELECT q.id, q.source_clause, LEFT(q.statement, 220) AS statement,
               COALESCE(i.compliance_status, 'NOT_ASSESSED') AS status
          FROM requirements q
          LEFT JOIN company_requirement_instances i ON i.requirement_id = q.id
         WHERE q.obligation_id = ? ORDER BY q.source_clause LIMIT 40""", (oid,))
    ctrls = _rows(con, """
        SELECT DISTINCT c.id, c.name, c.control_type, c.owner_id,
               COALESCE(dept.name, '') AS department
          FROM requirements q
          JOIN control_requirements cr ON cr.requirement_id = q.id
          JOIN controls c ON c.id = cr.control_id
          LEFT JOIN company_entities ce ON ce.id = c.entity_id
          LEFT JOIN org_nodes dept ON dept.id = ce.org_node_id
         WHERE q.obligation_id = ? LIMIT 10""", (oid,))
    ev = _rows(con, """
        SELECT DISTINCT e.id, e.name, e.evidence_type, e.valid_until
          FROM requirements q
          JOIN control_requirements cr ON cr.requirement_id = q.id
          JOIN evidence_links el ON el.control_id = cr.control_id
          JOIN evidence e ON e.id = el.evidence_id
         WHERE q.obligation_id = ? LIMIT 10""", (oid,))
    sec = con.execute("SELECT section_number, section_title FROM sections WHERE id = ?",
                      (o["section_id"],)).fetchone() if o["section_id"] else None
    return {**dict(o), "section": dict(sec) if sec else None,
            "requirements": reqs, "controls": ctrls, "evidence": ev}


# --------------------------------------------------------------- the updates
@router.get("/{rid}/updates")
def updates(rid: str):
    con = connect()
    changes = _rows(con, """
        SELECT change_class, section_number, detected_at, words_added, words_removed
          FROM section_changes WHERE regulation_id = ?
         ORDER BY detected_at DESC LIMIT 50""", (rid,))
    amendments = _rows(con, """
        SELECT * FROM regulation_amendments WHERE regulation_id = ?
         LIMIT 50""", (rid,))
    versions = _rows(con, """
        SELECT * FROM document_versions WHERE regulation_id = ?
         ORDER BY 1 DESC LIMIT 20""", (rid,))
    tally = {"wording": sum(1 for c in changes if c["change_class"] == "WORDING"),
             "renumbered": sum(1 for c in changes if c["change_class"] == "NUMBERING_ONLY"),
             "amendments": len(amendments), "versions": len(versions)}
    return {"tally": tally, "changes": changes, "amendments": amendments,
            "versions": versions}


# ---------------------------------------------------------- the text outline
@router.get("/{rid}/outline")
def outline(rid: str):
    con = connect()
    secs = _rows(con, """
        SELECT s.id, s.section_number, s.section_title, s.chars,
               (SELECT COUNT(*) FROM obligations o WHERE o.section_id = s.id) AS obligations,
               (SELECT COUNT(*) FROM requirements q
                 JOIN obligations o2 ON o2.id = q.obligation_id
                WHERE o2.section_id = s.id) AS requirements
          FROM sections s WHERE s.regulation_id = ?
         ORDER BY s.section_number LIMIT 500""", (rid,))
    return {"sections": secs, "total": len(secs)}


@router.get("/{rid}/section/{sid}")
def section(rid: str, sid: str):
    con = connect()
    s = con.execute("SELECT * FROM sections WHERE id = ? AND regulation_id = ?",
                    (sid, rid)).fetchone()
    if not s:
        raise HTTPException(404, "no such section")
    obls = _rows(con, """
        SELECT id, title, description, obligation_type, responsible_entity
          FROM obligations WHERE section_id = ? LIMIT 40""", (sid,))
    reqs = _rows(con, """
        SELECT q.id, q.source_clause, LEFT(q.statement, 240) AS statement,
               COALESCE(i.compliance_status, 'NOT_ASSESSED') AS status
          FROM requirements q
          JOIN obligations o ON o.id = q.obligation_id
          LEFT JOIN company_requirement_instances i ON i.requirement_id = q.id
         WHERE o.section_id = ? LIMIT 40""", (sid,))
    return {**dict(s), "obligations": obls, "requirements": reqs}
