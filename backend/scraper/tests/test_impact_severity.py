"""
Impact severity must come from evidence about the regulation, never from the
score's own previous result.

store() writes the computed level into regulations.impact_level. Severity used
to be read back from that same column, so a regulation once scored Critical
kept a Critical severity on every rescore — "7 Food Safety and Standards (Food
Recall Procedure) Regulation, 2017" read 90/Critical while every requirement the
gap assessment rated was Medium or Low. Hermetic: no database.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from regulatory_ingestion import impact_v2 as V  # noqa: E402

BRAIN = {
    "c1": {"domain": "controls", "criticality": "Medium"},
    "c2": {"domain": "controls", "criticality": "Medium"},
    "s1": {"domain": "systems", "criticality": "Medium"},
    "d1": {"domain": "departments", "criticality": ""},
}
REACHED = [{"company_brain_entity_id": k} for k in BRAIN]
OBLIGATIONS = [{"text": f"ob{i}"} for i in range(20)]
PROFILE = {"sectors": ["Healthcare & Hospitals"], "licences": ["FSSAI"], "source_verified": True}


def _score(reg, override=None):
    return V.score(REACHED, OBLIGATIONS, "CONDITIONAL", BRAIN, reg, edges=[], profile_facts=PROFILE,
                   severity_override=override)


def test_the_worst_assessed_risk_sets_severity():
    sev, why = V.severity_from_assessment(["Medium", "Low", "Medium", "Medium", "Medium"])
    assert sev == V.PARAMS["severity"]["Medium"]
    assert "Medium" in why and "4 of 5" in why
    assert V.severity_from_assessment(["Low", "High", "None", ""])[0] == V.PARAMS["severity"]["High"]


def test_nothing_assessed_gives_no_assessed_severity():
    assert V.severity_from_assessment([]) == (None, "")
    assert V.severity_from_assessment(["None", "", None]) == (None, "")


def test_the_previous_level_no_longer_drives_the_score():
    # identical regulations except for what a previous run wrote into impact_level
    was_critical = _score({"impact_level": "Critical", "effective_from": ""})
    was_low = _score({"impact_level": "Low", "effective_from": ""})
    assert was_critical["residualScore"] == was_low["residualScore"]
    assert "neutral default" in __import__("json").loads(was_critical["factors"])["severity"]["from"]


def test_rescoring_is_stable_when_the_level_is_fed_back():
    reg = {"impact_level": "Critical", "effective_from": ""}
    first = _score(reg)
    reg["impact_level"] = first["level"]          # what store() writes back
    second = _score(reg)
    assert (first["residualScore"], first["level"]) == (second["residualScore"], second["level"])


def test_medium_assessed_risks_score_lower_than_the_old_critical_proxy():
    medium = _score({"effective_from": ""}, V.severity_from_assessment(["Medium"] * 4 + ["Low"]))
    critical = _score({"effective_from": ""}, (V.PARAMS["severity"]["Critical"], "old proxy"))
    assert medium["residualScore"] < critical["residualScore"]
    # same footprint, severity 0.55 instead of 1.0: the score scales with it
    assert abs(medium["inherentScore"] - critical["inherentScore"] * 0.55) <= 1
