"""
The risk scoring engine, pinned rule by rule, plus the three worked examples.
Pure functions over the shipped rulebooks: no database, no model, fixed date.
"""
import copy

import pytest
import yaml

from regulatory_ingestion.risk import engine as E
from regulatory_ingestion.risk import rulebook as R

AS_OF = "2026-11-12"
EXAMPLES = yaml.safe_load((R.RULEBOOK_DIR / "examples" / "worked-examples.yaml").read_text())
APPETITE = EXAMPLES["appetite"]


@pytest.fixture(scope="module")
def rb():
    return R.load("healthcare")


def _example(name):
    return copy.deepcopy(next(e for e in EXAMPLES["examples"] if e["name"] == name)["input"])


def _assess(rb, risk_input, appetite=APPETITE):
    return E.assess(rb, risk_input, appetite, AS_OF)


def _one(risk_input):
    return risk_input["exposures"][0]


# ------------------------------------------------------------------ the three worked examples
@pytest.mark.parametrize("example", EXAMPLES["examples"], ids=lambda e: e["name"])
def test_worked_examples(rb, example):
    a = _assess(rb, copy.deepcopy(example["input"]))
    exp = example["expect"]
    assert a["verdict"] == exp["verdict"]
    for point in ("inherent", "residual", "target"):
        if point in exp:
            assert a[point]["band"] == exp[point], point
    assert a["engine"] == E.ENGINE and a["rulebook"]["hash"] == rb.ref["hash"]


def test_high_example_derivation_names_every_rule(rb):
    a = _assess(rb, _example("high"))
    steps = {s["step"]: s for s in a["derivation"]}
    assert steps["impact.regulatory"]["rule"] == "REG-IMP-01"          # imprisonment under the enabling Act
    assert steps["impact.operational"]["rule"] == "OPS-IMP-01"         # guards the SPCB authorisation
    assert steps["likelihood.base"]["value"] == 3
    assert {s["rule"] for s in a["derivation"] if s["step"] == "likelihood.modifier"} == {"LIK-EXP-02"}
    ctl = steps["controls.grade"]["controls"][0]
    assert ctl["grade"] == "DOCUMENTED" and "TESTED → DOCUMENTED" in ctl["note"]   # 70 days against 45
    assert a["confidence"]["deductions"] == {"fact_unconfirmed": 5, "gap_status_unreviewed": 10}
    assert "ESCALATE" in a["rationale"] and "REG-IMP-01" in a["rationale"]


def test_insufficient_example_lists_what_is_missing_and_bounds_it(rb):
    a = _assess(rb, _example("insufficient"))
    mandatory = {m["fact"] for m in a["missing"] if m["mandatory"]}
    assert mandatory == {"controls", "history.status"}
    assert a["provisional"] is True
    assert (a["bounds"]["best"]["band"], a["bounds"]["worst"]["band"]) == ("HIGH", "CRITICAL")
    assert a["confidence"]["band"] == "LOW"
    assert "Between HIGH and CRITICAL" in a["rationale"]


# ------------------------------------------------------------------ the matrix
def test_the_band_is_a_lookup_not_a_product(rb):
    m, _ = E._matrix(rb, None)
    assert E._point(m, 5, 1)["band"] == "HIGH"        # rare catastrophe: never below HIGH
    assert E._point(m, 1, 5)["band"] == "MEDIUM"      # frequent trivia: same product, lower band


def test_a_client_matrix_replaces_the_rulebook_matrix(rb):
    appetite = copy.deepcopy(APPETITE)
    appetite["matrix"] = {i: ["LOW"] * 5 for i in range(1, 6)}
    a = _assess(rb, _example("high"), appetite)
    assert a["matrix_source"] == "client" and a["residual"]["band"] == "LOW"
    appetite["matrix"] = {1: ["LOW"]}
    with pytest.raises(ValueError, match="needs rows 1..5"):
        _assess(rb, _example("high"), appetite)


# ------------------------------------------------------------------ impact
def test_an_unknown_fact_never_lowers_impact(rb):
    ri = _example("low")
    del _one(ri)["facts"]["penalty"]["imprisonment"]          # REG-IMP-01 can no longer be checked
    a = _assess(rb, ri)
    reg = a["exposures"][0]["impact"]["dimensions"]["regulatory"]
    assert reg["score"] == 5 and reg["best"] == 2 and reg["precaution"] is True
    assert "REG-IMP-01" in reg["unknown_rules"] and "penalty.imprisonment" in reg["missing"]


def test_rules_for_another_exposure_kind_do_not_run(rb):
    # an obligation has no graph node: OPS-IMP-03 must not read node.criticality as unknown
    a = _assess(rb, _example("low"))
    ops = a["exposures"][0]["impact"]["dimensions"]["operational"]
    assert ops["rule"] == "default" and ops["unknown_rules"] == [] and ops["default_used"] is False


