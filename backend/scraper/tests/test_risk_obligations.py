"""
Lens 1 — obligations in the risk register (risk/obligations.py, migration 007).

Every applicable duty becomes an exposure with the facts the rulebook reads —
set explicitly, false and 0 included — grouped into one risk per theme. Penalties
drive regulatory impact, change velocity drives likelihood, mapped controls are
graded by their own evidence, and a regulation nobody can place waits for a
person to choose its theme.
"""
from datetime import date, timedelta

import pytest

from regulatory_ingestion.risk import obligations as O
from regulatory_ingestion.risk import register as G
from regulatory_ingestion.risk import review as V

from test_risk_review import ADMIN, CM, MIGRATIONS, _ready, con, lib, rb  # noqa: F401 — shared fixtures

TODAY = date.today()
D = lambda days: (TODAY - timedelta(days=days)).isoformat()  # noqa: E731

REGS = [
    ("R-DPDP", "Digital Personal Data Protection Act, 2023", "DPDP Act", "MeitY", "Act", None),
    ("R-DPDPR", "Digital Personal Data Protection Rules, 2025", "DPDP Rules", "MeitY", "Rules",
     "Digital Personal Data Protection Act, 2023"),
    ("R-WAGES", "The Code on Wages, 2019", "Code on Wages", "MoLE", "Act", None),
    ("R-POT", "Pottery Kiln Order, 1962", None, "DGFT", "Order", None),
]
DUTIES = [
    ("Q1", "R-DPDP", "Section 8(5)", "A Data Fiduciary shall protect personal data by taking reasonable security safeguards.", "APPLICABLE"),
    ("Q2", "R-DPDP", "Section 8(6)", "In the event of a personal data breach, the Data Fiduciary shall intimate the Board.", "APPLICABLE"),
    ("Q3", "R-DPDPR", "Rule 6", "Reasonable security safeguards shall include encryption of personal data.", "APPLICABLE"),
    ("Q4", "R-WAGES", "Section 17", "The employer shall pay wages to each employee within the time limit.", "APPLICABLE"),
    ("Q5", "R-WAGES", "Section 2", "\"Employer\" means a person who employs one or more employees.", "NOT_APPLICABLE"),
    ("Q6", "R-POT", "Clause 3", "Every kiln operator shall keep a register of firings.", "APPLICABLE"),
    ("Q7", "R-DPDP", "Section 9", "Before processing a child's personal data, verifiable parental consent shall be obtained.", "REVIEW_REQUIRED"),
]


def _library(con, duties=DUTIES):
    con.executescript((MIGRATIONS / "007_risk_obligations.sql").read_text())
    for col in ("short_title", "regulator_short", "regulation_type", "enabling_act", "regulator"):
        con.execute(f"ALTER TABLE regulations ADD COLUMN {col} TEXT")
    con.executescript("""
      CREATE TABLE v_company_requirements (requirement_id TEXT, regulation_id TEXT, statement TEXT, source_clause TEXT,
                                           applicability TEXT, applicability_reason TEXT);
      CREATE TABLE penalty_provisions (id TEXT PRIMARY KEY, regulation_id TEXT, section_number TEXT, kind TEXT,
                                       amount_min REAL, amount_max REAL, per_day_amount REAL, imprisonment_months INTEGER);
      CREATE TABLE section_changes (id INTEGER PRIMARY KEY, regulation_id TEXT, section_number TEXT, change_type TEXT,
                                    change_class TEXT, detected_at TEXT);
      CREATE TABLE gap_assessments (requirement_id TEXT PRIMARY KEY, regulation_id TEXT, status TEXT, unit_code TEXT);
      CREATE TABLE control_requirements (id INTEGER PRIMARY KEY, control_id TEXT, requirement_id TEXT, review_status TEXT);
      CREATE TABLE controls (id TEXT PRIMARY KEY, name TEXT, description TEXT, control_type TEXT, effectiveness TEXT,
                             last_tested TEXT);
      CREATE TABLE evidence (id TEXT PRIMARY KEY, name TEXT, valid_from TEXT, uploaded_at TEXT);
      CREATE TABLE evidence_links (id INTEGER PRIMARY KEY, evidence_id TEXT, control_id TEXT);
      CREATE TABLE compliance_tests (id TEXT PRIMARY KEY, control_id TEXT, result TEXT, performed_at TEXT);
      CREATE TABLE enforcement_actions (id TEXT PRIMARY KEY, regulator TEXT, title TEXT);
    """)
    for r in REGS:
        con.execute("INSERT INTO regulations (id, title, short_title, regulator_short, regulation_type, enabling_act) "
                    "VALUES (?,?,?,?,?,?)", r)
    for d in duties:
        con.execute("INSERT INTO v_company_requirements (requirement_id, regulation_id, source_clause, statement, applicability) "
                    "VALUES (?,?,?,?,?)", d)
    con.executemany("INSERT INTO penalty_provisions (id, regulation_id, kind, amount_max, imprisonment_months) VALUES (?,?,?,?,?)", [
        ("P1", "R-DPDP", "FIXED_FINE", 2_500_000_000, None),                 # ₹250 crore, Schedule item 1
        ("P2", "R-WAGES", "FIXED_FINE", 50_000, None),
        ("P3", "R-WAGES", "IMPRISONMENT", None, 3),
    ])
    con.execute("INSERT INTO section_changes (regulation_id, section_number, change_type, change_class, detected_at) "
                "VALUES ('R-DPDP', '8', 'modified', 'WORDING', ?)", (D(30),))
    con.execute("INSERT INTO gap_assessments VALUES ('Q2', 'R-DPDP', 'GAP', NULL)")
    con.execute("INSERT INTO controls VALUES ('CTL-ENC', 'Encryption and key management', '', 'preventive', 'Effective', ?)", (D(60),))
    con.execute("INSERT INTO evidence VALUES ('EV-1', 'Key rotation report', ?, NULL)", (D(100),))
    con.execute("INSERT INTO evidence_links (evidence_id, control_id) VALUES ('EV-1', 'CTL-ENC')")
    con.executemany("INSERT INTO control_requirements (control_id, requirement_id, review_status) VALUES (?,?,?)", [
        ("CTL-ENC", "Q1", "ACCEPTED"), ("CTL-ENC", "Q2", "UNREVIEWED")])
    con.execute("INSERT INTO enforcement_actions VALUES ('EA-1', 'MeitY', 'Penalty order')")
    con.commit()


