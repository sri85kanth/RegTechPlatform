"""
The seven applicability checks are not equal, and nothing may say they are.

The page used to show "3 of 7 checks match" and confidence counted matches, so a
Sector tick was worth as much as the Entity type tick that actually decides.
"7 Food Safety and Standards (Food Recall Procedure) Regulation, 2017" read
"3 of 7, Medium" for a hospital, and two of its three ticks were the same FSSAI
kitchen licence counted twice.

What is pinned here:
  * the verdict is still a ladder of gates, never a sum of weights;
  * the weights only measure evidence, and drive confidence;
  * one licence is one tick, and a licence-only entity match counts half.

Hermetic: no database.
"""
import os

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

from regulatory_ingestion import applicability as A  # noqa: E402


class _Rows:
    def __init__(self, rows): self._rows = rows
    def fetchall(self): return self._rows


class _Con:
    """Answers the queries evaluate() makes: regions, extracted thresholds, the text."""
    def __init__(self, regions=(("India", "ALL_INDIA"),), sections=()):
        self.regions, self.sections = list(regions), list(sections)

    def execute(self, sql, params=None):
        if "regulation_regions" in sql:
            return _Rows(self.regions)
        if "applicability_rules" in sql and "thresholds" in sql:
            return _Rows([])
        if "FROM sections" in sql:
            return _Rows(self.sections)
        raise AssertionError(sql)


HOSPITAL = {"entityType": "Hospital", "jurisdictions": ["India", "Telangana"], "hqState": "Telangana",
            "sectors": ["Healthcare & Hospitals"], "licences": ["FSSAI Licence"]}

FOOD_RECALL = {"id": "fssai-6f467ad3b1", "jurisdiction": "India", "regulator_short": "FSSAI",
               "sector": "Food Safety",
               "title": "7 Food Safety and Standards (Food Recall Procedure) Regulation, 2017"}
FOOD_RULES = [{"entity_type": "food business operator", "role": "ADDRESSEE", "source_clause": "2",
               "applicability_rule": "Every food business operator shall have a recall plan."}]

CEA = {"id": "cea", "jurisdiction": "India", "regulator_short": "MoHFW", "sector": "Healthcare",
       "issued_on": "2012-03-01", "title": "The Clinical Establishments Act, 2010"}
CEA_RULES = [{"entity_type": "hospital", "role": "ADDRESSEE", "source_clause": "3",
              "applicability_rule": "These rules apply to every hospital."}]


def _run(reg, rules, facts=HOSPITAL, regions=(("India", "ALL_INDIA"),), sections=()):
    v = A.evaluate(_Con(regions, sections), reg, rules, facts)
    return v, {c["name"]: c for c in v["checks"]}


def test_the_weights_are_not_equal_and_add_up_to_100():
    weights = {n: w for n, (w, _) in A.WEIGHTS.items()}
    assert sum(weights.values()) == 100
    assert len(set(weights.values())) > 1, "every check weighted the same again"
    assert weights["Entity type"] == max(weights.values())
    assert weights["Entity type"] >= 7 * weights["Sector"]
    gates = sum(w for w, tier in A.WEIGHTS.values() if tier == A.GATE)
    assert gates == 90, "supporting checks must never outweigh the gates"


def test_food_recall_no_longer_reads_as_three_equal_ticks():
    v, c = _run(FOOD_RECALL, FOOD_RULES)
    assert v["verdict"] == "CONDITIONAL"                          # the verdict itself is unchanged
    assert v["matched"] == 3                                       # still three ticks, as before
    assert c["Entity type"]["counts"] == 17.5                      # licence-only: half of 35
    assert "only through its licence" in c["Entity type"]["weightNote"]
    assert c["Regulator licence"]["result"] == "MATCH"
    assert c["Regulator licence"]["counts"] == 0                   # same FSSAI licence, not counted twice
    assert v["strength"]["confirmed"] == 37.5
    assert v["confidence"] == "Low", "38 of 100 is not Medium confidence"
    assert set(v["strength"]["notChecked"]) == {"Exemptions", "Thresholds"}
    assert "counts half" in v["why"]


