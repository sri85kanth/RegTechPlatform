"""
Risk intake (migration 005) against SQLite: records, attestations, appetite
versions (gate G1), governors, facts awaiting a person (gate G2), proposals
from onboarding data, and readiness. Hermetic: the migration's own DDL.
"""
import json
import sqlite3
from datetime import date

import pytest

from regulatory_ingestion.risk import intake as I
from regulatory_ingestion.risk import rulebook as R

MIGRATION = R.RULEBOOK_DIR.parent / "migrations" / "005_risk_intake.sql"
TODAY = date(2026, 11, 12)


@pytest.fixture
def con():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript(MIGRATION.read_text())
    c.executescript("""
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT, action TEXT,
                                 actor TEXT, detail TEXT, at TEXT);
      CREATE TABLE company_entities (id TEXT PRIMARY KEY, domain TEXT, type TEXT, name TEXT,
                                     description TEXT, attrs TEXT, source TEXT);
      CREATE TABLE company_profile (id INTEGER PRIMARY KEY, legal_name TEXT, entity_type TEXT,
                                    sectors TEXT, beds INTEGER, derived_from TEXT);
      INSERT INTO company_profile (id, legal_name, entity_type, sectors) VALUES (1, 'Premier', 'Hospital', '["Healthcare"]');
    """)
    yield c
    c.close()


@pytest.fixture(scope="module")
def rb():
    return R.load("healthcare")


def _site(con, **kw):
    return I.create_record(con, "sites", {"name": "Hyderabad", "site_type": "hospital", **kw}, "tester")


# ------------------------------------------------------------------ records
def test_a_site_is_stored_cleaned_and_logged(con):
    s = _site(con, scale={"beds": "250", "ots": 8}, service_lines="Radiology, Blood bank, Radiology")
    assert s["id"].startswith("SITE-") and s["status"] == "CONFIRMED" and s["source"] == "entered by tester"
    assert s["scale"] == {"beds": 250, "ots": 8}
    assert s["service_lines"] == ["Radiology", "Blood bank"]               # trimmed, de-duplicated
    assert con.execute("SELECT action FROM audit_events").fetchone()[0] == "risk intake: sites added"


@pytest.mark.parametrize("kind, data, message", [
    ("sites", {}, "name is required"),
    ("sites", {"name": "X", "colour": "red"}, "unknown fields"),
    ("sites", {"name": "X", "scale": {"beds": -1}}, "cannot be negative"),
    ("licences", {"kind": "Fire NOC", "valid_until": "next year"}, "must be a date"),
    ("licences", {"kind": "Fire NOC", "site_id": "SITE-nope"}, "no current site"),
    ("third_parties", {"name": "Waste agency", "criticality": "Huge"}, "must be one of"),
    ("history", {"kind": "INSPECTION", "occurred_on": "2026-01-01"}, "title is required"),
    ("history", {"kind": "AUDIT", "occurred_on": "2026-01-01", "title": "t"}, "must be one of"),
    ("history", {"kind": "CAPA", "occurred_on": "2026-01-01", "title": "t", "state": "CLOSED"}, "date it closed"),
])
def test_bad_values_are_refused_with_a_reason(con, kind, data, message):
    with pytest.raises(I.IntakeError, match=message):
        I.create_record(con, kind, data, "tester")


def test_update_and_retire(con):
    s = _site(con)
    lic = I.create_record(con, "licences", {"kind": "BMW authorisation", "site_id": s["id"],
                                            "valid_until": "2027-03-31"}, "tester")
    lic = I.update_record(con, "licences", lic["id"], {"number": "TSPCB/BMW/123"}, "tester")
    assert lic["number"] == "TSPCB/BMW/123"
    with pytest.raises(I.IntakeError, match="cannot be emptied"):
        I.update_record(con, "licences", lic["id"], {"kind": ""}, "tester")
    I.retire_record(con, "licences", lic["id"], "tester")
    assert I.list_records(con, "licences") == []
    assert len(I.list_records(con, "licences", include_retired=True)) == 1
    with pytest.raises(I.Conflict):
        I.update_record(con, "licences", lic["id"], {"number": "x"}, "tester")
    with pytest.raises(KeyError):
        I.update_record(con, "sites", "SITE-nope", {"name": "x"}, "tester")


