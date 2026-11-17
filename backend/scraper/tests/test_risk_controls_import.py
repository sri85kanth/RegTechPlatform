"""
Controls in bulk (risk/controls_import.py): matching the company's own controls to
each risk's typical controls, the grade a record supports, and the control
workbook round trip — with the same rules as typing a control in.
"""
import base64
import csv
import io
from datetime import date, timedelta

import openpyxl
import pytest

from regulatory_ingestion.risk import controls_import as CI
from regulatory_ingestion.risk import intake as I
from regulatory_ingestion.risk import register as G
from regulatory_ingestion.risk import review as V

from test_risk_review import ADMIN, CM, REVIEWER, VENDOR, _ready, _risk, con, lib, rb  # noqa: F401 — shared fixtures

TODAY = date.today()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _controls_table(con):
    con.executescript("""
      CREATE TABLE controls (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, control_type TEXT, frequency TEXT,
                             automated TEXT, entity_id TEXT, owner_id TEXT, effectiveness TEXT, last_tested TEXT,
                             next_test_due TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE evidence (id TEXT PRIMARY KEY, name TEXT NOT NULL, valid_from TEXT, uploaded_at TEXT);
      CREATE TABLE evidence_links (id INTEGER PRIMARY KEY, evidence_id TEXT, control_id TEXT, requirement_id TEXT, created_at TEXT);
      CREATE TABLE compliance_tests (id TEXT PRIMARY KEY, control_id TEXT, result TEXT, performed_at TEXT);
    """)


def _add_control(con, cid, name, description="", effectiveness="Not Tested", last_tested=None, evidence=None, test=None):
    con.execute("INSERT INTO controls (id, name, description, control_type, effectiveness, last_tested) VALUES (?,?,?,?,?,?)",
                (cid, name, description, "corrective", effectiveness, last_tested))
    for i, (ename, on) in enumerate(evidence or []):
        con.execute("INSERT INTO evidence (id, name, valid_from) VALUES (?,?,?)", (f"{cid}-E{i}", ename, on))
        con.execute("INSERT INTO evidence_links (evidence_id, control_id) VALUES (?,?)", (f"{cid}-E{i}", cid))
    if test:
        con.execute("INSERT INTO compliance_tests (id, control_id, result, performed_at) VALUES (?,?,?,?)",
                    (f"{cid}-T", cid, test[0], test[1]))
    con.commit()


# ------------------------------------------------------------------ what a record supports
@pytest.mark.parametrize("record, grade", [
    ({"name": "x", "last_test": {"result": "PASS", "performed_at": "2026-09-01"}}, "TESTED"),
    ({"name": "x", "last_test": {"result": "FAIL", "performed_at": "2026-09-01"}}, "ABSENT"),
    ({"name": "x", "effectiveness": "Ineffective"}, "ABSENT"),
    ({"name": "x", "effectiveness": "Effective", "last_tested": "2026-06-01", "evidence": [{"name": "Q2 report", "on": None}]}, "TESTED"),
    ({"name": "x", "effectiveness": "Effective", "last_tested": "2026-06-01", "evidence": []}, "CLAIMED"),   # no evidence: a claim
    ({"name": "x", "effectiveness": "Partially Effective", "evidence": [{"name": "Policy v3", "on": "2026-02-01"}]}, "DOCUMENTED"),
    ({"name": "x", "effectiveness": "Not Tested"}, "CLAIMED"),
])
def test_a_record_never_earns_a_grade_beyond_its_evidence(record, grade):
    assert CI.proposed_grade(record)["grade"] == grade


def test_dates_as_people_write_them():
    assert CI._loose_date("Jun 2026") == "2026-06-01"            # a month alone: its first day, the older side
    assert CI._loose_date("15/09/2026") == "2026-09-15"
    assert CI._loose_date("2026-09-15T10:00:00") == "2026-09-15"
    assert CI._loose_date("soon") is None


