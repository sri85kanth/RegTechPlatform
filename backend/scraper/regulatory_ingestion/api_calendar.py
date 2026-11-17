"""
Regulatory calendar: what takes effect when, and what was detected changing.

TWO KINDS OF DATE, NEVER MERGED
-------------------------------
EFFECTIVE  the date a regulation starts binding, read out of the instrument's
           own commencement clause. This is the date a compliance officer
           actually plans around.

DETECTED   the date our watcher noticed a document had been reworded. It is a
           fact about our pipeline, not about the law.

Colouring one as the other would be wrong in exactly the way that gets somebody
fined, so they are separate event kinds and the UI labels them separately.

EFFECTIVE DATES CARRY THEIR BASIS
---------------------------------
STATED_DATE         the instrument names the date. An authoritative fact.
IMMEDIATE_ON_ISSUE  the instrument says "with immediate effect", so the date is
                    derived from issued_on. A system inference, flagged as one,
                    because a derived date must never be quoted as if the
                    regulator had printed it.

Regulations whose commencement is NOT_STATED carry no date and appear nowhere on
this calendar. They are counted in `unscheduled` instead, because a regulation
missing from a compliance calendar is itself a thing the user must know.
"""
from __future__ import annotations

import calendar as _cal
import re
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query
from .api_auth import require

from .db import connect

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"], dependencies=[Depends(require("read"))])

_MONTH = re.compile(r"^\d{4}-\d{2}$")
_APPLIES = ("APPLICABLE", "CONDITIONAL")

# ---------------------------------------------------------------- recurring --
#
# A reporting obligation that says "quarterly" is a real forward deadline, and
# it is the only forward-looking material this corpus holds: only two
# commencement dates in 1,759 regulations are still in the future.
#
# But "quarterly" is NOT a date. Placing it on 30 June is an inference from
# Indian financial-year convention, not something the regulator printed, so
# every projected entry is returned with basis DERIVED_FREQUENCY and the UI
# labels it as assumed. A projected date must never be presentable as a stated
# one — that is how a convention quietly becomes a claimed deadline.
#
# Frequencies that cannot be placed at all are excluded rather than guessed:
# "periodically" names no period, and daily/weekly would bury the calendar in
# entries nobody plans around.
_PERIOD_ENDS: dict[str, list[tuple[int, int]]] = {
    "annually":     [(3, 31)],
    "annual":       [(3, 31)],
    "yearly":       [(3, 31)],
    "half yearly":  [(9, 30), (3, 31)],
    "half-yearly":  [(9, 30), (3, 31)],
    "halfyearly":   [(9, 30), (3, 31)],
    "quarterly":    [(6, 30), (9, 30), (12, 31), (3, 31)],
    "once in a quarter": [(6, 30), (9, 30), (12, 31), (3, 31)],
}
_MONTHLY = {"monthly", "every month", "once a month"}
_HORIZON_MONTHS = 15


def _project(expr: str, today: date) -> list[date]:
    """Concrete dates for a frequency, from today out to the horizon."""
    e = (expr or "").strip().lower()
    out: list[date] = []
    end_y = today.year + 2

    if e in _MONTHLY:
        y, m = today.year, today.month
        for _ in range(_HORIZON_MONTHS):
            out.append(date(y, m, _cal.monthrange(y, m)[1]))
            m += 1
            if m > 12:
                m, y = 1, y + 1
        return [d for d in out if d >= today]

    ends = _PERIOD_ENDS.get(e)
    if not ends:
        return []
    for y in range(today.year, end_y + 1):
        for mo, dd in ends:
            out.append(date(y, mo, dd))
    horizon = date(today.year + 1, today.month, 1)
    return sorted(d for d in out if today <= d <= horizon)


