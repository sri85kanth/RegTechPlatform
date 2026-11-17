"""
Risk register and review (migration 006, design §7 gates G3–G9) against SQLite.

Identification from the library on the company's graph, assessment (append-only,
idempotent), routing to the queue, and every gate a person decides at — with
the rules that make them safe: four eyes on a lower override, a different person
to validate a claim, leadership to accept a risk above tolerance, and no
acceptance without a named person and a review date.
"""
import json
import sqlite3
from datetime import date, timedelta

import pytest

from regulatory_ingestion import actions as A
from regulatory_ingestion import notifications as N
from regulatory_ingestion.risk import intake as I
from regulatory_ingestion.risk import library as L
from regulatory_ingestion.risk import register as G
from regulatory_ingestion.risk import review as V
from regulatory_ingestion.risk import rulebook as R

MIGRATIONS = R.RULEBOOK_DIR.parent / "migrations"
TODAY = date.today()

ADMIN = {"id": "u-admin", "role": "admin", "email": "admin@acme.example"}
CM = {"id": "u-cm", "role": "compliance_manager", "email": "cm@acme.example"}
CM2 = {"id": "u-cm2", "role": "compliance_manager", "email": "cm2@acme.example"}
REVIEWER = {"id": "u-rev", "role": "reviewer", "email": "rev@acme.example"}
VIEWER = {"id": "u-view", "role": "viewer", "email": "ceo@acme.example"}
ANSWERS = {"has_systems": True, "develops_software": False, "has_vendors": True, "markets_to_customers": False,
           "develops_products": False, "physical_goods": False, "runs_projects": False, "remote_work": False,
           "has_website": False}


@pytest.fixture
def con():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript((MIGRATIONS / "005_risk_intake.sql").read_text())
    c.executescript((MIGRATIONS / "006_risk_review.sql").read_text())
    c.executescript("""
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT, action TEXT,
                                 actor TEXT, detail TEXT, at TEXT);
      CREATE TABLE company_entities (id TEXT PRIMARY KEY, domain TEXT, type TEXT, name TEXT, description TEXT,
                                     attrs TEXT, source TEXT, criticality TEXT);
      CREATE TABLE company_profile (id INTEGER PRIMARY KEY, legal_name TEXT, entity_type TEXT, sectors TEXT,
                                    beds INTEGER, employees TEXT, turnover_cr TEXT, listed INTEGER,
                                    imports_exports INTEGER, derived_from TEXT);
      CREATE TABLE regulations (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO company_profile (id, legal_name, entity_type, sectors, employees, turnover_cr, listed, imports_exports)
        VALUES (1, 'Acme Logistics', 'Private limited', '["Logistics"]', '450', '120', 0, 0);
    """)
    c.executescript(A.SCHEMA)
    c.executescript(N.SCHEMA)
    yield c
    c.close()


@pytest.fixture(scope="module")
def rb():
    return R.load("base")


@pytest.fixture(scope="module")
def lib(rb):
    return L.load(rb)


def _ready(con, *, appetite=None):
    """The mandatory inputs: a sized site, a signed history, an approved appetite, and the questions answered."""
    I.create_record(con, "sites", {"name": "Hyderabad hub", "scale": {"employees": 450}}, "tester")
    I.attest(con, kind="ALL", months=36, name="R. Iyer", designation="CFO", actor="tester")
    I.save_draft(con, appetite or I.default_appetite(), "tester")
    I.approve_appetite(con, actor="tester", actor_user_id="u-admin", approver_name="A. Shah", designation="CEO")
    for k, v in ANSWERS.items():
        V.answer_question(con, k, v, None, ADMIN)


def _risk(con, title_part):
    return next(r for r in V.list_risks(con) if title_part.lower() in r["title"].lower())


def _tasks(con, gate=None, status="OPEN"):
    return V.list_tasks(con, status=status, gate=gate)


def _tested(con, risk_id, user=ADMIN, days_ago=30, kind="preventive"):
    return V.record_control(con, risk_id, {"control_key": "tc-1", "label": "The template's control", "kind": kind,
                                           "grade": "TESTED", "evidence": "Q3 test report",
                                           "evidence_on": (TODAY - timedelta(days=days_ago)).isoformat()}, user)