def test_register_shorthand_and_control_names_share_words():
    assert {"vulnerability", "assessment"} <= CI.words("Conduct VA half yearly")
    assert "backup" in CI.words("Daily backups") and "backup" in CI.words("Backup and restore test")


# ------------------------------------------------------------------ matching
def test_matches_propose_a_grade_with_the_reason_and_apply_only_what_is_chosen(con, rb, lib):
    _controls_table(con)
    _ready(con)
    G.run(con, rb, lib)
    vendor = V.risk_detail(con, lib, _risk(con, VENDOR)["id"])
    text = vendor["controls"]["typical"][0]["text"]               # resilience requirements, exit plans, SLAs …
    _add_control(con, "C-EXIT", "Vendor exit plans and SLAs", "Resilience requirements and alternate procedures per provider",
                 effectiveness="Effective", last_tested=(TODAY - timedelta(days=50)).isoformat(),
                 evidence=[("Exit plan test, Sept", None)])
    _add_control(con, "C-CANTEEN", "Canteen hygiene audit")
    m = CI.matches(con, lib)
    assert m["existing"] == 2
    hit = next(x for x in m["items"] if x["riskId"] == vendor["risk"]["id"])
    assert hit["sourceId"] == "control:C-EXIT" and hit["control"] == text and hit["grade"] == "TESTED"
    assert hit["strength"] in ("strong", "possible") and hit["shared"] and "effective" in hit["why"]
    assert not any(x["sourceId"] == "control:C-CANTEEN" and x["riskId"] == vendor["risk"]["id"] for x in m["items"])

    # a reviewer may not record a tested grade, even from a match
    out = CI.apply_matches(con, rb, lib, [hit], REVIEWER)
    assert out["applied"] == 0 and "compliance manager" in out["problems"][0]["message"]
    out = CI.apply_matches(con, rb, lib, [hit], CM)
    assert out["applied"] == 1 and out["rescored"] == 1
    r = G.current_ratings(con, vendor["risk"]["id"])[0]
    assert r["source"] == "control:C-EXIT" and r["grade"] == "TESTED" and "Mapped from" in r["note"]
    assert G.current_assessment(con, vendor["risk"]["id"])["verdict"] != "INSUFFICIENT_EVIDENCE"
    # once known, it is no longer proposed; applying it again is refused, not duplicated
    assert not any(x["riskId"] == vendor["risk"]["id"] and x["controlKey"] == "tc-1" for x in CI.matches(con, lib)["items"])
    assert CI.apply_matches(con, rb, lib, [hit], CM)["applied"] == 0


def test_no_control_tables_is_not_an_error(con, rb, lib):
    G.run(con, rb, lib)
    m = CI.matches(con, lib)
    assert m["existing"] == 0 and m["items"] == [] and m["unknownControls"] > 0


