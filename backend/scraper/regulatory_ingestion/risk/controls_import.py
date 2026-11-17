"""
Getting controls into the register in bulk (design §6 (b), Phase 3 follow-up).

A library risk cannot be scored until its controls are known, and "unknown"
is never taken as "absent" or as "working". Typing them in one risk at a time
is where a first register stalls, so there are two bulk paths:

  matches    the controls the company already records — the control library
             (`controls`, with tests and evidence links) and controls imported
             as company records — matched to each risk's typical controls by
             the words they share. Each match proposes a grade from that
             record's own state, says why, and is applied only when a person
             chooses it.
  workbook   every risk and its typical controls in one spreadsheet, prefilled
             with what is known. A person fills in grade, evidence and date
             (in Excel, or as CSV), uploads it, sees each row checked, and
             applies the rows that pass.

Both write through review.record_control, so the same rules hold: a reviewer
may record a control only as self-declared or absent; documented and tested
need a compliance manager, the evidence and its date; nothing is dated in the
future. Matching is deterministic (shared words, weighted by how rare they
are), so the same records always give the same proposals.
"""
from __future__ import annotations

import base64
import csv
import io
import math
import re
from collections import Counter
from datetime import date, datetime
from typing import Any

from . import intake as I
from . import library as L
from . import register as G
from . import review as V
from .intake import IntakeError

GRADE_WORD = {"TESTED": "Tested", "DOCUMENTED": "Documented", "CLAIMED": "Self-declared", "ABSENT": "Absent"}
WORD_GRADE = {"tested": "TESTED", "documented": "DOCUMENTED", "self-declared": "CLAIMED", "self declared": "CLAIMED",
              "claimed": "CLAIMED", "absent": "ABSENT", "not in place": "ABSENT"}
COLUMNS = ("Risk ID", "Risk", "Theme", "Covers", "Control key", "Control", "Kind",
           "Grade", "Evidence", "Evidence date", "Note")
STRONG, POSSIBLE = 0.5, 0.3
MAX_FILE = 5 * 1024 * 1024

# words that say nothing about which control it is
STOP = set("""a an and are as at be by for from has have in into is it its of on or that the this to with without
within their there they we our all any each every per via more most other such than then when where which who will
would should shall can could may must not no yes use used using based ensure ensured regular regularly properly
appropriate adequate process processes control controls policy policies procedure procedures risk risks
organisation organization company""".split())
# the same idea in two spellings: register shorthand on one side, a control's name on the other
SYNONYMS = {
    "va": ["vulnerability", "assessment"], "pt": ["penetration", "test"], "vapt": ["vulnerability", "penetration", "test"],
    "mfa": ["multi", "factor", "authentication"], "2fa": ["multi", "factor", "authentication"],
    "dr": ["disaster", "recovery"], "bcp": ["continuity", "plan"], "bcm": ["continuity"],
    "kyc": ["know", "customer", "verification"], "aml": ["money", "laundering"], "siem": ["security", "monitoring"],
    "dlp": ["data", "loss", "prevention"], "iam": ["identity", "access"], "pam": ["privileged", "access"],
    "sod": ["segregation", "duties"], "nda": ["confidentiality", "agreement"], "sla": ["service", "level"],
    "recert": ["review"], "recertification": ["review"], "backups": ["backup"], "patching": ["patch"],
}


def _stem(w: str) -> str:
    for suf in ("ations", "ation", "ings", "ing", "ies", "ed", "es", "s"):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[: -len(suf)] + ("y" if suf == "ies" else "")
    return w


def words(text: str) -> set[str]:
    out: set[str] = set()
    for w in re.findall(r"[a-z0-9]+", (text or "").lower()):
        for x in SYNONYMS.get(w, [w]):
            if len(x) >= 3 and x not in STOP:
                out.add(_stem(x))
    return out


def _loose_date(v: Any) -> str | None:
    """A date as people write it. A month alone ('Jun 2026') is its first day: older is the safe side for evidence."""
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError:
        pass
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            return None
    m = re.match(r"^([A-Za-z]{3})[a-z]*\.?[\s-]+(\d{4})$", s)
    months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    if m and m.group(1).lower() in months:
        return date(int(m.group(2)), months.index(m.group(1).lower()) + 1, 1).isoformat()
    return None


# ------------------------------------------------------------------ the controls the company already records
def _try(con, sql: str, args: tuple = ()) -> list[dict]:
    try:
        return G._rows(con, sql, args)     # noqa: SLF001
    except Exception:  # noqa: BLE001 — a workspace without that table yet
        try:
            con.rollback()
        except Exception:  # noqa: BLE001
            pass
        return []