def _risk(con, theme):
    return G._one(con, "SELECT * FROM risks WHERE group_key=?", (O.group_key(theme),))


def test_every_applicable_duty_becomes_an_exposure_grouped_by_theme(con, rb, lib):
    _library(con)
    out = G.run(con, rb, lib)
    assert out["obligation_risks_created"] == 3 and out["duties"] == 6          # Q5 (not applicable) is not a duty
    data, people, nothing = _risk(con, "DATA"), _risk(con, "PEOPLE"), _risk(con, None)
    assert data["title"] == "Breach of data protection and privacy obligations" and data["origin"] == "derived"
    keys = {x["exposure_key"] for x in G._rows(con, "SELECT exposure_key FROM risk_exposures WHERE risk_id=?", (data["id"],))}
    assert keys == {"req:Q1", "req:Q2", "req:Q3", "req:Q7"}                    # the Act and its Rules, one theme
    assert G._one(con, "SELECT COUNT(*) AS n FROM risk_exposures WHERE risk_id=?", (people["id"],))["n"] == 1
    assert nothing["title"] == "Obligations without a theme yet"
    assert "4 applicable duties from 2 regulations" in data["description"]


def test_the_facts_contract_is_set_explicitly(con, rb):
    _library(con)
    x = O.load(con, rb)["exposures"]
    q1, q2, q3, q4 = (x[f"req:{q}"]["facts"] for q in ("Q1", "Q2", "Q3", "Q4"))
    assert q1["penalty"] == {"max_fine_inr": 2_500_000_000, "imprisonment": False, "present": True}
    assert q1["instrument_type"] == "act" and q1["consequence"] == []
    assert q1["requirement"]["section_changed_12m"] is True and q1["evidence"]["predates_change"] is True
    assert q1["regulator"]["publishes_enforcement"] is True and q1["exposure"]["guards_licence"] is False
    assert q3["penalty"]["max_fine_inr"] == 2_500_000_000                       # the Rules inherit the Act's ceiling
    assert x["req:Q3"]["meta"]["inherited_from"] == "R-DPDP" and q3["instrument_type"] == "rules"
    assert q3["requirement"]["section_changed_12m"] is False                    # a different instrument changed
    assert q4["penalty"]["imprisonment"] is True and q4["regulator"]["publishes_enforcement"] is False
    assert x["req:Q2"]["gap_status"] == "GAP" and x["req:Q2"]["controls"] == []  # an unreviewed mapping is not a control
    assert [c["id"] for c in x["req:Q1"]["controls"]] == ["control:CTL-ENC"]
    assert x["req:Q1"]["controls"][0]["test_evidence"] is True                  # effective, tested, with evidence
    assert x["req:Q7"]["applicability"] == "REVIEW_REQUIRED"