# ------------------------------------------------------------------ attestations
def test_an_attestation_contradicted_by_records_is_refused(con):
    I.create_record(con, "history", {"kind": "INSPECTION", "occurred_on": "2026-02-10", "title": "SPCB visit",
                                     "outcome": "observations"}, "tester")
    with pytest.raises(I.Conflict, match="contradict"):
        I.attest(con, kind="INSPECTION", months=36, name="Dr Rao", designation="CEO", actor="tester")
    with pytest.raises(I.Conflict):
        I.attest(con, kind="ALL", months=36, name="Dr Rao", designation="CEO", actor="tester")
    a = I.attest(con, kind="RECALL", months=36, name="Dr Rao", designation="CEO", actor="tester")
    assert a["statement"] == f"No recalls in the 36 months to {date.today().isoformat()}."


def test_a_new_attestation_supersedes_the_old_one(con):
    I.attest(con, kind="INCIDENT", months=12, name="A", designation="COO", actor="t")
    I.attest(con, kind="INCIDENT", months=36, name="B", designation="CEO", actor="t")
    live = [a for a in I.attestations(con) if a["kind"] == "INCIDENT"]
    assert len(live) == 1 and live[0]["attested_by_name"] == "B"


def test_history_coverage_distinguishes_records_attestation_and_nothing(con):
    I.create_record(con, "history", {"kind": "COMPLAINT", "occurred_on": "2026-06-01", "title": "Billing"}, "t")
    I.attest(con, kind="RECALL", months=36, name="Dr Rao", designation="CEO", actor="t")
    I.attest(con, kind="PENALTY", months=12, name="Dr Rao", designation="CEO", actor="t")   # too short a window
    cov = I.history_coverage(con, TODAY)
    assert cov["COMPLAINT"] == {"status": "records", "count": 1}
    assert cov["RECALL"]["status"] == "attested"
    assert cov["PENALTY"]["status"] is None and cov["INSPECTION"]["status"] is None


# ------------------------------------------------------------------ appetite (G1)
def _content(**over):
    c = I.default_appetite()
    c.update(over)
    return c


def test_appetite_is_drafted_then_approved_and_versioned_bitemporally(con):
    assert I.appetite_for_engine(con) is None
    I.save_draft(con, _content(), "cm@x")
    with pytest.raises(I.IntakeError, match="name and designation"):
        I.approve_appetite(con, actor="ceo@x", actor_user_id="u1", approver_name="", designation="")
    st = I.approve_appetite(con, actor="ceo@x", actor_user_id="u1", approver_name="Dr Rao", designation="CEO")
    assert st["approved"]["version"] == 1 and st["draft"] is None
    eng = I.appetite_for_engine(con)
    assert eng["status"] == "APPROVED" and eng["version"] == 1 and "matrix" not in eng
    first_from = st["approved"]["valid_from"]
    c = _content()
    c["categories"]["safety"] = {"appetite": "LOW", "tolerance": "MEDIUM", "zero_tolerance": True}
    I.save_draft(con, c, "cm@x")
    st = I.approve_appetite(con, actor="ceo@x", actor_user_id="u1", approver_name="Dr Rao", designation="CEO")
    assert st["approved"]["version"] == 2
    old = next(h for h in st["history"] if h["version"] == 1)
    assert old["status"] == "SUPERSEDED" and old["valid_to"] == st["approved"]["valid_from"]
    # what was in force when version 1 was: still answerable
    assert I.appetite_for_engine(con, first_from)["version"] == 1
    assert I.appetite_for_engine(con)["categories"]["safety"]["zero_tolerance"] is True