def existing_controls(con) -> list[dict]:
    """Controls from the control library and from company records, each with what shows it works."""
    out = []
    for c in _try(con, "SELECT * FROM controls"):
        ev = _try(con, """SELECT e.name, e.valid_from, e.uploaded_at FROM evidence_links l JOIN evidence e ON e.id = l.evidence_id
                          WHERE l.control_id=?""", (c["id"],))
        tests = _try(con, "SELECT result, performed_at FROM compliance_tests WHERE control_id=? AND performed_at IS NOT NULL "
                          "ORDER BY performed_at DESC", (c["id"],))
        out.append({"id": f"control:{c['id']}", "name": c["name"], "description": c.get("description") or "",
                    "kind": (c.get("control_type") or "").lower(), "frequency": c.get("frequency"),
                    "effectiveness": c.get("effectiveness"), "last_tested": _loose_date(c.get("last_tested")),
                    "evidence": [{"name": e["name"], "on": _loose_date(e.get("valid_from") or e.get("uploaded_at"))} for e in ev],
                    "last_test": tests[0] if tests else None})
    rels = _try(con, "SELECT source_id, target_id FROM entity_relationships WHERE lower(type) LIKE '%evidence%'")
    names = {e["id"]: e for e in _try(con, "SELECT id, name, attrs FROM company_entities")}
    for e in _try(con, "SELECT * FROM company_entities WHERE lower(type)='control' OR lower(domain)='controls'"):
        attrs = G._j(e.get("attrs"), {})     # noqa: SLF001
        attrs = attrs if isinstance(attrs, dict) else {}
        ev = [{"name": names[r["target_id"]]["name"], "on": _loose_date((G._j(names[r["target_id"]].get("attrs"), {}) or {}).get("date"))}  # noqa: SLF001
              for r in rels if r["source_id"] == e["id"] and r["target_id"] in names]
        out.append({"id": f"entity:{e['id']}", "name": e["name"], "description": e.get("description") or "",
                    "kind": str(attrs.get("type") or attrs.get("controlType") or "").lower(),
                    "frequency": attrs.get("frequency"), "effectiveness": e.get("status") or attrs.get("effectiveness"),
                    "last_tested": _loose_date(attrs.get("lastTested") or attrs.get("last_tested")),
                    "evidence": ev, "last_test": None})
    return out


def proposed_grade(c: dict) -> dict:
    """What the record itself shows: {grade, evidence, evidence_on, why}. Never better than its evidence."""
    eff = str(c.get("effectiveness") or "").lower()
    t = c.get("last_test")
    ev = c.get("evidence") or []
    first = ev[0]["name"] if ev else None
    if t and str(t["result"]).upper() == "PASS":
        return {"grade": "TESTED", "evidence": f"Test passed: {c['name']}", "evidence_on": _loose_date(t["performed_at"]),
                "why": "a recorded test passed"}
    if (t and str(t["result"]).upper() == "FAIL") or eff.startswith("ineffective") or eff == "not effective":
        return {"grade": "ABSENT", "evidence": None, "evidence_on": None, "why": "tested and found not working"}
    if eff == "effective" and c.get("last_tested") and ev:
        return {"grade": "TESTED", "evidence": first, "evidence_on": c["last_tested"],
                "why": "marked effective, with a test date and evidence"}
    dated = next((e for e in ev if e.get("on")), None)
    if ev and (dated or c.get("last_tested")):
        return {"grade": "DOCUMENTED", "evidence": (dated or ev[0])["name"],
                "evidence_on": (dated or {}).get("on") or c.get("last_tested"), "why": "evidence on file, no passed test"}
    return {"grade": "CLAIMED", "evidence": None, "evidence_on": None,
            "why": "recorded as a control, but nothing on file shows it works"}


# ------------------------------------------------------------------ matching
def _targets(con, lib: L.Library) -> list[dict]:
    """Every active risk's typical controls that are not yet known."""
    out = []
    for r in G._rows(con, "SELECT * FROM risks WHERE retired_at IS NULL AND template_id IS NOT NULL ORDER BY title"):     # noqa: SLF001
        t = lib.get(r["template_id"])
        if not t:
            continue
        known = {x["control_key"] for x in G.current_ratings(con, r["id"])}
        for i, c in enumerate(t.get("typical_controls") or []):
            key = f"tc-{i + 1}"
            if key in known:
                continue
            context = " ".join(str(t.get(k) or "") for k in ("control_area", "process"))
            out.append({"risk_id": r["id"], "risk_title": r["title"], "control_key": key, "control": c.get("text") or "",
                        "interval_days": min(c.get("intervals_days") or [0]) or None,
                        "words": words(f"{c.get('text')} {context}")})
    return out