def test_penalties_drive_impact_and_change_drives_likelihood(con, rb, lib):
    _library(con)
    _ready(con)
    G.run(con, rb, lib)
    by_id = lambda risk: {e["id"]: e for e in G.current_assessment(con, risk["id"])["result"]["exposures"]}  # noqa: E731
    data = by_id(_risk(con, "DATA"))
    assert data["req:Q1"]["impact"]["dimensions"]["regulatory"]["rule"] == "REG-IMP-03"     # ≥ ₹1 crore
    assert "LIK-CHG-01" in [f["id"] for f in data["req:Q1"]["likelihood"]["fired"]]        # changed after the evidence
    assert data["req:Q1"]["controls"]["grade"] == "TESTED"
    assert data["req:Q2"]["controls"]["grade"] == "ABSENT"                                  # the gap review found a gap
    people = by_id(_risk(con, "PEOPLE"))
    assert people["req:Q4"]["impact"]["dimensions"]["regulatory"]["rule"] == "REG-IMP-01"   # imprisonment
    a = G.current_assessment(con, _risk(con, "DATA")["id"])
    assert "exposures_pending_review" in a["result"]["confidence"]["deductions"]            # Q7 waits on its verdict
    assert a["result"]["driver"] in ("req:Q1", "req:Q2", "req:Q3")


def test_a_regulation_nobody_can_place_waits_for_a_person_then_moves(con, rb, lib):
    _library(con)
    G.run(con, rb, lib)
    nothing = _risk(con, None)
    assert G.current_assessment(con, nothing["id"])["result"]["verdict_rule"] == "EV-01"     # unscored, not CRITICAL
    tasks = V.list_tasks(con, gate="G3")
    assert [(t["reason_code"], t["subject_id"]) for t in tasks] == [("THEME_NEEDED", "R-POT")]
    assert tasks[0]["detail"] == {"regulation": "Pottery Kiln Order, 1962", "duties": 1}
    assert not [t for t in V.list_tasks(con, gate="G9") if t["risk_id"] in (nothing["id"], _risk(con, "DATA")["id"])]
    with pytest.raises(PermissionError):
        V.assign_theme(con, rb, "R-POT", "LEGAL", {"id": "u", "role": "reviewer", "email": "r@x"})
    V.assign_theme(con, rb, "R-POT", "LEGAL", CM, "An export order: legal and compliance")
    G.run(con, rb, lib)
    assert _risk(con, "LEGAL") and G._one(con, "SELECT COUNT(*) AS n FROM risk_exposures WHERE risk_id=? AND active=1",
                                          (_risk(con, "LEGAL")["id"],))["n"] == 1
    assert _risk(con, None)["lifecycle"] == "RETIRED"
    assert V.list_tasks(con, gate="G3", status="DONE")[0]["decision"] == "LEGAL"


def test_runs_stay_idempotent_with_obligations(con, rb, lib):
    _library(con)
    _ready(con)
    G.run(con, rb, lib)
    n = G._one(con, "SELECT COUNT(*) AS n FROM risk_exposures")["n"]
    again = G.run(con, rb, lib)
    assert again["changed"] == 0 and again["obligation_risks_created"] == 0
    assert G._one(con, "SELECT COUNT(*) AS n FROM risk_exposures")["n"] == n


def test_a_large_risk_stores_its_worst_duties_and_pages_the_rest(con, rb, lib):
    many = [(f"QX{i}", "R-DPDP", f"Section 8({i})", f"Duty number {i} of the Data Fiduciary.", "APPLICABLE") for i in range(40)]
    _library(con, DUTIES + many)
    _ready(con)
    G.run(con, rb, lib)
    data = _risk(con, "DATA")
    a = G.current_assessment(con, data["id"])
    assert a["result"]["exposures_total"] == 44 and len(a["result"]["exposures"]) <= G.TRIM_EXPOSURES + 1
    assert any(e["id"] == a["result"]["driver"] for e in a["result"]["exposures"])
    d = V.risk_detail(con, lib, data["id"])
    assert d["exposureCounts"] == {"total": 44, "pending": 1, "regulations": 2, "shown": 44}
    assert d["exposures"][0]["exposure_key"] == "req:Q7"                       # the undecided one first
    assert "inputs" not in d["assessment"]                                     # the snapshot never goes to the browser
    drv = d["driver"]
    assert drv["regulation"] == "Digital Personal Data Protection Act, 2023" and drv["penaltyInr"] == 2_500_000_000
    assert drv["clause"].startswith("Section 8")


def test_library_risks_are_untouched_by_lens_one(con, rb, lib):
    G.run(con, rb, lib)
    before = {r["group_key"] for r in V.list_risks(con)}
    _library(con)
    G.run(con, rb, lib)
    after = {r["group_key"] for r in V.list_risks(con)}
    assert before < after and {k for k in after - before} == {O.group_key("DATA"), O.group_key("PEOPLE"), O.group_key(None)}