VENDOR = "critical outsourced provider"      # LIB-122: a third-party template that always applies


# ------------------------------------------------------------------ identification
def test_identify_is_cross_sector_and_never_drops_a_template(con, rb, lib):
    out = G.run(con, rb, lib)
    assert rb.ref["name"] == "base" and out["created"] > 100            # a logistics company, no sector pack
    risks = V.list_risks(con)
    candidates = [t for t in _tasks(con, "G9")]
    # unknown facts make candidates for review, never silent drops (decision D1)
    assert candidates and all(t["reason_code"] == "CANDIDATE" for t in candidates)
    assert {r["verdict"] for r in risks} <= {"REVIEW_REQUIRED", "INSUFFICIENT_EVIDENCE"}
    # nothing is scored LOW on missing inputs
    assert not any(r["verdict"] == "WITHIN_APPETITE" for r in risks)
    # a node type with nothing listed still carries its templates
    vendor = V.risk_detail(con, lib, _risk(con, VENDOR)["id"])
    assert vendor["exposures"][0]["node_ref"] == "third_party:unlisted"


def test_answering_a_question_resolves_every_candidate_it_decides(con, rb, lib):
    G.run(con, rb, lib)
    q = {x["key"]: x for x in V.questions(con)}
    assert q["develops_software"]["waiting"] > 0 and q["employees"]["value"] == 450 and q["employees"]["source"] == "records"
    waiting = q["develops_software"]["waiting"]
    V.answer_question(con, "develops_software", "no", "We buy software, we do not build it", ADMIN)
    out = G.run(con, rb, lib)
    assert out["retired"] >= waiting
    assert V.questions(con)[1]["value"] is False and V.questions(con)[1]["waiting"] == 0
    cancelled = [t for t in _tasks(con, "G9", "CANCELLED")]
    assert len(cancelled) >= waiting and all(t["note"] == "the risk was retired" for t in cancelled)
    with pytest.raises(PermissionError):
        V.answer_question(con, "remote_work", True, None, REVIEWER)
    with pytest.raises(I.IntakeError, match="no question"):
        V.answer_question(con, "colour", True, None, ADMIN)


def test_question_counts_are_distinct_possible_risks(con, rb, lib):
    # three process nodes: a software template now has an exposure on each, still one risk
    con.executescript("""
      INSERT INTO company_entities (id, domain, type, name) VALUES
        ('P1', 'processes', 'process', 'Order intake'), ('P2', 'processes', 'process', 'Billing'),
        ('P3', 'processes', 'process', 'Dispatch');
    """)
    G.run(con, rb, lib)
    multi = con.execute("SELECT risk_id FROM risk_exposures WHERE active=1 GROUP BY risk_id HAVING COUNT(*) > 1").fetchall()
    assert multi, "the scenario needs risks with more than one exposure"
    # and one possible risk with a second open candidate task: still counted once
    t = dict(con.execute("SELECT * FROM review_tasks WHERE gate='G9' AND status='OPEN' LIMIT 1").fetchone())
    t.update(id=t["id"] + "-dup", dedupe_key=t["dedupe_key"] + "-dup")
    con.execute(f"INSERT INTO review_tasks ({','.join(t)}) VALUES ({','.join('?' * len(t))})", list(t.values()))
    total = V.possible_total(con)
    open_candidates = {r[0] for r in con.execute("SELECT subject_id FROM review_tasks WHERE gate='G9' AND status='OPEN'")}
    assert total == len(open_candidates)
    qs = {q["key"]: q for q in V.questions(con)}
    assert all(q["waiting"] <= total for q in qs.values())
    software = {r[0] for r in con.execute(
        "SELECT e.risk_id FROM risk_exposures e WHERE e.active=1 AND e.missing LIKE '%org.develops_software%' "
        "AND e.risk_id IN (SELECT subject_id FROM review_tasks WHERE gate='G9' AND status='OPEN')")}
    assert qs["develops_software"]["waiting"] == len(software) > 0


