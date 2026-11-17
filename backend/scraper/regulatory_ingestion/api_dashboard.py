"""
The landing dashboard — what changed, who it reaches, and what is missing.

WHY A DEDICATED ENDPOINT
------------------------
The overview screen read a static `COMPANY` object from a seed module, so the
first thing anyone saw on opening the product was not the database. Every figure
here is a COUNT over real rows, and each block reports the query it came from.

WHAT "AFFECTED" MEANS HERE
--------------------------
Two different things, kept apart because merging them overstates reach:

    named        a person entity an obligation's text actually matched
    accountable  a person who OWNS something a regulation touches

The second is much larger and is the one a compliance lead acts on, but it is an
ownership link, not a statement that the clause names them.

WHAT IS MISSING IS REPORTED AS PROMINENTLY AS WHAT IS PRESENT
-------------------------------------------------------------
A dashboard that shows only what exists implies the rest is fine. The gaps block
counts records the pipeline has not finished with — no document, never
re-checked, no control, no evidence — because those are the numbers that decide
whether anything else on the page can be trusted.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from .api_auth import require

from .db import connect

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"],
                   # every route here served company data to anyone —
                   # the login page gated the UI, not the API
                   dependencies=[Depends(require("read"))])


def _con():
    con = connect()
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _rows(con, q, *p):
    return [dict(r) for r in con.execute(q, p).fetchall()]


def _one(con, q, *p):
    r = con.execute(q, p).fetchone()
    return r[0] if r else 0


@router.get("")
def dashboard():
    con = _con()

    # ---------------------------------------------------------------- change
    changed = _rows(con, """
        SELECT c.regulation_id, r.title, r.regulator_short,
               COUNT(*) FILTER (WHERE c.change_class = 'WORDING')        AS wording,
               COUNT(*) FILTER (WHERE c.change_class = 'NUMBERING_ONLY') AS renumbered,
               MAX(c.detected_at) AS detected_at,
               SUM(c.words_added) AS words_added, SUM(c.words_removed) AS words_removed
          FROM section_changes c
          LEFT JOIN regulations r ON r.id = c.regulation_id
         GROUP BY 1, 2, 3
        HAVING COUNT(*) FILTER (WHERE c.change_class = 'WORDING') > 0
         ORDER BY wording DESC, detected_at DESC
         LIMIT 12""")

    change = {
        "regulationsChanged": _one(con, """SELECT COUNT(DISTINCT regulation_id) FROM section_changes
                                            WHERE change_class = 'WORDING'"""),
        "wordingChanges": _one(con, "SELECT COUNT(*) FROM section_changes WHERE change_class='WORDING'"),
        "renumberedOnly": _one(con, "SELECT COUNT(*) FROM section_changes WHERE change_class='NUMBERING_ONLY'"),
        # A footnote saying "amended vide circular" is the regulator's own
        # statement, not a comparison this system performed. Never merged.
        "amendmentsMentionedInSource": _one(con, "SELECT COUNT(*) FROM regulation_amendments"),
        "recent": changed,
    }

    # --------------------------------------------------------------- people
    named = _rows(con, """
        SELECT e.id, e.name, e.type,
               COUNT(DISTINCT i.regulation_id) AS regulations,
               COUNT(*) AS obligations
          FROM impact_relationships i
          JOIN company_entities e ON e.id = i.company_brain_entity_id
         WHERE e.domain = 'people'
         GROUP BY 1, 2, 3 ORDER BY regulations DESC LIMIT 12""")

    accountable = _rows(con, """
        SELECT o.id, o.name, o.type,
               COUNT(DISTINCT e.id)             AS entities_owned,
               COUNT(DISTINCT i.regulation_id)  AS regulations
          FROM company_entities e
          JOIN company_entities o ON o.id = e.owner_id
          JOIN impact_relationships i ON i.company_brain_entity_id = e.id
         GROUP BY 1, 2, 3 ORDER BY regulations DESC LIMIT 12""")

    people = {
        "namedInClauses": _one(con, """SELECT COUNT(DISTINCT i.company_brain_entity_id)
                                         FROM impact_relationships i
                                         JOIN company_entities e ON e.id = i.company_brain_entity_id
                                        WHERE e.domain = 'people'"""),
        "accountable": _one(con, """SELECT COUNT(DISTINCT e.owner_id) FROM company_entities e
                                     WHERE e.owner_id IS NOT NULL AND e.owner_id <> ''
                                       AND EXISTS (SELECT 1 FROM impact_relationships i
                                                    WHERE i.company_brain_entity_id = e.id)"""),
        "named": named,
        "owners": accountable,
    }

    # --------------------------------------------------------------- owners
    owners = {
        "entities": _one(con, "SELECT COUNT(*) FROM company_entities"),
        "withOwner": _one(con, """SELECT COUNT(*) FROM company_entities
                                   WHERE owner_id IS NOT NULL AND owner_id <> ''"""),
        "distinctOwners": _one(con, """SELECT COUNT(DISTINCT owner_id) FROM company_entities
                                        WHERE owner_id IS NOT NULL AND owner_id <> ''"""),
        # An unowned entity that a regulation touches is the one that matters:
        # a change lands on it and there is nobody to route the work to.
        "unownedButAffected": _rows(con, """
            SELECT e.id, e.name, e.domain, e.type,
                   COUNT(DISTINCT i.regulation_id) AS regulations
              FROM company_entities e
              JOIN impact_relationships i ON i.company_brain_entity_id = e.id
             WHERE e.owner_id IS NULL OR e.owner_id = ''
             GROUP BY 1, 2, 3, 4 ORDER BY regulations DESC LIMIT 10"""),
    }

    # ----------------------------------------------------------------- gaps
    total_regs = _one(con, "SELECT COUNT(*) FROM regulations")
    gaps = [
        {"key": "no_document", "label": "Regulations with no document retrieved",
         "count": _one(con, """SELECT COUNT(*) FROM regulations r
                                WHERE NOT EXISTS (SELECT 1 FROM documents d
                                                   WHERE d.regulation_id = r.id)"""),
         "of": total_regs,
         "why": "Discovered from a listing page, but the document itself was never resolved or downloaded.",
         "link": "/ingestion"},
        {"key": "never_rechecked", "label": "Never re-checked since first retrieval",
         "count": _one(con, """SELECT COUNT(*) FROM regulations r
                                WHERE NOT EXISTS (SELECT 1 FROM source_checks s
                                                   WHERE s.regulation_id = r.id)"""),
         "of": total_regs,
         "why": "Change detection needs two captures of the same document. These have one.",
         "link": "/ingestion"},
        {"key": "no_sector", "label": "No sector could be determined",
         "count": _one(con, """SELECT COUNT(*) FROM regulations r
                                WHERE NOT EXISTS (SELECT 1 FROM regulation_sectors s
                                                   WHERE s.regulation_id = r.id)"""),
         "of": total_regs,
         "why": "Mostly colonial-era Acts whose subject falls outside the sector vocabulary.",
         "link": "/reg-regulations"},
        {"key": "no_applicability", "label": "Applicability not evaluated",
         "count": _one(con, """SELECT COUNT(*) FROM regulations
                                WHERE applicability IS NULL OR applicability = ''"""),
         "of": total_regs,
         "why": "No applicability rules were extracted, so the evaluator has nothing to compare.",
         "link": "/reg-regulations"},
        {"key": "obligations_no_control", "label": "Obligations with no control assigned",
         "count": _one(con, """SELECT COUNT(*) FROM obligations o
                                WHERE o.kind = 'OBLIGATION'
                                  AND NOT EXISTS (SELECT 1 FROM control_obligations c
                                                   WHERE c.obligation_id = o.id)"""),
         "of": _one(con, "SELECT COUNT(*) FROM obligations WHERE kind = 'OBLIGATION'"),
         "why": "Nothing claims to satisfy these duties.",
         "link": "/controls"},
        {"key": "no_evidence", "label": "Evidence records",
         "count": _one(con, "SELECT COUNT(*) FROM evidence"),
         "of": None,
         "why": "The evidence layer was designed and left empty on purpose. Nothing can reach "
                "'Evidence Verified', so no obligation can legitimately be Compliant.",
         "link": "/evidence"},
        {"key": "unowned", "label": "Entities with no owner",
         "count": _one(con, """SELECT COUNT(*) FROM company_entities
                                WHERE owner_id IS NULL OR owner_id = ''"""),
         "of": _one(con, "SELECT COUNT(*) FROM company_entities"),
         "why": "A change landing here has nobody to route to.",
         "link": "/people"},
    ]

    # --------------------------------------------------------- impact engine
    last_run = con.execute("""SELECT regulation_id, status, route, model, impacts, actions,
                                     hallucination_rate, ran_at
                                FROM impact_runs ORDER BY id DESC LIMIT 1""").fetchone()
    try:
        from .agent import llm as _llm
        model_status = _llm.status()
    except Exception:
        model_status = {"available": False, "note": "model layer unavailable"}

    engine = {
        "runs": _one(con, "SELECT COUNT(*) FROM impact_runs"),
        "byRoute": _rows(con, """SELECT route, COUNT(*) AS count FROM impact_runs
                                  GROUP BY 1 ORDER BY count DESC"""),
        "lastRun": dict(last_run) if last_run else None,
        "modelAvailable": bool(model_status.get("available")),
        "modelNote": model_status.get("note"),
        "relationships": _one(con, "SELECT COUNT(*) FROM impact_relationships"),
        "entitiesTouched": _one(con, "SELECT COUNT(DISTINCT company_brain_entity_id) FROM impact_relationships"),
        "regulationsScored": _one(con, "SELECT COUNT(*) FROM impact_scores"),
        "bands": _rows(con, """SELECT level AS value, COUNT(*) AS count FROM impact_scores
                                GROUP BY 1 ORDER BY count DESC"""),
        # Everything the engine writes is a proposal. Stated here so the number
        # of mappings is never mistaken for a number of decisions.
        "proposedMappings": _one(con, "SELECT COUNT(*) FROM company_mappings WHERE status = 'Proposed'"),
        "approvedMappings": _one(con, "SELECT COUNT(*) FROM company_mappings WHERE status <> 'Proposed'"),
    }

    # ---------------------------------------------------------------- dates
    # "When" is missing from every figure above. A change detected today and one
    # detected in August need different urgency, and a library last checked six
    # weeks ago should say so rather than presenting stale counts as current.
    dates = {
        "lastChangeDetected": _one(con, "SELECT MAX(detected_at) FROM section_changes") or None,
        "lastSourceCheck": _one(con, "SELECT MAX(checked_at) FROM source_checks") or None,
        "lastImpactRun": _one(con, "SELECT MAX(ran_at) FROM impact_runs") or None,
        "sourceChecksLast7d": _one(con, """SELECT COUNT(*) FROM source_checks
                                            WHERE checked_at >= ?""",
                                   (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()),
        "changesLast30d": _one(con, """SELECT COUNT(DISTINCT regulation_id) FROM section_changes
                                        WHERE change_class = 'WORDING' AND detected_at >= ?""",
                               (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()),
    }

    # -------------------------------------------------------------- next steps
    # Each is a real queue with a real count and somewhere to go. An action with
    # nothing behind it is not offered.
    actions = []
    if change["regulationsChanged"]:
        actions.append({
            "key": "review_changes", "count": change["regulationsChanged"],
            "label": "Review reworded regulations",
            "detail": f"{change['wordingChanges']} sections changed wording since the previous captured version.",
            "link": "/reg-regulations", "urgency": "high"})
    if engine["proposedMappings"]:
        actions.append({
            "key": "approve_mappings", "count": engine["proposedMappings"],
            "label": "Approve or reject proposed links",
            "detail": "The engine proposes; nothing is applied until a human accepts it.",
            "link": "/review", "urgency": "high"})
    unowned_n = _one(con, """SELECT COUNT(DISTINCT e.id) FROM company_entities e
                              JOIN impact_relationships i ON i.company_brain_entity_id = e.id
                             WHERE e.owner_id IS NULL OR e.owner_id = ''""")
    if unowned_n:
        actions.append({
            "key": "assign_owners", "count": unowned_n,
            "label": "Assign owners to affected records",
            "detail": "A regulation reaches these, but there is nobody to route the work to.",
            "link": "/people", "urgency": "medium"})
    never = _one(con, """SELECT COUNT(*) FROM regulations r
                          WHERE NOT EXISTS (SELECT 1 FROM source_checks s
                                             WHERE s.regulation_id = r.id)""")
    if never:
        actions.append({
            "key": "check_sources", "count": never,
            "label": "Check sources for the first time",
            "detail": "Change detection needs a second capture. These have only one.",
            "link": "/ingestion", "urgency": "medium"})

    return {
        "dates": dates,
        "actions": actions,
        "library": {
            "discovered": total_regs,
            "documentsExtracted": _one(con, "SELECT COUNT(*) FROM documents WHERE extraction_status='EXTRACTED'"),
            "structured": _one(con, "SELECT COUNT(DISTINCT regulation_id) FROM sections"),
            "obligations": _one(con, "SELECT COUNT(*) FROM obligations WHERE kind='OBLIGATION'"),
        },
        "change": change,
        "people": people,
        "owners": owners,
        "gaps": gaps,
        "engine": engine,
    }
