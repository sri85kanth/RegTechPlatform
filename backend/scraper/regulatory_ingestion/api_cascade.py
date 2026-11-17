"""
Impact cascade: regulation -> obligation -> risk -> policy -> control -> owner.

Reads gap_assessments (one assessed row per requirement: status, risk, the
rewritten obligation and testable requirement, the hospital documents that
cover it, what is missing and the fix) and cascade_graph (the hospital's own
policies, SOPs, forms, controls and risk register, with their text), both
written by scraper/cascade_sync.py. The page joins them client-side; this
router only reads.

A regulation none of whose provisions place a duty on the hospital is listed
separately (``excluded``), not charted: there is nothing in it to trace.
"""
from __future__ import annotations

import json
from fastapi import APIRouter, Depends, HTTPException

from . import auth as A
from .api_auditor import graph_for, log as audit_log, shared_regulation_ids
from .api_auth import require
from .db import connect

# 'audit', not 'read': an external auditor may open the cascade, but only of the
# regulations the hospital shared with it (api_auditor.py), and its document
# graph is cut to what those cascades link to. Staff from viewer up see everything.
AUDIT = Depends(require("audit"))
router = APIRouter(prefix="/api/cascade", tags=["cascade"])

_UNMET = ("PARTIAL", "GAP", "NOT_COVERED")


def _has_tables(con) -> bool:
    return bool(con.execute(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('gap_assessments','cascade_graph')"
    ).fetchone()[0] == 2)


@router.get("/regulations")
def regulations(user: dict | None = AUDIT):
    con = connect()
    if not _has_tables(con):
        return {"items": [], "excluded": [], "note": "No gap assessment has been loaded yet."}
    rows = con.execute(
        """SELECT g.regulation_id AS id, r.title, r.short_title,
                  coalesce(nullif(r.regulator_short,''), r.regulator, '') AS regulator,
                  coalesce(nullif(r.official_document_url,''), r.source_url, '') AS url,
                  count(*) AS total,
                  count(*) FILTER (WHERE g.status <> 'NOT_APPLICABLE') AS applicable,
                  count(*) FILTER (WHERE g.status = 'MET') AS met,
                  count(*) FILTER (WHERE g.status = 'PARTIAL') AS partial,
                  count(*) FILTER (WHERE g.status = 'GAP') AS gap,
                  count(*) FILTER (WHERE g.status = 'NOT_COVERED') AS not_covered,
                  count(*) FILTER (WHERE g.risk = 'Critical') AS critical,
                  count(*) FILTER (WHERE g.risk = 'High') AS high,
                  count(*) FILTER (WHERE g.risk = 'Medium') AS medium,
                  count(*) FILTER (WHERE g.risk = 'Low') AS low
           FROM gap_assessments g JOIN regulations r ON r.id = g.regulation_id
           GROUP BY g.regulation_id, r.title, r.short_title, r.regulator_short, r.regulator,
                    r.official_document_url, r.source_url""").fetchall()
    items = [dict(r) for r in rows]
    if A.is_auditor(user):
        allowed = shared_regulation_ids(con, user["id"])
        items = [i for i in items if i["id"] in allowed and i["applicable"]]
        return {"items": sorted(items, key=lambda i: (-i["critical"], i["title"])), "excluded": [],
                "note": None if items else "Nothing has been shared with you yet."}
    charted = [i for i in items if i["applicable"]]
    charted.sort(key=lambda i: (-i["critical"], -i["high"], -(i["partial"] + i["gap"] + i["not_covered"]), i["title"]))
    excluded = sorted(i["short_title"] or i["title"] for i in items if not i["applicable"])
    return {"items": charted, "excluded": excluded}