@pytest.mark.parametrize("breaks, message", [
    (lambda c: c["categories"].pop("safety"), "every category"),
    (lambda c: c["categories"]["safety"].update(appetite="HIGH", tolerance="LOW"), "below appetite"),
    (lambda c: c["categories"]["safety"].update(appetite="SOME"), "must be one of"),
    (lambda c: c.update(confidence_threshold=140), "between 0 and 100"),
    (lambda c: c.update(matrix={1: ["LOW"]}), "needs rows 1..5"),
])
def test_bad_appetite_is_refused(con, breaks, message):
    c = _content()
    breaks(c)
    with pytest.raises(I.IntakeError, match=message):
        I.save_draft(con, c, "cm")


def test_a_returned_draft_must_be_saved_again_before_approval(con):
    I.save_draft(con, _content(), "cm")
    with pytest.raises(I.IntakeError, match="say what"):
        I.return_appetite(con, actor="ceo", note="")
    st = I.return_appetite(con, actor="ceo", note="Safety must be zero tolerance")
    assert st["draft"]["status"] == "RETURNED"
    with pytest.raises(I.Conflict):
        I.approve_appetite(con, actor="ceo", actor_user_id="u1", approver_name="A", designation="CEO")
    assert I.save_draft(con, _content(), "cm")["draft"]["status"] == "DRAFT"


def test_a_client_matrix_travels_with_the_appetite(con):
    m = {i: ["LOW", "LOW", "MEDIUM", "HIGH", "CRITICAL"] for i in range(1, 6)}
    I.save_draft(con, _content(matrix=m), "cm")
    I.approve_appetite(con, actor="ceo", actor_user_id="u1", approver_name="A", designation="CEO")
    assert I.appetite_for_engine(con)["matrix"][5] == ["LOW", "LOW", "MEDIUM", "HIGH", "CRITICAL"]


def test_who_may_govern(con):
    assert I.can_govern(con, {"id": "a", "role": "admin"})
    assert not I.can_govern(con, {"id": "u2", "role": "compliance_manager"})
    I.grant_governor(con, "u2", "Chairman", "admin@x")
    assert I.can_govern(con, {"id": "u2", "role": "viewer"})
    I.revoke_governor(con, "u2", "admin@x")
    assert not I.can_govern(con, {"id": "u2", "role": "viewer"}) and not I.can_govern(con, None)


# ------------------------------------------------------------------ facts (G2)
def test_a_fact_is_proposed_once_and_used_only_when_a_person_confirms(con):
    fid = I.propose_fact(con, fact_key="licence", value={"kind": "AERB licence", "number": "AERB/X/1"},
                         dedupe_key="doc:7:p3", extracted_by="llm:gpt-oss-120b", confidence=72,
                         citations=[{"file_name": "AERB.pdf", "page": 3, "quote": "Licence No. AERB/X/1"}])
    assert I.propose_fact(con, fact_key="licence", value={}, dedupe_key="doc:7:p3", extracted_by="x") is None
    assert I.list_records(con, "licences") == []                         # nothing used yet
    f = I.list_facts(con)[0]
    assert f["citations"][0]["page"] == 3 and f["value"]["number"] == "AERB/X/1"
    done = I.decide_fact(con, fid, "confirm", "cm@x")
    assert done["status"] == "CONFIRMED" and done["target_table"] == "company_licences"
    lic = I.list_records(con, "licences")[0]
    assert lic["source"] == "confirmed from llm:gpt-oss-120b" and lic["fact_id"] == fid
    with pytest.raises(I.Conflict, match="already confirmed"):
        I.decide_fact(con, fid, "reject", "cm@x", note="late")