def test_no_penalty_clause_falls_back_by_instrument_type_and_costs_confidence(rb):
    ri = _example("low")
    _one(ri)["facts"]["penalty"] = {"present": False, "imprisonment": False, "max_fine_inr": 0}
    a = _assess(rb, ri)
    reg = a["exposures"][0]["impact"]["dimensions"]["regulatory"]
    assert reg["rule"] == "default by instrument_type" and reg["score"] == 3 and reg["default_used"]


def test_a_nabh_core_standard_lifts_safety_to_its_floor(rb):
    ri = _example("low")
    _one(ri)["facts"]["nabh_category"] = "CORE"
    a = _assess(rb, ri)
    safety = a["exposures"][0]["impact"]["dimensions"]["safety"]
    assert safety["score"] == 4 and "NABH CORE floor" in safety["rule"]


def test_safety_does_not_apply_to_a_theme_with_no_safety_class(rb):
    ri = _example("low")
    ri["risk"]["theme"] = "LICENCE"
    a = _assess(rb, ri)
    assert a["exposures"][0]["impact"]["dimensions"]["safety"] == {"applicable": False}


# ------------------------------------------------------------------ likelihood
def test_history_drives_likelihood(rb):
    ri = _example("low")
    ri["shared"]["history"].update(open_observations_theme_24m=1, serious_36m=1)
    a = _assess(rb, ri)
    lik = a["exposures"][0]["likelihood"]
    assert {f["id"] for f in lik["fired"]} == {"LIK-EXP-02", "LIK-HIS-01", "LIK-HIS-02"}
    assert lik["score"] == 5                                   # 3 + 1 + 1 + 2, clamped


def test_an_unknown_optional_modifier_widens_the_bounds(rb):
    ri = _example("low")
    del _one(ri)["facts"]["requirement"]                        # change velocity unknown
    a = _assess(rb, ri)
    lik = a["exposures"][0]["likelihood"]
    assert (lik["best"], lik["score"]) == (4, 5) and lik["precaution"]
    assert "requirement.section_changed_12m" in a["exposures"][0]["optional_missing"]
    assert a["verdict"] != "INSUFFICIENT_EVIDENCE"              # optional: priced in, not blocking


def test_no_history_collected_is_not_a_clean_history(rb):
    ri = _example("low")
    ri["shared"]["history"] = {"status": None}
    a = _assess(rb, ri)
    assert a["verdict"] == "INSUFFICIENT_EVIDENCE"
    assert {m["fact"] for m in a["missing"] if m["mandatory"]} == {"history.status"}


# ------------------------------------------------------------------ controls
def _with_control(rb, **control):
    ri = _example("low")
    _one(ri)["controls"] = [{"id": "C", "label": "c", "kind": "preventive", **control}]
    return _assess(rb, ri)


def test_unknown_is_not_absent(rb):
    ri = _example("low")
    _one(ri)["gap_status"] = None                               # not yet checked against our documents
    _one(ri)["controls"] = [{"id": "C", "label": "c", "approved_document": None, "test_evidence": None,
                             "self_declared": None}]
    unknown = _assess(rb, ri)
    assert unknown["verdict"] == "INSUFFICIENT_EVIDENCE"
    assert {m["fact"] for m in unknown["missing"] if m["mandatory"]} == {"controls"}
    absent = _with_control(rb, confirmed_absent=True)
    assert absent["exposures"][0]["controls"]["grade"] == "ABSENT"
    assert absent["residual"] == absent["inherent"]


def test_freshness_decay(rb):
    fresh = _with_control(rb, approved_document=True, test_evidence=True, frequency="monthly",
                          newest_evidence_on="2026-10-20")
    stale = _with_control(rb, approved_document=True, test_evidence=True, frequency="monthly",
                          newest_evidence_on="2026-08-01")                              # 103 days: 2.3×
    old = _with_control(rb, approved_document=True, test_evidence=True, frequency="monthly",
                        newest_evidence_on="2026-01-01")                                # > 3×
    undated = _with_control(rb, approved_document=True, test_evidence=True, frequency="monthly")
    grade = lambda a: a["exposures"][0]["controls"]["grade"]  # noqa: E731
    assert (grade(fresh), grade(stale), grade(old), grade(undated)) == ("TESTED", "DOCUMENTED", "CLAIMED", "DOCUMENTED")


def test_the_gap_review_caps_and_implies_the_grade(rb):
    ri = _example("low")
    _one(ri)["gap_status"] = "GAP"
    a = _assess(rb, ri)
    c = a["exposures"][0]["controls"]
    assert c["grade"] == "ABSENT" and c["capped_by"] == "gap review GAP"
    ri = _example("low")
    _one(ri)["controls"] = []
    a = _assess(rb, ri)
    assert a["exposures"][0]["controls"]["grade"] == "DOCUMENTED"      # MET with nothing mapped
    assert a["exposures"][0]["controls"]["source"] == "gap review says MET"


