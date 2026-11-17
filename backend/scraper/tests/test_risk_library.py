"""
The risk library: register rows become node-type templates, ratings stay a
benchmark, treatment labels take their ISO 31000 meaning, and a template on a
graph node is an exposure the engine can score. Hermetic: no database.
"""
import pytest

from regulatory_ingestion.risk import engine as E
from regulatory_ingestion.risk import library as L
from regulatory_ingestion.risk import library_build as B
from regulatory_ingestion.risk import rulebook as R


@pytest.fixture(scope="module")
def rb():
    return R.load("healthcare")


@pytest.fixture(scope="module")
def lib(rb):
    return L.load(rb)


def _row(**kw):
    base = dict(sr=7, risk_type="Operational", division="General IT", control_area="Cyber Security",
                process="VAPT", description="No regular vulnerability assessment", cia="Integrity, Availability",
                consequence="Systems stay exposed", likelihood=5, impact=4, score=20, level="E",
                actions="Conduct VA half yearly and PT yearly", treatment="Mitigation",
                post_likelihood=2, post_impact=3, post_score=6, post_level="M")
    base.update(kw)
    return base


# ------------------------------------------------------------------ building templates
def test_a_row_becomes_a_node_type_template_with_its_rating_as_benchmark_only():
    t = B.template(_row(), "sample.xlsx")
    assert (t["id"], t["theme"], t["node_type"]) == ("LIB-007", "CYBER", "system")
    assert t["applies_when"] == {"org.has_systems": True}
    assert t["benchmark"]["prior"] == {"likelihood": 5, "impact": 4, "score": 20, "level": "E"}
    assert t["seeds"] == {"operational": 4, "regulatory": 2, "financial": 2, "reputational": 2}   # from type + CIA only
    assert t["seed_status"] == "draft" and t["base_likelihood"] == "frequent"
    assert t["typical_controls"][0]["intervals_days"] == [180, 365]      # half yearly is not also yearly… and yearly is
    assert t["flags"] == []


def test_cia_typos_and_line_breaks_are_forgiven():
    assert B.cia("Cofidentiality\nIntegrity\nAvailability") == ["confidentiality", "integrity", "availability"]
    assert B.cia("Confidentiatity\nIntegrity") == ["confidentiality", "integrity"]
    assert B.cia("Integrity and availability") == ["integrity", "availability"]


def test_division_spellings_collapse():
    assert B.division("IT-Security") == B.division("IT Security") == "IT Security"
    assert B.division("PES BU / SES BU") == "Engineering BU"


def test_control_area_wins_over_division():
    assert B.placement("General IT", "Cloud Security")[:3] == ("CYBER", "system", {"node.hosting": "cloud"})
    assert B.placement("Enterprise Risk", "ESG Reporting")[:3] == ("ESG", "organisation", {"org.listed": True})
    assert B.placement("Unheard Of", "Whatever")[3].startswith("no mapping")


def test_treatment_labels_take_their_standard_meaning_and_contradictions_are_flagged():
    # the sample legend has Accepted / Avoidance interchanged (decision D3): labels keep ISO 31000 meaning
    t = B.template(_row(treatment="Avoidance", post_score=20), "s")
    assert t["benchmark"]["treatment"] == "AVOID" and t["flags"] == ["avoidance_without_reduction"]
    t = B.template(_row(treatment="Acceptance", post_score=20), "s")
    assert t["benchmark"]["treatment"] == "ACCEPT" and t["flags"] == []          # accepting changes nothing: fine
    t = B.template(_row(post_score=25), "s")
    assert "risk_rises_after_treatment" in t["flags"]


def test_duplicate_row_numbers_are_refused():
    with pytest.raises(ValueError, match="duplicate"):
        B.build([_row(), _row()], "s")


# ------------------------------------------------------------------ the shipped library
def test_the_shipped_library_is_the_sample_register(lib, rb):
    assert len(lib.templates) == 131
    assert len({t["id"] for t in lib.templates}) == 131
    assert all(rb.theme(t["theme"]) for t in lib.templates)
    flagged = {t["id"]: t["flags"] for t in lib.templates if t["flags"]}
    assert sum("avoidance_without_reduction" in f for f in flagged.values()) == 5
    assert flagged["LIB-054"] == ["risk_rises_after_treatment"]


def test_unknown_facts_make_a_template_a_candidate_not_a_drop(lib):
    cloud = next(t for t in lib.templates if t["control_area"] == "Cloud Security")
    assert L.applies(cloud, {"node": {"hosting": "cloud"}})[0] is True
    assert L.applies(cloud, {"node": {"hosting": "on-premise"}})[0] is False
    assert L.applies(cloud, {"node": {}}) == (None, {"node.hosting"})
    ex = L.exposure(cloud, {"id": "SYS-HIS", "label": "Hospital information system"}, {})
    assert ex["applicability"] == "REVIEW_REQUIRED" and ex["applicability_missing"] == ["node.hosting"]
    assert L.exposure(cloud, {"id": "SYS-X", "hosting": "on-premise"}, {}) is None


def test_a_template_on_a_critical_system_scores_from_the_node(lib, rb):
    backup = lib.get("LIB-009")                                    # no strategic backup solution
    ex = L.exposure(backup, {"id": "SYS-HIS", "label": "HIS", "criticality": "Critical"}, {"has_systems": True})
    ex["controls"] = [{"id": "C-BKP", "label": "Nightly backup with quarterly restore test", "kind": "corrective",
                       "approved_document": True, "test_evidence": True, "frequency": "quarterly",
                       "newest_evidence_on": "2026-10-01"}]
    risk = {"risk": {"id": "R-CYBER-HIS", "title": "Backup and recovery — HIS", "theme": "CYBER", "site": "*"},
            "shared": {"exposure": {"sites": 1, "scale_index": "high"},
                       "history": {"status": "attested", "open_observations_theme_24m": 0, "serious_36m": 0,
                                   "overdue_capa_theme": 0, "clean_inspection_theme_24m": False}},
            "exposures": [ex]}
    a = E.assess(rb, risk, {"status": "APPROVED", "categories": {"default": {"appetite": "MEDIUM",
                                                                               "tolerance": "HIGH"}}}, "2026-11-12")
    ops = a["exposures"][0]["impact"]["dimensions"]["operational"]
    assert ops["rule"] == "OPS-IMP-03" and ops["score"] == 5                # the node's criticality, not the seed
    assert a["exposures"][0]["likelihood"]["base_rule"] == "base: template.base_likelihood = frequent"
    assert a["confidence"]["deductions"]["template_seed_unreviewed"] == 10
    assert a["residual"]["impact"] == 4                                      # tested corrective control
    assert a["verdict"] in E.VERDICTS