@router.get("/regulations/{rid}")
def regulation(rid: str, user: dict | None = AUDIT):
    con = connect()
    if not _has_tables(con):
        raise HTTPException(404, "No gap assessment has been loaded yet.")
    if A.is_auditor(user):
        if rid not in shared_regulation_ids(con, user["id"]):
            raise HTTPException(404, "This regulation has not been shared with you.")
        # what the auditor opened, once per half hour per regulation
        audit_log(con, user["email"], "auditor_view_cascade", rid, {"auditor_id": user["id"]}, dedupe_minutes=30)
    rows = con.execute(
        """SELECT * FROM gap_assessments WHERE regulation_id = ? AND status <> 'NOT_APPLICABLE'
           ORDER BY position""", (rid,)).fetchall()
    if not rows:
        raise HTTPException(404, "No applicable assessed requirements for this regulation.")
    # NABH marks the elements that need a written, approved document with an
    # asterisk (*); the parser kept that mark as obligation_type DOCUMENTATION.
    doc_required = {r[0] for r in con.execute(
        """SELECT q.id FROM requirements q JOIN obligations o ON o.id = q.obligation_id
            WHERE q.regulation_id = ? AND o.obligation_type = 'DOCUMENTATION'
              AND o.extraction_method LIKE 'nabh6%'""", (rid,))}
    units: dict[str, dict] = {}
    for r in rows:
        u = units.setdefault(r["unit_code"] or "General",
                             {"g": r["unit_group"] or "", "u": r["unit_code"] or "General", "ut": r["unit_title"] or "", "items": []})
        u["items"].append({
            "rid": r["requirement_id"], "c": r["item_code"], "t": r["requirement_text"], "cat": r["category"] or "",
            "st": r["status"], "rk": r["risk"], "ob": r["obligation"] or "", "rq": r["testable_requirement"] or "",
            "who": r["responsible"] or "", "by": json.loads(r["covered_by"] or "[]"), "gap": r["gap"] or "",
            "fix": r["fix"] or "", "why": r["consequence"] or "",
            "subs": json.loads(r["sub_requirements"] or "[]"),
            "interp": r["interpretation"] or "", "gbp": r["source_page"],
            "doc": r["requirement_id"] in doc_required,
        })
    reg = con.execute(
        """SELECT r.id, r.title, r.short_title AS short,
                  coalesce(nullif(r.regulator_short,''), r.regulator, '') AS regulator,
                  r.regulator AS regulator_full, r.regulation_type, r.jurisdiction, r.effective_from, r.status,
                  r.impact_score, r.impact_level,
                  coalesce(nullif(r.official_document_url,''), r.source_url, '') AS url,
                  ar.verdict AS applicability, ar.reason AS applicability_reason
           FROM regulations r
           LEFT JOIN applicability_results ar
             ON ar.regulation_id = r.id AND ar.company_id = 1 AND ar.scope_type = 'COMPANY'
           WHERE r.id = ?""",
        (rid,)).fetchone()
    na = con.execute("SELECT count(*) FROM v_requirement_assessments WHERE regulation_id=? AND status='NOT_APPLICABLE'",
                     (rid,)).fetchone()[0]
    return {**dict(reg), "not_applicable": na, "units": list(units.values())}


@router.get("/graph")
def graph(user: dict | None = AUDIT):
    con = connect()
    if not _has_tables(con):
        return {"docs": {}, "risks": {}}
    row = con.execute("SELECT payload, updated_at FROM cascade_graph WHERE id='company'").fetchone()
    if not row:
        return {"docs": {}, "risks": {}}
    payload = json.loads(row["payload"])
    if A.is_auditor(user):
        # only the documents the shared regulations' cascades link to, not the whole library
        regs = sorted(shared_regulation_ids(con, user["id"]))
        codes: set[str] = set()
        for r in con.execute("SELECT covered_by FROM gap_assessments WHERE regulation_id = ANY(?)", (regs,)):
            codes.update(json.loads(r["covered_by"] or "[]"))
        payload = graph_for(payload, codes)
    return {**payload, "updated_at": row["updated_at"]}