@router.get("/calendar")
def calendar(month: str | None = Query(None, description="YYYY-MM; omit for everything")):
    if month and not _MONTH.match(month):
        raise HTTPException(400, "month must be YYYY-MM")

    con = connect()
    days: dict[str, dict] = {}

    def bucket(d: str) -> dict:
        return days.setdefault(d, {"date": d, "effective": [], "changes": [],
                                   "recurring": [],
                                   "effectiveCount": 0, "changeCount": 0,
                                   "recurringCount": 0,
                                   "appliesCount": 0, "sections": 0})

    # ---- 1. effective dates -------------------------------------------------
    w = "AND left(effective_from, 7) = ?" if month else ""
    p = (month,) if month else ()
    for r in con.execute(f"""
        SELECT id, title, regulator_short, effective_from, effective_basis,
               effective_evidence, applicability
          FROM regulations
         WHERE effective_from IS NOT NULL AND effective_from <> '' {w}
         ORDER BY effective_from DESC, title
    """, p).fetchall():
        b = bucket(r["effective_from"])
        applies = r["applicability"] in _APPLIES
        b["effective"].append({
            "id": r["id"], "title": r["title"], "regulator": r["regulator_short"],
            "basis": r["effective_basis"], "evidence": r["effective_evidence"],
            "applicability": r["applicability"], "applies": applies,
        })
        b["effectiveCount"] += 1
        b["appliesCount"] += 1 if applies else 0

    # ---- 2. detected changes ------------------------------------------------
    w2 = "WHERE left(dv.retrieved_at, 7) = ?" if month else ""
    for r in con.execute(f"""
        SELECT left(dv.retrieved_at, 10) AS day, sc.regulation_id AS rid,
               r.title, r.regulator_short, r.applicability, COUNT(*) AS sections
          FROM section_changes sc
          JOIN document_versions dv ON dv.id = sc.to_version
          JOIN regulations r        ON r.id  = sc.regulation_id
          {w2}
         GROUP BY 1,2,3,4,5 ORDER BY 1 DESC, 6 DESC
    """, p).fetchall():
        b = bucket(r["day"])
        applies = r["applicability"] in _APPLIES
        b["changes"].append({
            "id": r["rid"], "title": r["title"], "regulator": r["regulator_short"],
            "sections": r["sections"], "applicability": r["applicability"],
            "applies": applies,
        })
        b["changeCount"] += 1
        b["sections"] += r["sections"]
        b["appliesCount"] += 1 if applies else 0

    # ---- 3. projected recurring obligations (derived, applicable only) ------
    today = date.today()
    for r in con.execute(f"""
        SELECT tr.expression, tr.rule_type, tr.source_text,
               lp.regulation_id AS rid, r.title, r.regulator_short, r.applicability
          FROM timing_rules tr
          JOIN legal_provisions lp ON lp.id = tr.provision_id
          JOIN regulations r       ON r.id  = lp.regulation_id
         WHERE tr.rule_type = 'FREQUENCY'
           AND r.applicability IN ('APPLICABLE', 'CONDITIONAL')
    """).fetchall():
        for d in _project(r["expression"], today):
            iso = d.isoformat()
            if month and not iso.startswith(month):
                continue
            b = bucket(iso)
            if any(x["id"] == r["rid"] and x["expression"] == r["expression"]
                   for x in b["recurring"]):
                continue
            b["recurring"].append({
                "id": r["rid"], "title": r["title"], "regulator": r["regulator_short"],
                "expression": r["expression"], "sourceText": r["source_text"],
                "basis": "DERIVED_FREQUENCY", "applies": True,
            })
            b["recurringCount"] += 1
            b["appliesCount"] += 1

    for b in days.values():
        b["effective"].sort(key=lambda x: (not x["applies"], x["title"]))
        b["changes"].sort(key=lambda x: (not x["applies"], -x["sections"]))

    ordered = sorted(days.values(), key=lambda d: d["date"], reverse=True)

    # ---- 3. what the calendar cannot show, stated plainly --------------------
    cov = {r["basis"] or "NO_SECTIONS": r["n"] for r in con.execute("""
        SELECT COALESCE(effective_basis, 'NO_SECTIONS') AS basis, COUNT(*) AS n
          FROM regulations GROUP BY 1""").fetchall()}

    upcoming = [dict(r) for r in con.execute("""
        SELECT id, title, effective_from, effective_basis, applicability
          FROM regulations
         WHERE effective_from >= to_char(now(), 'YYYY-MM-DD')
         ORDER BY effective_from LIMIT 20""").fetchall()]

    return {
        "month": month,
        "days": ordered,
        "upcoming": upcoming,
        "coverage": {
            "statedDate": cov.get("STATED_DATE", 0),
            "immediateOnIssue": cov.get("IMMEDIATE_ON_ISSUE", 0),
            "notStated": cov.get("NOT_STATED", 0),
            "noSections": cov.get("NO_SECTIONS", 0),
        },
        "today": date.today().isoformat(),
        "legend": {
            "RECURRING": "A reporting obligation whose frequency we read from the "
                         "text; the exact day is assumed from period-end convention.",
            "EFFECTIVE": "The date the regulation starts binding, from its own commencement clause.",
            "DETECTED": "The date our watcher noticed the document had been reworded.",
        },
    }
