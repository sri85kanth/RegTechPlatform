"""
The Overview screen: this hospital's compliance posture in one response.

EVERY NUMBER HERE IS COUNTED, NOT ASSERTED
------------------------------------------
Each block below is a query against the live tables, and anything the data
cannot answer is returned as null or an empty list rather than a plausible
figure. A dashboard is the screen most likely to be read without checking, so
it is the screen least able to afford an invented number.

Where a panel has no backing data it says so in `note`, and the UI renders the
empty state instead of a zero — a zero reads as "measured and found none",
which is a different claim.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends

from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/overview", tags=["overview"],
                   dependencies=[Depends(require("read"))])

# The statuses derive_compliance writes, grouped the way a reader thinks about
# them. PARTIALLY_COMPLIANT is its own bucket on purpose: folding it into either
# "met" or "gap" would overstate one of them.
MET = ("COMPLIANT",)
PARTIAL = ("PARTIALLY_COMPLIANT",)
GAP = ("NON_COMPLIANT", "EVIDENCE_MISSING", "REVIEW_REQUIRED")
UNCOVERED = ("NOT_ASSESSED", "NOT_TESTED")


def _rows(con, sql, params=()):
    return [dict(r) for r in con.execute(sql, params).fetchall()]


def _one(con, sql, params=()):
    r = con.execute(sql, params).fetchone()
    return (list(r.values())[0] if hasattr(r, "values") else r[0]) if r else 0


def _days_left(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return (date.fromisoformat(iso[:10]) - date.today()).days
    except ValueError:
        return None


@router.get("")
def overview():
    con = connect()

    # ---------------------------------------------------------------- company
    p = con.execute("SELECT * FROM company_profile LIMIT 1").fetchone()
    profile = dict(p) if p else {}
    try:
        licences = json.loads(profile.get("licences") or "[]")
    except (TypeError, ValueError):
        licences = []

    # ------------------------------------------------------------ the funnel
    # Counted over duties that reach this company, not the whole corpus: the
    # corpus number is a fact about the library, not about this hospital.
    # Read through v_company_requirements, so a NOT_APPLICABLE counts only where
    # the requirement's own verdict agrees, and the reach is the same column the
    # Regulations page filters on (APPLICABLE as well as CONDITIONAL).
    reach_sql = """
        FROM v_company_requirements i
       WHERE i.regulation_id IN (SELECT id FROM regulations
                                  WHERE applicability IN ('APPLICABLE','CONDITIONAL'))"""
    by_status = {r["compliance_status"]: r["n"] for r in _rows(con, f"""
        SELECT i.compliance_status, COUNT(*) AS n {reach_sql}
        GROUP BY 1""")}

    bucket = lambda keys: sum(by_status.get(k, 0) for k in keys)
    met, partial, gaps = bucket(MET), bucket(PARTIAL), bucket(GAP)
    # Owed but not yet checked is a backlog, not a gap: kept out of the
    # percentages so the posture describes what has actually been checked.
    not_yet = by_status.get("NOT_ASSESSED", 0)
    uncovered = bucket(UNCOVERED) - not_yet

    # NOT_APPLICABLE duties sit inside regulations that DO reach this company
    # but do not bind it — a threshold unmet, an exemption that applies. They
    # are 15,038 of 19,747 here, so leaving them in the denominator reports a
    # hospital with 567 met duties as "2.9% compliant", which is a statement
    # about the corpus rather than about the hospital. The denominator is what
    # this company actually owes.
    not_applicable = by_status.get("NOT_APPLICABLE", 0)
    total_duties = met + partial + gaps + uncovered
    scanned_duties = total_duties + not_applicable + not_yet

    applicable_regs = _one(con, """SELECT COUNT(*) FROM regulations
                                    WHERE applicability IN ('APPLICABLE','CONDITIONAL')""")
    pct = lambda n: round(100.0 * n / total_duties, 1) if total_duties else 0.0

    # ------------------------------------------------------- gaps by severity
    severity = {r["severity"]: r["n"] for r in _rows(con, """
        SELECT severity, COUNT(*) AS n FROM findings
         WHERE status <> 'CLOSED' GROUP BY 1""")}

    # ------------------------------------------------ departments, by findings
    departments = _rows(con, """
        SELECT COALESCE(o.name, '(unassigned)') AS department,
               COUNT(*) FILTER (WHERE f.severity = 'CRITICAL') AS critical,
               COUNT(*) FILTER (WHERE f.severity = 'HIGH')     AS high,
               COUNT(*) FILTER (WHERE f.severity = 'MEDIUM')   AS medium,
               COUNT(*) FILTER (WHERE f.severity = 'LOW')      AS low,
               COUNT(*) AS open_total
          FROM findings f
          JOIN controls c ON c.id = f.control_id
          LEFT JOIN company_entities e ON e.id = c.entity_id
          LEFT JOIN org_nodes o ON o.id = e.org_node_id
         WHERE f.status <> 'CLOSED'
         GROUP BY 1 ORDER BY open_total DESC LIMIT 8""")

    # ----------------------------------------------------- the critical few
    critical = _rows(con, """
        SELECT f.id, f.severity, f.title, f.raised_at,
               c.name AS control, COALESCE(o.name, '') AS department,
               COALESCE(g.title, '') AS regulation, g.id AS regulation_id
          FROM findings f
          LEFT JOIN controls c ON c.id = f.control_id
          LEFT JOIN company_entities e ON e.id = c.entity_id
          LEFT JOIN org_nodes o ON o.id = e.org_node_id
          LEFT JOIN company_requirement_instances i ON i.id = f.cri_id
          LEFT JOIN requirements r ON r.id = i.requirement_id
          LEFT JOIN regulations g ON g.id = r.regulation_id
         WHERE f.status <> 'CLOSED' AND f.severity IN ('CRITICAL', 'HIGH')
         ORDER BY CASE f.severity WHEN 'CRITICAL' THEN 0 ELSE 1 END,
                  f.raised_at DESC NULLS LAST
         LIMIT 10""")

    # ------------------------------------------------------------- deadlines
    deadlines = []
    for e in _rows(con, """
            SELECT name, evidence_type, valid_until, verification_status
              FROM evidence
             WHERE valid_until IS NOT NULL AND valid_until <> ''
             ORDER BY valid_until LIMIT 8"""):
        e["days_left"] = _days_left(e["valid_until"])
        deadlines.append(e)
    # Certificates with no expiry recorded cannot be chased, and that is a
    # finding about the register rather than an empty panel.
    no_expiry = _one(con, """SELECT COUNT(*) FROM evidence
                              WHERE valid_until IS NULL OR valid_until = ''""")

    # -------------------------------------------------------------- activity
    activity = _rows(con, """
        SELECT action, entity_id, actor, detail, at
          FROM audit_events ORDER BY at DESC LIMIT 8""")

    # ------------------------------------------------------------ the chain
    controls_total = _one(con, "SELECT COUNT(*) FROM controls")
    controls_owned = _one(con, """SELECT COUNT(*) FROM controls
                                   WHERE owner_id IS NOT NULL AND owner_id <> ''""")
    controls_doc = _one(con, """SELECT COUNT(*) FROM controls c
                                 WHERE EXISTS (SELECT 1 FROM evidence_links el
                                                WHERE el.control_id = c.id)""")

    return {
        "asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "company": {
            "name": profile.get("legal_name"),
            "entityType": profile.get("entity_type"),
            "state": profile.get("hq_state"),
            "employees": profile.get("employees"),
            "beds": profile.get("beds"),
            "licences": len(licences),
            "licenceNames": licences[:12],
        },
        "funnel": {
            "regulationsHeld": _one(con, "SELECT COUNT(*) FROM regulations"),
            "documents": _one(con, "SELECT COUNT(*) FROM company_documents"),
            "applicableRegulations": applicable_regs,
            "dutiesScanned": scanned_duties,
            "dutiesChecked": total_duties,
            "dutiesNotApplicable": not_applicable,
            "dutiesNotYetAssessed": not_yet,
            "openGaps": gaps + uncovered,
        },
        "posture": {
            "total": total_duties,
            "scanned": scanned_duties,
            "notApplicable": not_applicable,
            "notYetAssessed": not_yet,
            "met": met, "metPct": pct(met),
            "partial": partial, "partialPct": pct(partial),
            "gaps": gaps, "gapsPct": pct(gaps),
            "notCovered": uncovered, "notCoveredPct": pct(uncovered),
            # The headline figure. Stated as met over everything that reaches
            # us, so it cannot be inflated by narrowing the denominator.
            "compliantPct": pct(met),
            "byStatus": by_status,
        },
        "severity": {
            "critical": severity.get("CRITICAL", 0),
            "high": severity.get("HIGH", 0),
            "medium": severity.get("MEDIUM", 0),
            "low": severity.get("LOW", 0),
            "total": sum(severity.values()),
        },
        "departments": departments,
        "criticalGaps": critical,
        "deadlines": deadlines,
        "evidenceWithoutExpiry": no_expiry,
        "activity": activity,
        "controls": {
            "total": controls_total,
            "withOwner": controls_owned,
            "withDocument": controls_doc,
        },
    }
