"""
Requirement-level applicability, pinned.

The only per-requirement "not applicable" the system had was a blanket one:
15,038 requirements, one boilerplate reason, 868 of them reading "the hospital
shall". Each requirement is now read on its own words. Hermetic: no database.
"""
import os

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

from regulatory_ingestion import requirement_applicability as R  # noqa: E402

HOSPITAL = {"hospital", "employer", "laboratory", "pharmacy", "waste generator", "building occupier",
            "data fiduciary", "principal employer"}
ORIGINS = {"hospital": 'entity type "Hospital"', "employer": "employee count 413"}


def _d(text, reg="APPLICABLE"):
    return R.decide(text, reg, HOSPITAL, ORIGINS)


def test_a_duty_on_the_hospital_applies_and_says_why():
    d = _d("The hospital shall maintain a register of adverse events.")
    assert d["status"] == "APPLICABLE" and d["kind"] == "OURS"
    assert 'entity type "Hospital"' in d["reason"]


def test_never_more_applicable_than_the_regulation():
    assert _d("The hospital shall maintain a register.", "CONDITIONAL")["status"] == "CONDITIONAL"
    assert _d("The hospital shall maintain a register.", "REVIEW_REQUIRED")["status"] == "REVIEW_REQUIRED"
    assert _d("The hospital shall maintain a register.", None)["status"] == "UNASSESSED"
    assert _d("The hospital shall maintain a register.", "NOT_APPLICABLE")["status"] == "NOT_APPLICABLE"


def test_definitions_and_commencement_are_not_duties():
    for s in ('"Bio-medical waste" means any waste generated during diagnosis.',
              "In these rules, unless the context otherwise requires, occupier shall mean a person.",
              "They shall come into force with effect from the 1st day of September, 2023.",
              "These rules may be called the Bio-Medical Waste Management Rules, 2016.",
              "An invasive medical device shall be assigned to Class A, if it is intended for transient use."):
        d = _d(s)
        assert d["status"] == "NOT_APPLICABLE" and d["kind"] == "NOT_A_DUTY", s


def test_a_duty_of_the_authority_is_not_ours():
    for s in ("The Central Government shall notify the standards.",
              "The Appellate Tribunal shall dispose of the appeal within ninety days.",
              "The licensing authority shall inspect the premises before granting the licence."):
        d = _d(s)
        assert d["status"] == "NOT_APPLICABLE" and d["kind"] == "AUTHORITY", s


def test_the_hospitals_own_board_and_committees_are_ours():
    for s in ("The Board shall approve the annual compliance plan.",
              "The infection control committee shall meet every month."):
        assert _d(s)["status"] != "NOT_APPLICABLE", s


def test_a_type_the_hospital_plainly_is_not_rules_it_out():
    for s in ("Every insurer shall settle the claim within thirty days.",
              "The manufacturer shall affix the label on the device."):
        d = _d(s)
        assert d["status"] == "NOT_APPLICABLE" and d["kind"] == "OTHER_TYPE", s
        assert "which the company is not" in d["reason"]


def test_an_ambiguous_addressee_goes_to_a_person_never_to_no():
    for s in ("The licensee shall display the licence at the premises.",
              "The contractor shall maintain a muster roll."):
        d = _d(s)
        assert d["status"] == "CONDITIONAL" and d["kind"] == "AMBIGUOUS_TYPE", s


def test_a_waste_generating_hospital_is_the_occupier():
    d = _d("The occupier shall segregate bio-medical waste at the point of generation.")
    assert d["kind"] == "OURS" and d["status"] == "APPLICABLE"


def test_a_situation_goes_to_a_person():
    d = _d("Where the hospital operates a blood bank, it shall keep a donor register.")
    assert d["status"] == "CONDITIONAL" and d["kind"] == "SITUATION"


def test_a_duty_naming_no_one_inherits_the_regulation():
    d = _d("Records shall be kept for five years.", "CONDITIONAL")
    assert d["status"] == "CONDITIONAL" and d["kind"] == "INHERITS"
    assert "conditional" in d["reason"]


def test_silence_is_never_a_no():
    for s in ("", None, "Infection control programme", "Laboratory services: quality assurance"):
        assert _d(s)["status"] != "NOT_APPLICABLE", s