def matches(con, lib: L.Library, limit_per_control: int = 2) -> dict:
    """Proposals: for each unknown typical control, the existing controls that share its rarer words."""
    have = existing_controls(con)
    targets = _targets(con, lib)
    docs = [words(f"{c['name']} {c['description']}") for c in have]
    df = Counter(w for d in docs + [t["words"] for t in targets] for w in d)
    n = len(docs) + len(targets) or 1
    idf = {w: math.log(1 + n / k) for w, k in df.items()}
    out = []
    for t in targets:
        scored = []
        for c, d in zip(have, docs):
            shared = t["words"] & d
            if not shared:
                continue
            base = min(sum(idf[w] for w in t["words"]), sum(idf[w] for w in d)) or 1
            score = round(sum(idf[w] for w in shared) / base, 2)
            if score >= POSSIBLE:
                scored.append((score, c, shared))
        for score, c, shared in sorted(scored, key=lambda x: (-x[0], x[1]["name"]))[:limit_per_control]:
            g = proposed_grade(c)
            out.append({"riskId": t["risk_id"], "riskTitle": t["risk_title"], "controlKey": t["control_key"],
                        "control": t["control"], "sourceId": c["id"], "sourceName": c["name"],
                        "strength": "strong" if score >= STRONG else "possible", "score": score,
                        "shared": sorted(shared), **g})
    return {"existing": len(have), "unknownControls": len(targets), "items": out}


def apply_matches(con, rb, lib: L.Library, items: list[dict], user: dict) -> dict:
    """Record the chosen matches. Each row passes or fails on its own; the passing ones are written together."""
    have = {c["id"]: c for c in existing_controls(con)}
    typical = {(t["risk_id"], t["control_key"]): t for t in _targets(con, lib)}
    done, problems, risks = [], [], set()
    for it in items or []:
        key = (it.get("riskId"), it.get("controlKey"))
        c, t = have.get(it.get("sourceId")), typical.get(key)
        if not c or not t:
            problems.append({**it, "message": "no longer open: the control is known already, or the record changed"})
            continue
        g = proposed_grade(c)
        data = {"control_key": t["control_key"], "label": t["control"], "kind": c["kind"] if c["kind"] in
                ("preventive", "detective", "corrective") else "preventive", "grade": g["grade"],
                "evidence": g["evidence"], "evidence_on": g["evidence_on"], "interval_days": t["interval_days"],
                "note": f"Mapped from “{c['name']}”: {g['why']}."}
        try:
            V.record_control(con, t["risk_id"], data, user, source=c["id"], commit=False)
            done.append(key)
            risks.add(t["risk_id"])
        except (IntakeError, PermissionError) as e:
            problems.append({**it, "message": str(e)})
    con.commit()
    run = G.run(con, rb, lib, actor=V.actor(user), trigger="controls imported", risk_ids=sorted(risks)) if risks else None
    return {"applied": len(done), "problems": problems, "rescored": len(risks), "run": run}


# ------------------------------------------------------------------ the workbook
def _rows_for_workbook(con, lib: L.Library) -> list[dict]:
    out = []
    for r in G._rows(con, "SELECT * FROM risks WHERE retired_at IS NULL ORDER BY theme, title"):     # noqa: SLF001
        t = lib.get(r["template_id"]) if r.get("template_id") else None
        ratings = {x["control_key"]: x for x in G.current_ratings(con, r["id"])}
        covers = ", ".join(x["label"].split(" — ", 1)[-1] for x in G._rows(     # noqa: SLF001
            con, "SELECT label FROM risk_exposures WHERE risk_id=? AND active=1", (r["id"],)) if x["label"])[:200]
        keys = [(f"tc-{i + 1}", c.get("text") or "") for i, c in enumerate((t or {}).get("typical_controls") or [])]
        keys += [(k, x["label"]) for k, x in ratings.items() if not k.startswith("tc-")]
        for key, text in keys:
            x = ratings.get(key)
            out.append({"Risk ID": r["id"], "Risk": r["title"], "Theme": r["theme"] or "",
                        "Covers": covers, "Control key": key, "Control": text, "Kind": (x or {}).get("kind") or "preventive",
                        "Grade": GRADE_WORD.get((x or {}).get("grade"), ""), "Evidence": (x or {}).get("evidence") or "",
                        "Evidence date": (x or {}).get("evidence_on") or "", "Note": ""})
    return out


