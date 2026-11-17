"""
GET /api/reg-overview/{rid} — everything the regulation Overview tab shows that
the existing endpoints do not already return, in one call.

Every figure is read from rows that exist; nothing is estimated or written for
the page:
  about        a factual description composed from the record (type, issuer,
               in-force date, duty and section counts, the main sections)
  totals       requirement verdicts and the risk bands of the unmet ones
               (gap_assessments)
  sections     requirements per chapter / section, with how many are unmet
  departments  requirements per responsible department — the assessment's
               "responsible" text mapped onto the hospital's departments
  impact       the stored impact score and the factors it was computed from
               (impact_scores.factors)
  updates      the latest amendments the text records, and detected wording changes
  documents    the source document(s) on file, plus guidebook / extra material
               indexed for this regulation
  related      other regulations that reach the hospital from the same
               regulator or sector
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException

from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/reg-overview", tags=["regulation overview"],
                   dependencies=[Depends(require("read"))])

# responsible-role text → hospital department (first match wins per keyword set;
# a role naming two departments counts for both)
DEPTS = [
    ("Nursing", r"nurs|cno|ward"),
    ("Medical / Clinical", r"medical director|doctor|consultant|clinical|anaesth|physician|surgeon|hod|medical superintendent"),
    ("Quality", r"quality|patient safety|accreditation"),
    ("Administration", r"management|governing|administrat|board|ceo|director(?! of nursing)|leadership"),
    ("HR", r"\bhr\b|human resource|training|personnel"),
    ("Biomedical / Engineering", r"bme|biomedical|engineering|maintenance"),
    ("Pharmacy", r"pharm|drug"),
    ("Laboratory", r"lab|patholog|blood bank|transfusion"),
    ("Radiology", r"radiolog|imaging|x-ray|nuclear"),
    ("Infection Control", r"infection"),
    ("Facilities & Safety", r"facilit|fire|disaster|safety officer|security|housekeeping|engineer"),
    ("Medical Records & IT", r"record|\bit\b|information|mrd"),
]


def _first(d: dict, *keys):
    for k in keys:
        if d.get(k):
            return d[k]
    return None


@router.get("/{rid}")
def overview(rid: str):
    con = connect()
    reg = con.execute("SELECT * FROM regulations WHERE id=?", (rid,)).fetchone()
    if not reg:
        raise HTTPException(404, "no such regulation")
    reg = dict(reg)

    # ---- totals from the gap assessment
    t = con.execute(
        """SELECT count(*) AS total,
                  count(*) FILTER (WHERE status <> 'NOT_APPLICABLE') AS applicable,
                  count(*) FILTER (WHERE status = 'MET') AS met,
                  count(*) FILTER (WHERE status = 'PARTIAL') AS partial,
                  count(*) FILTER (WHERE status = 'GAP') AS gap,
                  count(*) FILTER (WHERE status = 'NOT_COVERED') AS not_covered,
                  count(*) FILTER (WHERE status = 'NOT_APPLICABLE') AS not_applicable,
                  count(*) FILTER (WHERE status = 'NOT_ASSESSED') AS not_assessed,
                  count(*) FILTER (WHERE risk = 'Critical' AND status <> 'NOT_ASSESSED') AS critical,
                  count(*) FILTER (WHERE risk = 'High' AND status <> 'NOT_ASSESSED') AS high,
                  count(*) FILTER (WHERE risk = 'Medium' AND status <> 'NOT_ASSESSED') AS medium,
                  count(*) FILTER (WHERE risk = 'Low' AND status <> 'NOT_ASSESSED') AS low
             FROM v_requirement_assessments WHERE regulation_id=?""", (rid,)).fetchone()
    totals = dict(t) if t else {}
    assessed = bool(totals.get("total"))

    # ---- sections
    if assessed:
        sections = [dict(r) for r in con.execute(
            """SELECT coalesce(nullif(unit_group,''), unit_code, 'General') AS name, count(*) AS requirements,
                      count(*) FILTER (WHERE status IN ('PARTIAL','GAP','NOT_COVERED')) AS unmet
                 FROM v_requirement_assessments WHERE regulation_id=? AND status <> 'NOT_APPLICABLE'
                GROUP BY 1 ORDER BY min(position) LIMIT 12""", (rid,))]
    else:
        sections = [dict(r) for r in con.execute(
            """SELECT trim(coalesce('§' || nullif(s.section_number,'') || ' ', '') || left(coalesce(s.section_title,''), 70)) AS name,
                      count(o.id) AS requirements, 0 AS unmet
                 FROM sections s LEFT JOIN obligations o ON o.section_id = s.id
                WHERE s.regulation_id=? GROUP BY s.id, 1 HAVING count(o.id) > 0
                ORDER BY count(o.id) DESC LIMIT 8""", (rid,))]
    n_sections = con.execute("SELECT count(*) FROM sections WHERE regulation_id=?", (rid,)).fetchone()[0]
    n_obl = con.execute("SELECT count(*) FROM obligations WHERE regulation_id=?", (rid,)).fetchone()[0]

    # ---- departments
    dept: dict[str, list[int]] = {}
    for r in con.execute("""SELECT responsible, status FROM v_requirement_assessments
                             WHERE regulation_id=? AND status <> 'NOT_APPLICABLE'""", (rid,)):
        who = (r["responsible"] or "").lower()
        hits = [name for name, pat in DEPTS if re.search(pat, who)] or ["Others"]
        for h in dict.fromkeys(hits):
            c = dept.setdefault(h, [0, 0])
            c[0] += 1
            c[1] += r["status"] in ("PARTIAL", "GAP", "NOT_COVERED")
    departments = sorted(({"name": k, "requirements": v[0], "unmet": v[1]} for k, v in dept.items()),
                         key=lambda d: (d["name"] == "Others", -d["requirements"]))[:8]

    # ---- impact
    imp = con.execute("SELECT * FROM impact_scores WHERE regulation_id=?", (rid,)).fetchone()
    factors = []
    if imp:
        imp = dict(imp)
        try:
            f = json.loads(imp.get("factors") or imp.get("detail") or "{}")
        except Exception:                                        # noqa: BLE001
            f = {}
        sev = (f.get("severity") or {}).get("factor")
        lik = (f.get("likelihood") or {}).get("factor")
        dl = (f.get("deadline") or {}).get("multiplier")
        cov = (f.get("mitigation") or {}).get("coverage")
        expo = f.get("gross_exposure")
        for label, val, note in [
            ("Severity", sev, (f.get("severity") or {}).get("from")),
            ("Likelihood", lik, (f.get("likelihood") or {}).get("from")),
            ("Time pressure", (dl / 1.5) if dl else None, (f.get("deadline") or {}).get("why")),
            ("Exposure", min(1.0, expo / 150) if expo else None, f"{expo} weighted records and duties" if expo else None),
            ("Not yet mitigated", (1 - cov) if cov is not None else None, f"{round((cov or 0) * 100)}% covered by controls" if cov is not None else None),
        ]:
            if val is not None:
                factors.append({"label": label, "score": round(min(1.0, float(val)) * 10, 1), "note": note})
    impact = {"score": reg.get("impact_score"), "level": reg.get("impact_level"), "factors": factors}

    # ---- updates
    updates = []
    for a in con.execute("""SELECT * FROM regulation_amendments WHERE regulation_id=?
                             ORDER BY coalesce(amended_on, effective_date, '') DESC LIMIT 4""", (rid,)):
        a = dict(a)
        updates.append({"kind": "Amendment", "date": _first(a, "amended_on", "effective_date"),
                        "title": _first(a, "instrument", "action", "meaning") or "Amendment recorded in the text",
                        "detail": " · ".join(x for x in [a.get("section_number") and f"Section {a['section_number']}",
                                                         a.get("reference")] if x) or None})
    ch = con.execute("""SELECT count(*) AS n, max(detected_at) AS last FROM section_changes WHERE regulation_id=?""",
                     (rid,)).fetchone()
    if ch and ch["n"]:
        updates.insert(0, {"kind": "Wording change", "date": (ch["last"] or "")[:10],
                           "title": f"{ch['n']} sections reworded since the previous captured version",
                           "detail": "Detected by comparing captured versions"})

    # ---- documents
    docs = []
    src = _first(reg, "official_document_url", "source_url")
    if src:
        docs.append({"title": f"{reg.get('short_title') or reg['title']} (official source)", "kind": "Official document",
                     "url": src})
    for d in con.execute("SELECT * FROM documents WHERE regulation_id=? ORDER BY created_at DESC LIMIT 3", (rid,)):
        d = dict(d)
        docs.append({"title": d.get("file_name") or "Document on file",
                     "kind": f"{(d.get('file_type') or 'file').upper()} · {d.get('page_count') or '?'} pages",
                     "url": d.get("source_url")})
    try:
        from . import rag
        pcon = rag.connect_pg()
        with pcon.cursor() as cur:
            cur.execute("""SELECT source_table, count(*) FROM chunks WHERE regulation_id=%s
                            AND source_table IN ('guidebook','upload') GROUP BY 1""", (rid,))
            for table, n in cur.fetchall():
                label = {"guidebook": "Guidebook / implementation guide (indexed)",
                         "upload": "Uploaded document (indexed)"}.get(table, f"{table} (indexed)")
                docs.append({"title": label, "kind": f"{n} passages searchable in Knowledge Search", "url": None,
                             "search": True})
    except Exception:                                            # noqa: BLE001 — RAG optional
        pass

    # ---- related regulations that reach us
    related = [dict(r) for r in con.execute(
        """SELECT r.id, coalesce(nullif(r.short_title,''), r.title) AS title,
                  coalesce(nullif(r.regulator_short,''), r.regulator) AS regulator,
                  (r.regulator_short = ?) AS same_regulator
             FROM regulations r
            WHERE r.applicability IN ('APPLICABLE','CONDITIONAL')
              AND r.id <> ? AND (r.regulator_short = ? OR r.sector = ?)
              AND EXISTS (SELECT 1 FROM v_requirement_assessments g WHERE g.regulation_id = r.id
                          AND g.status NOT IN ('NOT_APPLICABLE','NOT_ASSESSED'))
            ORDER BY (r.regulator_short = ?) DESC, r.impact_score DESC NULLS LAST
            LIMIT 4""",
        (reg.get("regulator_short"), rid, reg.get("regulator_short"), reg.get("sector"), reg.get("regulator_short")))]

    # ---- about: composed from the record, said as fact
    top = ", ".join(s["name"].split(" · ")[-1] for s in sections[:4])
    about = (f"{reg['title']} is {('an' if (reg.get('regulation_type') or 'x')[0].lower() in 'aeiou' else 'a')} "
             f"{(reg.get('regulation_type') or 'regulatory instrument').lower()} issued by "
             f"{reg.get('regulator') or 'the regulator'}"
             + (f", in force from {reg['effective_from']}" if reg.get("effective_from") else "") + ". "
             + (f"It sets {totals['applicable']:,} requirements for the hospital across {len(sections)} chapters"
                + (f", covering {top}{' and more' if len(sections) > 4 else ''}." if top else ".")
                if assessed and totals.get("applicable") else
                f"It contains {n_obl:,} extracted duties across {n_sections:,} sections; it has not been assessed "
                "against the hospital's documents." if n_obl else "No duties have been extracted from it yet."))

    return {"about": about, "totals": totals, "assessed": assessed, "sections": sections,
            "departments": departments, "impact": impact, "updates": updates, "documents": docs,
            "related": related, "counts": {"sections": n_sections, "obligations": n_obl}}