def test_a_tested_corrective_control_also_lowers_impact(rb):
    a = _with_control(rb, kind="corrective", approved_document=True, test_evidence=True, frequency="monthly",
                      newest_evidence_on="2026-11-01")
    ex = a["exposures"][0]
    assert ex["residual"]["impact"] == ex["inherent"]["impact"] - 1


def test_target_assumes_planned_actions_reach_tested(rb):
    a = _assess(rb, _example("high"))
    ex = a["exposures"][0]
    assert ex["residual"]["likelihood"] == 3 and ex["target"]["likelihood"] == 2
    ri = _example("high")
    _one(ri)["planned"] = []
    assert _assess(rb, ri)["target"] == _assess(rb, ri)["residual"]


# ------------------------------------------------------------------ roll-up and evaluation
def test_the_worst_exposure_drives_and_is_named(rb):
    ri = _example("low")
    bmw = _one(_example("high"))
    bmw["id"] = "X-BMW"
    ri["exposures"].append(bmw)
    a = _assess(rb, ri)
    assert a["driver"] == "X-BMW" and a["residual"]["band"] == "CRITICAL"


def test_a_confirmed_breach_is_not_hidden_behind_missing_evidence(rb):
    ri = _example("high")
    unknown = copy.deepcopy(_one(_example("low")))
    unknown.update(id="X-UNKNOWN", gap_status=None, controls=[])
    ri["exposures"].append(unknown)
    a = _assess(rb, ri)
    assert a["verdict"] == "ESCALATE" and "can only add to it" in a["verdict_reason"]


def test_a_known_treat_is_kept_as_the_floor_of_insufficient_evidence(rb):
    ri = _example("high")
    ri["exposures"][0]["planned"] = []
    appetite = copy.deepcopy(APPETITE)
    appetite["categories"]["regulatory"] = {"appetite": "HIGH", "tolerance": "CRITICAL"}
    unknown = copy.deepcopy(_one(_example("low")))
    unknown.update(id="X-UNKNOWN", gap_status=None, controls=[])
    ri["exposures"].append(unknown)
    a = _assess(rb, ri, appetite)
    assert a["verdict"] == "INSUFFICIENT_EVIDENCE" and a["floor_verdict"] == "TREAT"


def test_appetite_not_approved_means_review(rb):
    a = _assess(rb, _example("low"), {"status": "DRAFT"})
    assert (a["verdict"], a["verdict_rule"]) == ("REVIEW_REQUIRED", "EV-03")
    assert a["residual"]["band"] == "LOW"                    # scores are still shown


def test_zero_tolerance_escalates_above_appetite(rb):
    appetite = copy.deepcopy(APPETITE)
    appetite["categories"]["regulatory"] = {"appetite": "LOW", "tolerance": "CRITICAL", "zero_tolerance": True}
    ri = _example("low")
    ri["shared"]["history"]["open_observations_theme_24m"] = 1     # residual MEDIUM
    a = _assess(rb, ri, appetite)
    assert (a["verdict"], a["verdict_rule"]) == ("ESCALATE", "EV-04")


def test_low_confidence_within_appetite_goes_to_review(rb):
    appetite = copy.deepcopy(APPETITE)
    appetite["confidence_threshold"] = 101
    a = _assess(rb, _example("low"), appetite)
    assert (a["verdict"], a["verdict_rule"]) == ("REVIEW_REQUIRED", "EV-06")


def test_unresolved_applicability_is_review_and_not_applicable_is_excluded(rb):
    ri = _example("low")
    _one(ri)["applicability"] = "REVIEW_REQUIRED"
    a = _assess(rb, ri)
    assert (a["verdict"], a["verdict_rule"]) == ("REVIEW_REQUIRED", "EV-01")
    ri = _example("high")
    extra = copy.deepcopy(_one(_example("low")))
    extra.update(id="X-NA", applicability="NOT_APPLICABLE")
    ri["exposures"].append(extra)
    a = _assess(rb, ri)
    assert a["not_applicable_exposures"] == ["X-NA"] and a["verdict"] == "ESCALATE"


def test_conditional_applicability_and_draft_seeds_cost_confidence(rb):
    ri = _example("low")
    _one(ri)["applicability"] = "CONDITIONAL"
    a = _assess(rb, ri)
    assert a["confidence"]["deductions"]["applicability_conditional"] == 15


# ------------------------------------------------------------------ reproducibility
def test_same_inputs_same_hash_and_any_change_moves_it(rb):
    a, b = _assess(rb, _example("high")), _assess(rb, _example("high"))
    assert a["inputs_hash"] == b["inputs_hash"] and a == b
    ri = _example("high")
    ri["shared"]["exposure"]["sites"] = 2
    assert _assess(rb, ri)["inputs_hash"] != a["inputs_hash"]
    assert E.assess(rb, _example("high"), APPETITE, "2026-12-31")["inputs_hash"] != a["inputs_hash"]
