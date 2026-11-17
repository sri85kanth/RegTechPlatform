"""
The risk rulebook as data: it loads, merges a sector pack onto its base,
refuses malformed rules, and pins every assessment to a content hash.
Hermetic: no database.
"""
import shutil

import pytest
import yaml

from regulatory_ingestion.risk import predicates as P
from regulatory_ingestion.risk import rulebook as R


@pytest.fixture(scope="module")
def rb():
    return R.load("healthcare")


def _copy(tmp_path):
    for name in ("base", "healthcare"):
        shutil.copy(R.RULEBOOK_DIR / f"{name}.yaml", tmp_path / f"{name}.yaml")
    return tmp_path


def _edit(tmp_path, name, fn):
    p = tmp_path / f"{name}.yaml"
    data = yaml.safe_load(p.read_text())
    fn(data)
    p.write_text(yaml.safe_dump(data, sort_keys=False))


# ------------------------------------------------------------------ loading and merging
def test_healthcare_extends_base_and_keeps_both_sets_of_themes(rb):
    assert rb.ref["chain"] == ["base@1.0.0", "healthcare@1.0.0"]
    assert {"BMW", "RAD", "CYBER", "DATA"} <= set(rb.themes)          # pack themes plus base themes
    assert rb.ref["hash"].startswith("sha256:")


def test_a_theme_that_says_nothing_has_no_safety_class_and_no_critical_process(rb):
    assert rb.theme("CYBER")["safety_class"] == "none"
    assert rb.theme("RAD")["critical_process"] is False


def test_theme_mapping_pack_rules_come_first(rb):
    assert rb.theme_for(regulator="AERB")[0] == "RAD"
    assert rb.theme_for(title="Bio-Medical Waste Management Rules, 2016")[0] == "BMW"
    assert rb.theme_for(nabh_chapter="hic")[0] == "IPC"
    assert rb.theme_for(title="Something unrelated")[0] is None


def test_inspection_frequency_and_scale_index(rb):
    assert rb.inspection_frequency("aerb") == "biennial"
    assert rb.inspection_frequency("nobody") is None
    assert rb.scale_index({"beds": 250}) == "high"
    assert rb.scale_index({"beds": 60}) == "medium"
    assert rb.scale_index({"beds": 10}) == "low"
    assert rb.scale_index({}) is None                     # unknown, not "low"


# ------------------------------------------------------------------ pinning
def test_the_hash_is_stable_and_moves_when_any_rule_in_the_chain_moves(tmp_path, rb):
    d = _copy(tmp_path)
    assert R.load("healthcare", d).ref["hash"] == rb.ref["hash"]
    _edit(d, "base", lambda x: x["likelihood"]["modifiers"][0].update(add=2))
    assert R.load("healthcare", d).ref["hash"] != rb.ref["hash"]


# ------------------------------------------------------------------ refusals
@pytest.mark.parametrize("breaks, message", [
    (lambda d: d["impact"]["dimensions"]["regulatory"]["rules"][0].update(score=6), "integer 1..5"),
    (lambda d: d["impact"]["dimensions"]["regulatory"]["rules"][1].update(id="REG-IMP-01"), "duplicate rule id"),
    (lambda d: d["matrix"].update({5: ["HIGH", "HIGH"]}), "needs 5 bands"),
    (lambda d: d["impact"]["dimensions"]["safety"]["rules"][0].update(when={"theme.safety_class": ["a"]}), "bare list"),
    (lambda d: d["impact"]["dimensions"]["safety"]["rules"][0].update(applies_to=["building"]), "applies_to"),
    (lambda d: d["likelihood"]["modifiers"][0].update(add=3), "-2..2"),
    (lambda d: d["evaluation"].reverse(), "evaluation must list"),
    (lambda d: d["impact"]["dimensions"].pop("financial"), "exactly"),
    (lambda d: d.update(version="one"), "semver"),
])
def test_malformed_base_rules_are_refused_at_load(tmp_path, breaks, message):
    d = _copy(tmp_path)
    _edit(d, "base", breaks)
    with pytest.raises((R.RulebookError, P.PredicateError), match=message):
        R.load("healthcare", d)


def test_a_mapping_to_a_theme_nobody_defined_is_refused(tmp_path):
    d = _copy(tmp_path)
    _edit(d, "healthcare", lambda x: x["theme_mapping"].append({"regulator": "X", "theme": "NOPE"}))
    with pytest.raises(R.RulebookError, match="unknown theme"):
        R.load("healthcare", d)


def test_a_rulebook_cycle_is_refused(tmp_path):
    d = _copy(tmp_path)
    _edit(d, "base", lambda x: x.update(extends="healthcare"))
    with pytest.raises(R.RulebookError, match="cycle"):
        R.load("healthcare", d)


# ------------------------------------------------------------------ predicates
def test_predicates_are_three_valued():
    facts = {"a": {"n": 5, "flag": False, "tags": ["x", "y"]}}
    assert P.evaluate({"a.n": {"gte": 5}}, facts) == (True, set())
    assert P.evaluate({"a.flag": True}, facts) == (False, set())
    assert P.evaluate({"a.missing": True}, facts) == (None, {"a.missing"})
    assert P.evaluate({"a.tags": {"any_of": ["y", "z"]}}, facts)[0] is True
    assert P.evaluate({"a.tags": {"contains": "z"}}, facts)[0] is False
    assert P.evaluate({"a.missing": {"present": True}}, facts) == (False, set())   # presence is always known
    # one false part decides an AND even when another part is unknown
    assert P.evaluate({"a.flag": True, "a.missing": True}, facts) == (False, set())
    assert P.evaluate({"any": [{"a.missing": 1}, {"a.n": 5}]}, facts)[0] is True
    assert P.evaluate({"any": [{"a.missing": 1}, {"a.n": 4}]}, facts) == (None, {"a.missing"})
    assert P.evaluate({"not": {"a.flag": True}}, facts)[0] is True
    assert P.evaluate({"ratio": {"num": "a.n", "den": "a.missing", "gte": 1}}, facts) == (None, {"a.missing"})
    assert P.evaluate({"ratio": {"num": "a.n", "den": "a.n", "gte": 1}}, facts)[0] is True