# ------------------------------------------------------------------ the workbook
def _fill(book: bytes, edits: dict) -> bytes:
    """edits: {risk title part: {column: value}}, applied to that risk's first control row."""
    wb = openpyxl.load_workbook(io.BytesIO(book))
    ws = wb["Controls"]
    head = [c.value for c in ws[1]]
    for part, values in edits.items():
        row = next(r for r in ws.iter_rows(min_row=2) if part.lower() in str(r[head.index("Risk")].value).lower())
        for col, v in values.items():
            row[head.index(col)].value = v
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_the_workbook_lists_every_risk_control_with_a_grade_dropdown(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    wb = openpyxl.load_workbook(io.BytesIO(CI.workbook(con, lib)))
    ws = wb["Controls"]
    assert [c.value for c in ws[1]] == list(CI.COLUMNS)
    n_controls = sum(len((lib.get(r["template_id"]) or {}).get("typical_controls") or [])
                     for r in V.list_risks(con) if r["template_id"])
    assert ws.max_row - 1 == n_controls
    assert any("Self-declared" in dv.formula1 for dv in ws.data_validations.dataValidation)
    assert "How to fill" in wb.sheetnames


def test_a_filled_workbook_is_checked_row_by_row_then_applied(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    book = CI.workbook(con, lib)
    later = (TODAY + timedelta(days=5)).isoformat()
    filled = _fill(book, {
        VENDOR: {"Grade": "Tested", "Evidence": "DR drill report", "Evidence date": TODAY - timedelta(days=40)},
        "laptop, mobile device": {"Grade": "Documented"},                                 # no evidence → problem
        "major service failure": {"Grade": "Tested", "Evidence": "x", "Evidence date": later},   # future → problem
        "Backups are online": {"Grade": "Maybe"},                                         # bad grade → problem
        "supplier compromise": {"Grade": "Self-declared"},                                # ready
    })
    checked = CI.import_workbook(con, rb, lib, "risk-controls.xlsx", _b64(filled), CM)
    by = {r["status"] for r in checked["rows"]}
    assert checked["counts"]["ready"] == 2 and checked["counts"]["problem"] == 3 and "skipped" in by
    msgs = " ".join(r.get("message", "") for r in checked["rows"] if r["status"] == "problem")
    assert "evidence and its date" in msgs and "future" in msgs and "grade must be" in msgs
    assert not G.current_ratings(con, _risk(con, VENDOR)["id"])                       # checking writes nothing

    # a reviewer's tested row is a problem; their self-declared row is fine
    as_reviewer = CI.import_workbook(con, rb, lib, "risk-controls.xlsx", _b64(filled), REVIEWER)
    assert as_reviewer["counts"]["ready"] == 1

    done = CI.import_workbook(con, rb, lib, "risk-controls.xlsx", _b64(filled), CM, apply=True)
    assert done["applied"] == 2 and done["rescored"] == 2
    vendor = _risk(con, VENDOR)
    rating = G.current_ratings(con, vendor["id"])[0]
    assert rating["source"] == "workbook" and rating["grade"] == "TESTED"
    assert vendor["verdict"] != "INSUFFICIENT_EVIDENCE"
    # the same file again: those rows are unchanged, nothing is written twice
    again = CI.import_workbook(con, rb, lib, "risk-controls.xlsx", _b64(filled), CM)
    assert again["counts"]["ready"] == 0 and again["counts"]["unchanged"] == 2


def test_csv_works_too_and_a_wrong_file_says_so(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    vendor = V.risk_detail(con, lib, _risk(con, VENDOR)["id"])
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(CI.COLUMNS))
    w.writeheader()
    w.writerow({"Risk ID": vendor["risk"]["id"], "Control key": "tc-1", "Control": vendor["controls"]["typical"][0]["text"],
                "Grade": "absent"})
    out = CI.import_workbook(con, rb, lib, "controls.csv", _b64(buf.getvalue().encode()), REVIEWER, apply=True)
    assert out["applied"] == 1 and G.current_ratings(con, vendor["risk"]["id"])[0]["grade"] == "ABSENT"
    with pytest.raises(I.IntakeError, match="not the control workbook"):
        CI.import_workbook(con, rb, lib, "other.csv", _b64(b"name,value\nx,1\n"), CM)
    with pytest.raises(I.IntakeError, match=".xlsx"):
        CI.import_workbook(con, rb, lib, "controls.pdf", _b64(b"%PDF"), CM)
    with pytest.raises(I.IntakeError, match="not a readable Excel"):
        CI.import_workbook(con, rb, lib, "controls.xlsx", _b64(b"not a zip"), CM)


def test_coverage_counts_the_risks_waiting_on_controls(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    before = CI.coverage(con)
    assert before["waitingOnControls"] > 0
    vendor = _risk(con, VENDOR)
    V.record_control(con, vendor["id"], {"control_key": "tc-1", "label": "Exit plan", "grade": "CLAIMED"}, REVIEWER)
    G.run(con, rb, lib, risk_ids=[vendor["id"]])
    assert CI.coverage(con)["waitingOnControls"] == before["waitingOnControls"] - 1