def test_runs_are_idempotent(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    n_tasks = len(_tasks(con))
    again = G.run(con, rb, lib)
    assert again["changed"] == 0 and again["created"] == 0
    assert len(_tasks(con)) == n_tasks
    assert con.execute("SELECT COUNT(*) FROM risk_assessments WHERE superseded_at IS NULL").fetchone()[0] == \
        len(V.list_risks(con))


def test_unknown_controls_are_insufficient_evidence_not_low(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    assert r["verdict"] == "INSUFFICIENT_EVIDENCE" and r["provisional"] == 1
    a = G.current_assessment(con, r["id"])
    assert any(m["fact"] == "controls" and m["mandatory"] for m in a["result"]["missing"])
    # a provisional worst case is not routed as a CRITICAL finding (G5)
    assert not any(t["risk_id"] == r["id"] for t in _tasks(con, "G5"))


def test_a_tested_control_scores_it_and_the_change_is_a_new_version_with_a_diff(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    with pytest.raises(PermissionError):
        _tested(con, r["id"], user=REVIEWER)                   # a reviewer may only claim
    with pytest.raises(I.IntakeError, match="evidence and its date"):
        V.record_control(con, r["id"], {"label": "x", "grade": "TESTED"}, ADMIN)
    _tested(con, r["id"])
    G.run(con, rb, lib, risk_ids=[r["id"]])
    a = G.current_assessment(con, r["id"])
    assert a["seq"] == 2 and not a["provisional"] and a["verdict"] in ("TREAT", "ESCALATE", "WITHIN_APPETITE")
    assert a["diff"]["verdict"][0] == "INSUFFICIENT_EVIDENCE"
    assert con.execute("SELECT COUNT(*) FROM risk_assessments WHERE risk_id=?", (r["id"],)).fetchone()[0] == 2


# ------------------------------------------------------------------ G9 and lens 5
def test_g9_accept_dismiss_and_merge(con, rb, lib):
    G.run(con, rb, lib)
    cands = _tasks(con, "G9")
    first, second, third = (t["risk_id"] for t in cands[:3])
    with pytest.raises(I.IntakeError, match="give a reason"):
        V.decide_candidate(con, first, "DISMISS", "", CM)
    V.decide_candidate(con, first, "DISMISS", "No such activity here", CM)
    assert G._one(con, "SELECT lifecycle FROM risks WHERE id=?", (first,))["lifecycle"] == "RETIRED"
    V.decide_candidate(con, second, "ACCEPT", "We do this", CM)
    G.run(con, rb, lib, risk_ids=[second])
    assert G.current_assessment(con, second)["result"]["verdict_rule"] != "EV-01"
    V.decide_candidate(con, third, "MERGE", "Same exposure as the vendor risk", CM, merge_into=_risk(con, VENDOR)["id"])
    assert G._one(con, "SELECT retired_at FROM risks WHERE id=?", (third,))["retired_at"]
    assert {t["decision"] for t in _tasks(con, "G9", "DONE")} == {"DISMISS", "ACCEPT", "MERGE"}
    # a re-run does not bring the dismissed one back
    G.run(con, rb, lib)
    assert G._one(con, "SELECT retired_at FROM risks WHERE id=?", (first,))["retired_at"]


def test_a_custom_risk_needs_an_impact_basis_and_is_then_scored_by_the_rules(con, rb, lib):
    _ready(con)
    with pytest.raises(I.IntakeError, match="impact basis"):
        V.create_custom(con, rb, {"title": "Monsoon floods the hub", "theme": "BCP", "base_likelihood": "occasional"}, CM)
    with pytest.raises(I.IntakeError, match="theme"):
        V.create_custom(con, rb, {"title": "x", "theme": "WEATHER", "seeds": {"operational": 4}}, CM)
    fallback = list(rb.data["likelihood"]["base"]["fallback"]["map"])
    r = V.create_custom(con, rb, {"title": "Monsoon floods the hub", "theme": "BCP", "seeds": {"operational": 4},
                                  "base_likelihood": fallback[0]}, REVIEWER)
    assert r["origin"] == "manual"
    G.run(con, rb, lib, risk_ids=[r["id"]])
    a = G.current_assessment(con, r["id"])
    assert a["inherent_band"] and a["result"]["exposures"][0]["impact"]["dimensions"]["operational"]["score"] == 4


# ------------------------------------------------------------------ G3
def test_g3_an_undecided_exposure_inside_a_scored_risk(con, rb, lib):
    con.executescript("""
      INSERT INTO company_entities (id, domain, type, name, criticality) VALUES ('SYS-1', 'it', 'system', 'ERP', 'High');
      INSERT INTO company_entities (id, domain, type, name) VALUES ('SYS-2', 'it', 'system', 'Old intranet');
    """)
    _ready(con)
    G.run(con, rb, lib)
    g3 = _tasks(con, "G3")
    assert g3 and all("Old intranet" in t["reason"] for t in g3)
    x = g3[0]["subject_id"]
    with pytest.raises(PermissionError):
        V.decide_exposure(con, x, "NOT_APPLICABLE", "Retired next month", REVIEWER)
    V.decide_exposure(con, x, "NOT_APPLICABLE", "Read-only archive, no business process depends on it", CM)
    row = G._one(con, "SELECT * FROM risk_exposures WHERE id=?", (x,))
    assert row["decided_applicability"] == "NOT_APPLICABLE" and row["engine_applicability"] == "REVIEW_REQUIRED"
    assert G._one(con, "SELECT status FROM review_tasks WHERE id=?", (g3[0]["id"],))["status"] == "DONE"


# ------------------------------------------------------------------ G4
def test_g4_a_claim_on_a_high_risk_is_validated_by_someone_else(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    claim = V.record_control(con, r["id"], {"control_key": "tc-1", "label": "Exit plan for the provider",
                                            "grade": "CLAIMED"}, REVIEWER)
    G.run(con, rb, lib, risk_ids=[r["id"]])
    assert G.current_assessment(con, r["id"])["residual_band"] in ("HIGH", "CRITICAL")
    g4 = [t for t in _tasks(con, "G4") if t["subject_id"] == claim["id"]]
    assert len(g4) == 1 and g4[0]["priority"] == "P1"
    with pytest.raises(PermissionError, match="cannot validate"):
        V.validate_control(con, claim["id"], "TESTED", {**REVIEWER, "role": "compliance_manager"},
                           evidence="report", evidence_on=TODAY.isoformat())
    out = V.validate_control(con, claim["id"], "TESTED", CM, evidence="Exit test, Sept",
                             evidence_on=(TODAY - timedelta(days=40)).isoformat(), note="Saw the drill report")
    assert out["grade"] == "TESTED" and out["validated_by"] == CM["email"]
    assert G._one(con, "SELECT superseded_at FROM risk_control_ratings WHERE id=?", (claim["id"],))["superseded_at"]
    assert G._one(con, "SELECT status FROM review_tasks WHERE id=?", (g4[0]["id"],))["status"] == "DONE"
    with pytest.raises(I.Conflict):
        V.validate_control(con, claim["id"], "ABSENT", CM2)


# ------------------------------------------------------------------ G5
def _escalating(con, rb, lib):
    tight = I.default_appetite()
    tight["categories"] = {c: {"appetite": "LOW", "tolerance": "LOW", "zero_tolerance": False} for c in tight["categories"]}
    _ready(con, appetite=tight)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    _tested(con, r["id"])
    G.run(con, rb, lib, risk_ids=[r["id"]])
    return r


def test_g5_routes_an_escalation_to_leadership_and_can_be_acknowledged_or_escalated(con, rb, lib):
    r = _escalating(con, rb, lib)
    assert G.current_assessment(con, r["id"])["verdict"] == "ESCALATE"
    g5 = [t for t in _tasks(con, "G5") if t["risk_id"] == r["id"]]
    assert len(g5) == 1 and g5[0]["assignee_role"] == "governor" and g5[0]["priority"] == "P0"
    with pytest.raises(PermissionError):
        V.acknowledge(con, g5[0]["id"], REVIEWER)
    V.acknowledge(con, g5[0]["id"], CM, note="Board pack item", escalate=True)
    assert G._one(con, "SELECT status, assignee_role FROM review_tasks WHERE id=?", (g5[0]["id"],))["status"] == "OPEN"
    V.acknowledge(con, g5[0]["id"], ADMIN, note="Seen at the board")
    assert G._one(con, "SELECT status FROM review_tasks WHERE id=?", (g5[0]["id"],))["status"] == "DONE"
    # the same assessment is not routed twice
    G.run(con, rb, lib, risk_ids=[r["id"]])
    assert not [t for t in _tasks(con, "G5") if t["risk_id"] == r["id"]]


# ------------------------------------------------------------------ G6
def test_g6_treatment_needs_a_named_person_and_leadership_for_escalations(con, rb, lib):
    r = _escalating(con, rb, lib)
    g6 = [t for t in _tasks(con, "G6") if t["risk_id"] == r["id"]]
    assert len(g6) == 1 and g6[0]["reason_code"] == "TREATMENT_NEEDED" and "no owner" in g6[0]["reason"]
    base = {"decision": "ACCEPT", "rationale": "Cost of exit exceeds the exposure for one year",
            "accept_until": (TODAY + timedelta(days=90)).isoformat()}
    with pytest.raises(PermissionError):
        V.decide_treatment(con, r["id"], {**base, "name": "x", "designation": "y"}, VIEWER)
    with pytest.raises(I.IntakeError, match="name and designation"):
        V.decide_treatment(con, r["id"], base, ADMIN)
    with pytest.raises(PermissionError, match="leadership"):
        V.decide_treatment(con, r["id"], {**base, "name": "S. Rao", "designation": "Head of compliance"}, CM)
    with pytest.raises(I.IntakeError, match="review date"):
        V.decide_treatment(con, r["id"], {**base, "accept_until": (TODAY + timedelta(days=400)).isoformat(),
                                          "name": "A. Shah", "designation": "CEO"}, ADMIN)
    t = V.decide_treatment(con, r["id"], {**base, "name": "A. Shah", "designation": "CEO"}, ADMIN)
    assert t["decider_name"] == "A. Shah" and t["status"] == "ACTIVE"
    assert G._one(con, "SELECT lifecycle FROM risks WHERE id=?", (r["id"],))["lifecycle"] == "ACCEPTED"
    assert G._one(con, "SELECT status FROM review_tasks WHERE id=?", (g6[0]["id"],))["status"] == "DONE"
    G.run(con, rb, lib, risk_ids=[r["id"]])
    assert not [x for x in _tasks(con, "G6") if x["risk_id"] == r["id"]]       # decided: no new task


def test_g6_the_owner_decides_mitigation_and_actions_feed_the_target(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    V.set_owner(con, r["id"], VIEWER["id"], "Dr K. Rao", CM)
    V.record_control(con, r["id"], {"control_key": "tc-1", "label": "Exit plan", "grade": "DOCUMENTED",
                                    "evidence": "Exit plan v2", "evidence_on": (TODAY - timedelta(days=60)).isoformat()},
                     ADMIN)
    G.run(con, rb, lib, risk_ids=[r["id"]])
    before = G.current_assessment(con, r["id"])
    assert before["verdict"] in ("TREAT", "ESCALATE")
    g6 = [t for t in _tasks(con, "G6") if t["risk_id"] == r["id"]]
    assert g6[0]["assignee_user"] == VIEWER["id"]                          # routed to the owner, not a role
    with pytest.raises(I.IntakeError, match="at least one action"):
        V.decide_treatment(con, r["id"], {"decision": "MITIGATE", "rationale": "Reduce the dependency",
                                          "name": "Dr K. Rao", "designation": "COO"}, VIEWER)
    t = V.decide_treatment(con, r["id"], {
        "decision": "MITIGATE", "rationale": "Reduce the dependency on one provider", "name": "Dr K. Rao",
        "designation": "COO", "actions": [{"title": "Qualify a second provider", "due_date": "2027-03-31",
                                           "kind": "corrective"}]}, VIEWER)
    acts = json.loads(t["action_ids"])
    row = A.get(con, acts[0]["id"])
    assert row["status"] == "Open" and row["source"] == "risk-treatment" and t["decision"] == "MITIGATE"
    assert [e["to_status"] for e in row["events"]] == ["Proposed", "Open"]
    G.run(con, rb, lib, risk_ids=[r["id"]])
    after = G.current_assessment(con, r["id"])
    assert G.BAND_RANK[after["target_band"]] < G.BAND_RANK[after["residual_band"]]   # D4: target after treatment
    assert G._one(con, "SELECT lifecycle FROM risks WHERE id=?", (r["id"],))["lifecycle"] == "IN_TREATMENT"


def test_an_expired_acceptance_reopens_treatment(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    V.record_control(con, r["id"], {"control_key": "tc-1", "label": "Exit plan", "grade": "DOCUMENTED",
                                    "evidence": "Exit plan v2", "evidence_on": (TODAY - timedelta(days=60)).isoformat()},
                     ADMIN)
    G.run(con, rb, lib, risk_ids=[r["id"]])
    V.decide_treatment(con, r["id"], {"decision": "ACCEPT", "rationale": "Within budget tolerance for now",
                                      "accept_until": (TODAY + timedelta(days=30)).isoformat(),
                                      "name": "S. Rao", "designation": "Head of compliance"}, CM)
    out = G.run(con, rb, lib, as_of=TODAY + timedelta(days=31))
    assert out["acceptances_expired"] == 1
    assert G._one(con, "SELECT lifecycle FROM risks WHERE id=?", (r["id"],))["lifecycle"] == "ASSESSED"
    g6 = [t for t in _tasks(con, "G6") if t["risk_id"] == r["id"]]
    assert g6 and g6[0]["reason_code"] == "ACCEPTANCE_EXPIRED"


def test_nothing_is_accepted_without_a_named_person(con, rb, lib):
    r = _escalating(con, rb, lib)
    V.decide_treatment(con, r["id"], {"decision": "ACCEPT", "rationale": "Board accepted it for the quarter",
                                      "accept_until": (TODAY + timedelta(days=60)).isoformat(),
                                      "name": "A. Shah", "designation": "CEO"}, ADMIN)
    for risk in G._rows(con, "SELECT id FROM risks WHERE lifecycle='ACCEPTED'"):
        t = G.active_treatment(con, risk["id"])
        assert t and t["decision"] == "ACCEPT" and t["decider_name"] and t["decider_designation"] and t["accept_until"]


def test_escalate_refers_the_decision_to_leadership(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    _tested(con, r["id"])
    G.run(con, rb, lib, risk_ids=[r["id"]])
    V.decide_treatment(con, r["id"], {"decision": "ESCALATE", "rationale": "Needs a budget decision",
                                      "name": "S. Rao", "designation": "Head of compliance"}, CM)
    g6 = [t for t in _tasks(con, "G6") if t["risk_id"] == r["id"]]
    assert len(g6) == 1 and g6[0]["reason_code"] == "ESCALATED" and g6[0]["assignee_role"] == "governor"
    G.run(con, rb, lib, risk_ids=[r["id"]])                      # a person's referral survives the re-run
    assert [t["id"] for t in _tasks(con, "G6") if t["risk_id"] == r["id"]] == [g6[0]["id"]]


# ------------------------------------------------------------------ G7
def test_g7_a_lower_override_needs_a_second_approver(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    _tested(con, r["id"])
    G.run(con, rb, lib, risk_ids=[r["id"]])
    a = G.current_assessment(con, r["id"])
    assert a["verdict"] == "TREAT"
    with pytest.raises(PermissionError):
        V.propose_override(con, r["id"], {"field": "verdict", "value": "WITHIN_APPETITE", "reason": "x" * 12}, REVIEWER)
    with pytest.raises(I.IntakeError, match="reason"):
        V.propose_override(con, r["id"], {"field": "verdict", "value": "WITHIN_APPETITE", "reason": "short"}, CM)
    o = V.propose_override(con, r["id"], {"field": "verdict", "value": "WITHIN_APPETITE",
                                          "reason": "The provider is contractually replaceable within a week"}, CM)
    assert o["status"] == "PENDING" and o["direction"] == "lower" and o["computed_value"] == "TREAT"
    assert G.effective(con, r["id"])["verdict"] == "TREAT"                  # not in force until a second person agrees
    g7 = _tasks(con, "G7")
    assert len(g7) == 1 and g7[0]["subject_id"] == o["id"]
    with pytest.raises(PermissionError, match="different person"):
        V.decide_override(con, o["id"], True, CM)
    with pytest.raises(I.IntakeError, match="why"):
        V.decide_override(con, o["id"], False, CM2)
    V.decide_override(con, o["id"], True, CM2, "Checked the contract clause")
    eff = G.effective(con, r["id"])
    assert eff["verdict"] == "WITHIN_APPETITE" and eff["overridden"] == ["verdict"]
    assert G.current_assessment(con, r["id"])["verdict"] == "TREAT"          # the computed value is kept beside it
    G.route(con, r["id"])
    assert not [t for t in _tasks(con, "G6") if t["risk_id"] == r["id"]]    # treatment no longer called for
    with pytest.raises(I.Conflict, match="revoke it first"):
        V.propose_override(con, r["id"], {"field": "verdict", "value": "ESCALATE", "reason": "y" * 12}, CM)


def test_a_raise_applies_at_once_and_any_override_goes_stale_when_inputs_change(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    r = _risk(con, VENDOR)
    _tested(con, r["id"])
    G.run(con, rb, lib, risk_ids=[r["id"]])
    o = V.propose_override(con, r["id"], {"field": "residual_band", "value": "CRITICAL",
                                          "reason": "The last outage took the hub down for two days"}, CM)
    assert o["status"] == "ACTIVE" and o["direction"] == "raise"
    assert G.effective(con, r["id"])["residual_band"] == "CRITICAL"
    # a new control rating changes the inputs: the override answered other inputs
    V.record_control(con, r["id"], {"control_key": "tc-2", "label": "Second provider", "grade": "CLAIMED"}, REVIEWER)
    G.run(con, rb, lib, risk_ids=[r["id"]])
    assert G._one(con, "SELECT status FROM risk_overrides WHERE id=?", (o["id"],))["status"] == "STALE"
    stale = [t for t in _tasks(con, "G5") if t["reason_code"] == "OVERRIDE_STALE"]
    assert len(stale) == 1 and stale[0]["subject_id"] == o["id"]
    V.revoke_override(con, o["id"], CM, "Let the computed value stand")
    assert not [t for t in _tasks(con, "G5") if t["reason_code"] == "OVERRIDE_STALE"]


# ------------------------------------------------------------------ G8
def test_g8_a_rulebook_is_published_by_an_admin_and_a_governor(con, rb, lib):
    _ready(con)
    G.run(con, rb, lib)
    I.grant_governor(con, CM["id"], "Chief risk officer", "admin")
    assert V.publication_state(con, rb)["current"] is False
    st = V.request_publication(con, rb, lib, CM)
    pub = st["pending"]
    assert pub["diff"]["risks"] == len(V.list_risks(con)) and pub["diff"]["verdictChanges"] == 0
    assert _tasks(con, "G8")[0]["subject_id"] == pub["id"]
    with pytest.raises(PermissionError):
        V.decide_publication(con, rb, pub["id"], True, CM2)              # neither admin nor governor
    V.decide_publication(con, rb, pub["id"], True, ADMIN)
    with pytest.raises(PermissionError, match="different person"):
        V.decide_publication(con, rb, pub["id"], True, ADMIN)
    st = V.decide_publication(con, rb, pub["id"], True, CM, "Dry run reviewed")
    assert st["current"] is True and st["published"]["admin_by"] == ADMIN["email"]
    assert st["published"]["governor_by"] == CM["email"] and not _tasks(con, "G8")
    with pytest.raises(I.Conflict, match="already published"):
        V.request_publication(con, rb, lib, ADMIN)


# ------------------------------------------------------------------ the queue
def test_tasks_notify_and_link_to_the_review_screen(con, rb, lib):
    G.run(con, rb, lib)
    t = _tasks(con, "G9")[0]
    n = con.execute("SELECT * FROM notifications WHERE dedupe_key LIKE ?", (f"risk-task:{t['id']}:%",)).fetchone()
    assert n["link"] == f"/risk-review?task={t['id']}" and n["role"] == "compliance_manager"
    s = V.queue_summary(con)
    assert s["open"] == len(_tasks(con)) and s["byGate"]["G9"] == len(_tasks(con, "G9"))


def test_mine_shows_what_is_routed_to_me(con, rb, lib):
    r = _escalating(con, rb, lib)
    V.set_owner(con, r["id"], VIEWER["id"], "Dr K. Rao", CM)
    mine_viewer = V.list_tasks(con, user=VIEWER, mine=True)
    assert mine_viewer and all(t["assignee_user"] == VIEWER["id"] for t in mine_viewer)
    gates_cm = {t["gate"] for t in V.list_tasks(con, user=CM, mine=True)}
    assert "G9" in gates_cm and "G6" not in gates_cm                       # the owner's decision, not the role's
    assert "G5" in {t["gate"] for t in V.list_tasks(con, user=ADMIN, mine=True)}   # admins govern