def workbook(con, lib: L.Library, themes: dict[str, str] | None = None) -> bytes:
    """Every risk and its controls, prefilled with what is known, ready to fill in Excel."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation

    rows = _rows_for_workbook(con, lib)
    wb = Workbook()
    ws = wb.active
    ws.title = "Controls"
    ws.append(list(COLUMNS))
    head, fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="1D4ED8")
    give = PatternFill("solid", fgColor="FEF9C3")
    for cell in ws[1]:
        cell.font, cell.fill = head, fill
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for r in rows:
        r = {**r, "Theme": (themes or {}).get(r["Theme"], r["Theme"])}
        ws.append([r[c] for c in COLUMNS])
    for i, c in enumerate(COLUMNS, start=1):
        letter = ws.cell(row=1, column=i).column_letter
        ws.column_dimensions[letter].width = {"Risk ID": 18, "Risk": 48, "Theme": 20, "Covers": 28, "Control key": 11,
                                              "Control": 56, "Kind": 12, "Grade": 15, "Evidence": 36,
                                              "Evidence date": 14, "Note": 30}[c]
        if c in ("Grade", "Evidence", "Evidence date", "Note"):
            for row in ws.iter_rows(min_row=2, min_col=i, max_col=i):
                row[0].fill = give
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions
    dv = DataValidation(type="list", formula1='"Tested,Documented,Self-declared,Absent"', allow_blank=True,
                        error="Choose Tested, Documented, Self-declared or Absent", errorTitle="Grade")
    kinds = DataValidation(type="list", formula1='"preventive,detective,corrective"', allow_blank=True)
    ws.add_data_validation(dv)
    ws.add_data_validation(kinds)
    if rows:
        dv.add(f"H2:H{len(rows) + 1}")
        kinds.add(f"G2:G{len(rows) + 1}")
    how = wb.create_sheet("How to fill")
    for line in (
        ["How to fill in the control workbook"],
        [],
        ["Fill the yellow columns: Grade, Evidence, Evidence date (YYYY-MM-DD) and, if you like, Note."],
        ["Leave Grade blank for a control you do not know yet: the row is skipped."],
        ["Do not change Risk ID or Control key: they say which risk and control the row is about."],
        ["To add a control of your own, copy a row of that risk, clear Control key, and write the control's name."],
        [],
        ["Grade", "Meaning", "Needs"],
        ["Tested", "Approved, and tested or audited recently", "Evidence and the date of the test; a compliance manager"],
        ["Documented", "An approved document, not yet tested", "Evidence and the date of the document's review; a compliance manager"],
        ["Self-declared", "Someone says it exists; nothing shows it yet", "Nothing. On a high risk, someone else is asked to validate it"],
        ["Absent", "Confirmed not in place", "Nothing"],
        [],
        ["An unknown control is never taken as absent or as working: the risk stays “can't score yet” until it is known."],
    ):
        how.append(line)
    how["A1"].font = Font(bold=True, size=14)
    for cell in how[8]:
        cell.font = Font(bold=True)
    how.column_dimensions["A"].width, how.column_dimensions["B"].width, how.column_dimensions["C"].width = 22, 48, 70
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _read(file_name: str, content_b64: str) -> list[dict]:
    try:
        raw = base64.b64decode(content_b64 or "", validate=True)
    except (ValueError, TypeError):
        raise IntakeError("the file could not be read") from None
    if not raw:
        raise IntakeError("the file is empty")
    if len(raw) > MAX_FILE:
        raise IntakeError("the file is larger than 5 MB")
    name = (file_name or "").lower()
    if name.endswith(".csv"):
        text = raw.decode("utf-8-sig", errors="replace")
        return [dict(r) for r in csv.DictReader(io.StringIO(text))]
    if not name.endswith((".xlsx", ".xlsm")):
        raise IntakeError("upload the workbook as .xlsx, or as .csv")
    import openpyxl
    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception:  # noqa: BLE001 — a corrupt or non-Excel file
        raise IntakeError("the file is not a readable Excel workbook") from None
    ws = wb["Controls"] if "Controls" in wb.sheetnames else wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    header = [str(h or "").strip() for h in next(it, [])]
    return [{header[i]: v for i, v in enumerate(row) if i < len(header) and header[i]} for row in it]


def check_workbook(con, file_name: str, content_b64: str, user: dict) -> dict:
    """Each row checked as if typed in: ready, unchanged, skipped (no grade) or a problem with the reason."""
    rows = _read(file_name, content_b64)
    if rows and not {"Risk ID", "Grade"} <= set(rows[0]):
        raise IntakeError("this is not the control workbook: the Risk ID and Grade columns are missing")
    risks = {r["id"]: r for r in G._rows(con, "SELECT id, title, retired_at FROM risks")}     # noqa: SLF001
    out = []
    seen: set[tuple] = set()
    for n, row in enumerate(rows, start=2):
        rid = str(row.get("Risk ID") or "").strip()
        word = str(row.get("Grade") or "").strip().lower()
        label = str(row.get("Control") or "").strip()
        if not rid and not word and not label:
            continue
        base = {"row": n, "riskId": rid, "risk": (risks.get(rid) or {}).get("title") or str(row.get("Risk") or ""),
                "control": label, "controlKey": str(row.get("Control key") or "").strip() or None}
        if not word:
            out.append({**base, "status": "skipped"})
            continue
        if rid not in risks or risks[rid]["retired_at"]:
            out.append({**base, "status": "problem", "message": "no current risk with this Risk ID"})
            continue
        grade = WORD_GRADE.get(word) or (word.upper() if word.upper() in V.GRADES_IN else None)
        if not grade:
            out.append({**base, "status": "problem", "message": "grade must be Tested, Documented, Self-declared or Absent"})
            continue
        raw_date = row.get("Evidence date")
        on = _loose_date(raw_date)
        if raw_date not in (None, "") and not on:
            out.append({**base, "status": "problem", "message": f"the evidence date {raw_date!r} is not a date"})
            continue
        data = {"control_key": base["controlKey"], "label": label, "kind": str(row.get("Kind") or "preventive").strip().lower(),
                "grade": grade, "evidence": str(row.get("Evidence") or "").strip() or None, "evidence_on": on,
                "note": str(row.get("Note") or "").strip() or None}
        try:
            clean = V.clean_control(data, user)
        except (IntakeError, PermissionError) as e:
            out.append({**base, "grade": grade, "status": "problem", "message": str(e)})
            continue
        if base["controlKey"]:
            if (rid, base["controlKey"]) in seen:
                out.append({**base, "status": "problem", "message": "this control appears twice in the file"})
                continue
            seen.add((rid, base["controlKey"]))
            cur = next((x for x in G.current_ratings(con, rid) if x["control_key"] == base["controlKey"]), None)
            if cur and (cur["grade"], cur["evidence"] or None, cur["evidence_on"] or None) == \
                    (clean["grade"], clean["evidence"], clean["evidence_on"]):
                out.append({**base, "grade": grade, "status": "unchanged"})
                continue
        out.append({**base, "grade": grade, "status": "ready", "data": {**data, "control_key": base["controlKey"]}})
    counts = Counter(r["status"] for r in out)
    return {"rows": [{k: v for k, v in r.items() if k != "data"} for r in out], "_ready": [r for r in out if r["status"] == "ready"],
            "counts": {k: counts.get(k, 0) for k in ("ready", "unchanged", "skipped", "problem")}}


def import_workbook(con, rb, lib: L.Library, file_name: str, content_b64: str, user: dict, apply: bool = False) -> dict:
    """Check the uploaded workbook; with apply, write every ready row and re-assess the risks it touched."""
    checked = check_workbook(con, file_name, content_b64, user)
    ready = checked.pop("_ready")
    if not apply:
        return checked
    risks = set()
    for r in ready:
        V.record_control(con, r["riskId"], r["data"], user, source="workbook", commit=False)
        risks.add(r["riskId"])
    con.commit()
    I._log(con, "risk-controls", "control workbook imported", f"{len(ready)} rows, {len(risks)} risks", V.actor(user))     # noqa: SLF001
    con.commit()
    run = G.run(con, rb, lib, actor=V.actor(user), trigger="controls imported", risk_ids=sorted(risks)) if risks else None
    return {**checked, "applied": len(ready), "rescored": len(risks), "run": run}


def coverage(con) -> dict:
    """How many risks still wait on their controls."""
    rows = G._rows(con, """SELECT a.result FROM risks r JOIN risk_assessments a ON a.risk_id = r.id AND a.superseded_at IS NULL
                           WHERE r.retired_at IS NULL""")     # noqa: SLF001
    waiting = 0
    for r in rows:
        res = G._j(r["result"], {})     # noqa: SLF001
        if any(m.get("fact") == "controls" and m.get("mandatory") for m in res.get("missing") or []):
            waiting += 1
    return {"risks": len(rows), "waitingOnControls": waiting}