def test_a_corrected_fact_keeps_both_values_and_a_rejection_needs_a_reason(con):
    fid = I.propose_fact(con, fact_key="site", value={"name": "Hyderbad"}, dedupe_key="k1", extracted_by="import:x")
    done = I.decide_fact(con, fid, "correct", "cm", value={"name": "Hyderabad", "site_type": "hospital"})
    assert done["status"] == "CORRECTED" and done["value"]["name"] == "Hyderbad"
    assert done["corrected_value"]["name"] == "Hyderabad"
    assert I.list_records(con, "sites")[0]["name"] == "Hyderabad"
    fid2 = I.propose_fact(con, fact_key="site", value={"name": "Pune"}, dedupe_key="k2", extracted_by="import:x")
    with pytest.raises(I.IntakeError, match="say why"):
        I.decide_fact(con, fid2, "reject", "cm")
    assert I.decide_fact(con, fid2, "reject", "cm", note="We have no Pune site")["status"] == "REJECTED"


def test_a_confirmed_bed_count_lands_on_the_profile(con):
    fid = I.propose_fact(con, fact_key="profile.beds", value={"beds": 250}, dedupe_key="b", extracted_by="rule:x")
    I.decide_fact(con, fid, "confirm", "cm")
    assert con.execute("SELECT beds FROM company_profile").fetchone()[0] == 250


def test_proposals_from_onboarding_records(con):
    con.executescript("""
      INSERT INTO company_entities VALUES ('E1','overview','location','Hyderabad Main', 'Head office',
        '{"state":"Telangana","locationType":"Hospital"}', 'Locations.csv');
      INSERT INTO company_entities VALUES ('E2','overview','business_activity','Biomedical waste',
        'Generator', '{"regulator":"TSPCB","licence":"BMW authorisation","licenceNo":"BMW-77","validTill":"Mar 2027"}', NULL);
      INSERT INTO company_entities VALUES ('E3','overview','business_activity','Retail', '', '{}', NULL);
      UPDATE company_profile SET derived_from='{"beds":{"file":"Profile.pdf","evidence":"a combined capacity of 250 beds"}}';
    """)
    out = I.propose_from_records(con)
    assert out == {"proposed": 3, "skipped": 1}
    facts = {f["fact_key"]: f for f in I.list_facts(con)}
    assert facts["licence"]["value"] == {"kind": "BMW authorisation", "issuer": "TSPCB", "number": "BMW-77",
                                         "valid_until": "2027-03-31"}
    assert facts["site"]["citations"][0]["file_name"] == "Locations.csv"
    assert facts["profile.beds"]["value"] == {"beds": 250}
    assert I.propose_from_records(con)["proposed"] == 0                  # proposed once


# ------------------------------------------------------------------ readiness
def test_readiness_names_what_blocks_scoring(con, rb):
    r = I.readiness(con, rb, TODAY)
    assert r["pack"] == "healthcare" and r["ready"] is False
    blocked = {i["key"] for i in r["items"] if i["mandatory"] and not i["done"]}
    assert blocked == {"sites", "scale", "history", "appetite"}
    _site(con, scale={"beds": 250})
    I.attest(con, kind="ALL", months=36, name="Dr Rao", designation="CEO", actor="t")
    I.save_draft(con, _content(), "cm")
    I.approve_appetite(con, actor="ceo", actor_user_id="u1", approver_name="Dr Rao", designation="CEO")
    r = I.readiness(con, rb, TODAY)
    assert r["ready"] is True
    assert next(i for i in r["items"] if i["key"] == "scale")["metric"] == "beds"


def test_a_site_without_its_scale_metric_is_not_scaled(con, rb):
    _site(con, scale={"ots": 4})                                           # beds is the healthcare metric
    item = next(i for i in I.readiness(con, rb, TODAY)["items"] if i["key"] == "scale")
    assert item["done"] is False and (item["count"], item["of"]) == (0, 1)


def test_the_sector_pack_follows_the_profile():
    assert I.pack_for({"entity_type": "Multi-speciality hospital", "sectors": []}) == "healthcare"
    assert I.pack_for({"entity_type": "NBFC", "sectors": ["Financial services"]}) == "base"


def test_loose_dates():
    assert I._loose_date("Mar 2027") == "2027-03-31"
    assert I._loose_date("31/12/2026") == "2026-12-31"
    assert I._loose_date("Perpetual") is None
