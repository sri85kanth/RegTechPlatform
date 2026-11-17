"""
Which regulations reach each department — the "By department" view of
"What applies to us".

A department is read from the role the gap assessment names as responsible
for each requirement ("Head - HR", "Laboratory Head / Quality Manager"),
mapped with the same keyword sets the dashboard and the regulation page use
(api_reg_overview.DEPTS). A role those sets do not know gets a second pass
here (payroll, RSO, blood centre, ethics committee …) before it falls to
"Not assigned", so the long tail lands somewhere a person can act on.

Only requirements the assessment found applicable are counted; nothing is
recomputed, so a regulation's numbers here add up to its own page.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends

from .api_auth import require
try:
    from .api_reg_overview import DEPTS
except ImportError:  # an api_reg_overview without the shared list: the same keyword sets
    DEPTS = [
        ("Nursing", r"nurs|cno|ward"),
        ("Medical / Clinical", r"medical director|doctor|consultant|clinical|anaesth|physician|surgeon|hod|medical superintendent"),
        ("Quality", r"quality|patient safety|accreditation"),
        ("Administration", r"management|governing|administrat|board|ceo|director(?! of nursing)|leadership"),
        ("HR", r"hr|human resource|training|personnel"),
        ("Biomedical / Engineering", r"bme|biomedical|engineering|maintenance"),
        ("Pharmacy", r"pharm|drug"),
        ("Laboratory", r"lab|patholog|blood bank|transfusion"),
        ("Radiology", r"radiolog|imaging|x-ray|nuclear"),
        ("Infection Control", r"infection"),
        ("Facilities & Safety", r"facilit|fire|disaster|safety officer|security|housekeeping|engineer"),
        ("Medical Records & IT", r"record|it|information|mrd"),
    ]
from .db import connect

router = APIRouter(prefix="/api/applies", tags=["applicability"], dependencies=[Depends(require("read"))])

# second pass, only for roles DEPTS does not place
MORE = [
    ("Finance & Statutory", r"payroll|financ|tax|billing|account|company secretary|legal|purchase"),
    ("Radiology", r"\brso\b|licensee|medical physicist|radiation"),
    ("Laboratory", r"blood cent|microbiolog"),
    ("Food & Dietary", r"food|dietar|beverage|kitchen"),
    ("Ethics & Research", r"ethic|\biec\b|\bec\b|investigator"),
    ("Medical Records & IT", r"data protection|\bdpo\b|\bir lead"),
    ("Facilities & Safety", r"medical gas|porter|environment|\bbmw\b"),
    ("Infection Control", r"cssd"),
    ("Medical / Clinical", r"emergency|obstetric|\bcmo\b|code blue|\bed head"),
    ("Pharmacy", r"p&t"),
    ("HR", r"\bic presiding|posh"),
    ("Quality", r"patient relation"),
]
NONE = "Not assigned"
OPEN = ("PARTIAL", "GAP", "NOT_COVERED")


def departments_of(responsible: str | None) -> list[str]:
    who = (responsible or "").lower()
    hits = [n for n, p in DEPTS if re.search(p, who)] or [n for n, p in MORE if re.search(p, who)]
    return list(dict.fromkeys(hits)) or [NONE]


@router.get("/by-department")
def by_department():
    con = connect()
    rows = con.execute(
        """SELECT g.regulation_id, g.responsible, g.status, g.risk,
                  r.title, r.regulator_short,
                  (SELECT a.verdict FROM applicability_results a
                    WHERE a.regulation_id = g.regulation_id LIMIT 1) AS verdict
             FROM gap_assessments g
             JOIN regulations r ON r.id = g.regulation_id
            WHERE g.status <> 'NOT_APPLICABLE'""").fetchall()

    depts: dict[str, dict] = {}
    for row in rows:
        d = dict(row)
        status = d["status"]
        for name in departments_of(d["responsible"]):
            dep = depts.setdefault(name, {"name": name, "requirements": 0, "met": 0, "partial": 0, "gap": 0,
                                          "not_covered": 0, "critical_open": 0, "_regs": {}})
            reg = dep["_regs"].setdefault(d["regulation_id"], {
                "id": d["regulation_id"], "title": d["title"], "regulator": d["regulator_short"],
                "verdict": d["verdict"], "requirements": 0, "met": 0, "partial": 0, "gap": 0,
                "not_covered": 0, "critical_open": 0, "roles": {}})
            key = {"MET": "met", "PARTIAL": "partial", "GAP": "gap", "NOT_COVERED": "not_covered"}.get(status)
            for x in (dep, reg):
                x["requirements"] += 1
                if key:
                    x[key] += 1
                if status in OPEN and d["risk"] == "Critical":
                    x["critical_open"] += 1
            # "Head – HR" and "Head - HR" are one role
            role = " ".join(re.sub(r"[–—]", "-", d["responsible"] or "").split())
            if role:
                reg["roles"][role] = reg["roles"].get(role, 0) + 1

    out = []
    for dep in depts.values():
        regs = []
        for r in dep.pop("_regs").values():
            r["open"] = r["partial"] + r["gap"] + r["not_covered"]
            # the roles named most often, so a reader sees who inside the department
            r["roles"] = [k for k, _ in sorted(r["roles"].items(), key=lambda kv: -kv[1])[:3]]
            regs.append(r)
        regs.sort(key=lambda r: (-r["critical_open"], -r["open"], -r["requirements"], r["title"] or ""))
        dep["open"] = dep["partial"] + dep["gap"] + dep["not_covered"]
        dep["regulations"] = len(regs)
        dep["items"] = regs
        out.append(dep)
    out.sort(key=lambda d: (d["name"] == NONE, -d["open"], d["name"]))
    return {"departments": out, "requirements": len(rows),
            "regulations": len({dict(r)["regulation_id"] for r in rows})}