def test_the_three_parts_always_add_up_to_100():
    for reg, rules, regions in ((FOOD_RECALL, FOOD_RULES, [("India", "ALL_INDIA")]),
                                (CEA, CEA_RULES, [("India", "ALL_INDIA")]),
                                (dict(CEA, title="Rajasthan Clinical Establishments Rules"), CEA_RULES,
                                 [("Rajasthan", "STATE_SPECIFIC")])):
        s = _run(reg, rules, regions=regions)[0]["strength"]
        assert s["confirmed"] + s["open"] + s["against"] == s["total"] == 100, s


def test_a_direct_match_counts_in_full():
    v, c = _run(CEA, CEA_RULES)
    assert v["verdict"] == "CONDITIONAL"
    assert c["Entity type"]["counts"] == 35 and "weightNote" not in c["Entity type"]
    # entity 35 + jurisdiction 20 + sector 5, and in force 10 of 15: no text, so the
    # date is inferred from publication. The MoHFW licence is not held.
    assert v["strength"]["confirmed"] == 70
    assert c["In force"]["counts"] == 10 and "publication" in c["In force"]["weightNote"]
    assert v["confidence"] == "Medium"
    assert v["strength"]["gates"] == {"met": 3, "total": 5}


def test_a_sector_tick_is_worth_a_seventh_of_an_entity_tick():
    with_sector = _run(CEA, CEA_RULES)[0]["strength"]["confirmed"]
    without = _run(dict(CEA, sector="Mining"), CEA_RULES)[0]["strength"]["confirmed"]
    assert with_sector - without == 5


def test_the_verdict_is_never_a_sum():
    """Everything else matches; one gate says no; the answer is no."""
    v, c = _run(dict(CEA, title="Rajasthan Clinical Establishments Rules"), CEA_RULES,
                regions=[("Rajasthan", "STATE_SPECIFIC")])
    assert c["Entity type"]["result"] == "MATCH" and c["In force"]["result"] == "MATCH"
    assert v["verdict"] == "NOT_APPLICABLE"
    assert v["confidence"] == "High", "the corpus records it as made for another state"


def test_supporting_checks_cannot_make_a_regulation_apply():
    facts = {"entityType": "", "jurisdictions": ["India"], "sectors": ["Healthcare"],
             "licences": ["NABH Accreditation"]}
    reg = dict(CEA, regulator_short="NABH")
    v, c = _run(reg, CEA_RULES, facts=facts)
    assert c["Sector"]["result"] == "MATCH" and c["Regulator licence"]["result"] == "MATCH"
    assert v["verdict"] == "REVIEW_REQUIRED" and v["confidence"] == "Low"


def test_how_sure_a_no_is_depends_on_what_said_no():
    draft, _ = _run(dict(CEA, title="Draft Clinical Establishments Rules, 2026"), CEA_RULES)
    assert draft["verdict"] == "NOT_APPLICABLE" and draft["confidence"] == "High"
    # named other entity types: an inference from the vocabulary, not a statement
    banks = [{"entity_type": "banks", "role": "ADDRESSEE", "source_clause": "1",
              "applicability_rule": "These directions apply to all banks."}]
    other, c = _run(CEA, banks)
    assert c["Entity type"]["result"] == "NO_MATCH"
    assert other["verdict"] == "NOT_APPLICABLE" and other["confidence"] == "Medium"


def test_the_regulator_licence_counts_when_it_is_independent_evidence():
    facts = dict(HOSPITAL, licences=["Clinical Establishment Registration MoHFW"])
    v, c = _run(CEA, CEA_RULES, facts=facts)
    assert c["Entity type"]["counts"] == 35          # from the entity type, not a licence
    assert c["Regulator licence"]["result"] == "MATCH"
    assert c["Regulator licence"]["counts"] == 5
    assert v["strength"]["confirmed"] == 75
