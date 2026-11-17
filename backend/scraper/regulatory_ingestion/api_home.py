"""
GET /api/home — the Dashboard's summary, one call, from rows that exist.

  pipeline     the five stages: profile, documents, rules mapped, compliance check, close gaps
  totals       requirement verdicts (gap_assessments) and the risk bands of the unmet ones
  latest       the most recently added regulation that reaches the hospital ("a new circular")
  deadlines    the next dates that bind the hospital: in-force dates of applicable
               regulations, and recurring reporting dates projected from their text
  departments  requirements per department with their verdict mix, worst first
"""
from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Depends

from .api_auth import require
from .api_calendar import _project
from .api_reg_overview import DEPTS
from .criteria import finding_not_criterion
from .db import connect

router = APIRouter(prefix="/api/home", tags=["dashboard"], dependencies=[Depends(require("read"))])
_REACH = ("APPLICABLE", "CONDITIONAL")


@router.get("")
def home():
    con = connect()
    one = lambda q, *p: con.execute(q, p).fetchone()[0]          # noqa: E731

    prof = con.execute("SELECT * FROM company_profile ORDER BY id LIMIT 1").fetchone()
    prof = dict(prof) if prof else {}
    addr = (prof.get("registered_address") or "")
    city = next((c.title() for c in ("HYDERABAD", "SECUNDERABAD", "BANGALORE", "CHENNAI", "MUMBAI", "DELHI")
                 if c in addr.upper()), None)

    # the same column the Regulations page filters on, so the two never disagree
    applicable = one("""SELECT count(*) FROM regulations WHERE applicability IN ('APPLICABLE','CONDITIONAL')""")
    docs = one("SELECT count(*) FROM company_documents")
    t = dict(con.execute("""
        SELECT count(*) FILTER (WHERE status IN ('MET','PARTIAL','GAP','NOT_COVERED')) AS checked,
               count(*) FILTER (WHERE status = 'NOT_ASSESSED') AS not_assessed,
               count(*) FILTER (WHERE status = 'MET') AS met,
               count(*) FILTER (WHERE status = 'PARTIAL') AS partial,
               count(*) FILTER (WHERE status = 'GAP') AS gap,
               count(*) FILTER (WHERE status = 'NOT_COVERED') AS not_covered,
               count(*) FILTER (WHERE risk = 'Critical' AND status <> 'NOT_ASSESSED') AS critical,
               count(*) FILTER (WHERE risk = 'High' AND status <> 'NOT_ASSESSED') AS high,
               count(*) FILTER (WHERE risk = 'Medium' AND status <> 'NOT_ASSESSED') AS medium,
               count(*) FILTER (WHERE risk = 'Low' AND status <> 'NOT_ASSESSED') AS low,
               count(DISTINCT regulation_id) AS regulations
          FROM v_requirement_assessments""").fetchone())
    # NABH guidebook criteria carry findings of their own; they count under their element
    open_findings = one(f"SELECT count(*) FROM findings f WHERE f.status <> 'CLOSED' AND {finding_not_criterion('f')}")
    # "Close gaps" counts the same unit as "Compliance check": requirements.
    unmet = (t["partial"] or 0) + (t["gap"] or 0) + (t["not_covered"] or 0)

    pipeline = [
        {"label": "Hospital profile", "detail": "Completed" if prof.get("legal_name") else "Not set up",
         "done": bool(prof.get("legal_name")), "to": "/company-setup"},
        {"label": "Documents", "detail": f"{docs:,} uploaded", "done": docs > 0, "to": "/onboarding"},
        {"label": "Rules mapped", "detail": f"{applicable:,} applicable", "done": applicable > 0, "to": "/applies"},
        {"label": "Compliance check", "detail": f"{t['checked']:,} requirements", "done": t["checked"] > 0, "to": "/cascade"},
        {"label": "Close gaps", "detail": f"{unmet:,} of {t['checked']:,} open", "done": unmet == 0, "to": "/compliance"},
    ]

    latest = con.execute(f"""
        SELECT r.id, coalesce(nullif(r.short_title,''), r.title) AS title,
               coalesce(nullif(r.regulator_short,''), r.regulator) AS regulator, r.created_at
          FROM regulations r
          JOIN applicability_results ar ON ar.regulation_id = r.id AND ar.company_id = 1
               AND ar.scope_type = 'COMPANY' AND ar.verdict IN {_REACH}
         ORDER BY r.created_at DESC NULLS LAST LIMIT 1""").fetchone()

    # deadlines: in-force dates still ahead, then projected recurring reporting dates
    today = date.today()
    dl = []
    for r in con.execute(f"""
        SELECT r.id, coalesce(nullif(r.short_title,''), r.title) AS title,
               coalesce(nullif(r.regulator_short,''), r.regulator) AS authority, r.effective_from AS d
          FROM regulations r
         WHERE r.applicability IN {_REACH} AND r.effective_from >= to_char(now(), 'YYYY-MM-DD')
         ORDER BY r.effective_from LIMIT 10"""):
        dl.append({"id": r["id"], "title": r["title"], "authority": r["authority"], "date": r["d"][:10],
                   "kind": "Comes into force"})
    seen = set()
    for r in con.execute(f"""
        SELECT tr.expression, lp.regulation_id AS id, coalesce(nullif(r.short_title,''), r.title) AS title,
               coalesce(nullif(r.regulator_short,''), r.regulator) AS authority
          FROM timing_rules tr
          JOIN legal_provisions lp ON lp.id = tr.provision_id
          JOIN regulations r ON r.id = lp.regulation_id
         WHERE tr.rule_type = 'FREQUENCY' AND r.applicability IN {_REACH}"""):
        for d in _project(r["expression"], today)[:2]:
            key = (r["id"], d)
            if key in seen:
                continue
            seen.add(key)
            dl.append({"id": r["id"], "title": r["title"], "authority": r["authority"], "date": d.isoformat(),
                       "kind": f"{str(r['expression']).replace('_', ' ').lower().capitalize()} reporting"})
    # licence and registration renewals the hospital holds (expiry dates on file)
    import json as _json
    for r in con.execute("SELECT id, name, attrs FROM company_entities WHERE type='License'"):
        try:
            a = _json.loads(r["attrs"] or "{}")
        except Exception:                                        # noqa: BLE001
            continue
        exp = str(a.get("expiryDate") or a.get("validTill") or "")[:10]
        if re.match(r"\d{4}-\d{2}-\d{2}$", exp):
            dl.append({"id": r["id"], "title": f"{r['name']} renewal", "authority": a.get("issuedBy") or "",
                       "date": exp, "kind": "Licence expiry", "entity": True})
    for x in dl:
        x["days_left"] = (date.fromisoformat(x["date"]) - today).days
    dl = sorted((x for x in dl if x["days_left"] >= 0), key=lambda x: x["days_left"])[:6]

    # departments: the assessment's responsible role mapped onto departments
    dept: dict[str, dict] = {}
    for r in con.execute("""SELECT responsible, status FROM gap_assessments
                             WHERE status IN ('MET','PARTIAL','GAP','NOT_COVERED')"""):
        who = (r["responsible"] or "").lower()
        hits = [n for n, pat in DEPTS if re.search(pat, who)]
        for h in dict.fromkeys(hits):
            d = dept.setdefault(h, {"name": h, "met": 0, "partial": 0, "gap": 0, "not_covered": 0})
            key = {"MET": "met", "PARTIAL": "partial", "GAP": "gap", "NOT_COVERED": "not_covered"}[r["status"]]
            d[key] += 1
    for d in dept.values():
        d["total"] = d["met"] + d["partial"] + d["gap"] + d["not_covered"]
        d["open"] = d["total"] - d["met"]
    departments = sorted(dept.values(), key=lambda d: -d["open"])[:6]

    return {
        "company": {"name": prof.get("legal_name"), "state": prof.get("hq_state"), "city": city},
        "applicable": applicable, "documents": docs, "open_findings": open_findings,
        "totals": t, "pipeline": pipeline,
        "latest": dict(latest) if latest else None,
        "deadlines": dl, "departments": departments,
    }
