"""
"Not mentioned" means two things, and they must never be confused:
we READ the text and it says nothing (evidence), or we never read it (none).

In force, Exemptions and Thresholds now read the regulation's own text:
  * In force:   the commencement clause, then the publication date (counted as
                inferred, 10 of 15), then "not known". Never a guess.
  * Exemptions: a text read in full with no carve-out is a yes. A carve-out
                naming only other types is a yes. One naming this kind of
                company, or nobody recognisable, goes to a person.
  * Thresholds: a text read in full with no size condition is a yes. Fines
                are not conditions.
A text we do not hold leaves all of it "not checked yet".

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
    def __init__(self, sections=()): self.sections = list(sections)

    def execute(self, sql, params=None):
        if "regulation_regions" in sql:
            return _Rows([("India", "ALL_INDIA")])
        if "applicability_rules" in sql and "thresholds" in sql:
            return _Rows([])
        if "FROM sections" in sql:
            return _Rows(self.sections)
        raise AssertionError(sql)


HOSPITAL = {"entityType": "Hospital", "jurisdictions": ["India", "Telangana"], "hqState": "Telangana",
            "sectors": ["Healthcare & Hospitals"], "licences": []}
REG = {"id": "r1", "jurisdiction": "India", "regulator_short": "MoHFW", "sector": "Healthcare",
       "issued_on": "2018-05-01", "title": "The Hospital Patient Safety Rules, 2018"}
RULES = [{"entity_type": "hospital", "role": "ADDRESSEE", "source_clause": "2",
          "applicability_rule": "These rules apply to every hospital."}]
FILLER = ("Every hospital shall maintain a register of incidents, review it every month, and "
          "keep the records for inspection by the authority at all reasonable times. ") * 6

COMMENCE_ON_PUBLICATION = ("Short title and commencement",
                           "(1) These rules may be called the Hospital Patient Safety Rules, 2018. "
                           "(2) They shall come into force on the date of their publication in the "
                           "Official Gazette.")


def _run(*sections, reg=REG, rules=RULES, facts=HOSPITAL):
    v = A.evaluate(_Con(sections), reg, rules, facts)
    return v, {c["name"]: c for c in v["checks"]}


# ---------------------------------------------------------------- in force
def test_commencement_on_publication_counts_in_full():
    v, c = _run(COMMENCE_ON_PUBLICATION, ("Duties", FILLER))
    assert c["In force"]["result"] == "MATCH" and not c["In force"].get("inferred")
    assert c["In force"]["counts"] == 15
    assert "publication" in c["In force"]["clauseText"]


def test_a_silent_text_falls_back_to_the_publication_date_at_two_thirds():
    v, c = _run(("Duties", FILLER))
    assert c["In force"]["result"] == "MATCH" and c["In force"]["inferred"]
    assert c["In force"]["counts"] == 10


def test_commencement_by_notification_is_not_known_until_notified():
    v, c = _run(("Short title, extent and commencement",
                 "It shall come into force on such date as the Central Government may, by "
                 "notification in the Official Gazette, appoint."), ("Duties", FILLER))
    assert c["In force"]["result"] == "UNKNOWN"
    assert "notification" in c["In force"]["detail"]


def test_a_period_after_publication_is_counted_from_the_issue_date():
    reg = dict(REG, issued_on="2099-01-15")
    v, c = _run(("Commencement", "This Order shall come into force on the expiry of six months "
                                 "from the date of its publication in the Official Gazette."),
                ("Duties", FILLER), reg=reg)
    assert c["In force"]["result"] == "UNKNOWN" and c["In force"]["expected"] == "2099-07-15"


def test_no_date_and_no_words_stays_unknown():
    v, c = _run(("Duties", FILLER), reg=dict(REG, issued_on=None))
    assert c["In force"]["result"] == "UNKNOWN"


# ---------------------------------------------------------------- exemptions
def test_a_text_read_in_full_with_no_carve_out_is_a_yes():
    v, c = _run(COMMENCE_ON_PUBLICATION, ("Duties", FILLER))
    assert c["Exemptions"]["result"] == "MATCH" and c["Exemptions"]["found"] == "none"
    assert "separate government notification" in c["Exemptions"]["detail"]


def test_a_carve_out_for_other_types_is_a_yes():
    v, c = _run(("Application", "These rules shall not apply to banks and insurers."), ("Duties", FILLER))
    assert c["Exemptions"]["result"] == "MATCH"
    assert "bank" in c["Exemptions"]["detail"]


def test_a_carve_out_naming_our_kind_goes_to_a_person_never_to_no():
    v, c = _run(("Application", "These rules shall not apply to hospitals owned by the Central Government."),
                ("Duties", FILLER))
    assert c["Exemptions"]["result"] == "UNKNOWN", "a private hospital was treated as exempt"
    assert "hospitals owned by the Central Government" in c["Exemptions"]["clauseText"]
    assert v["verdict"] == "CONDITIONAL"


def test_a_carve_out_naming_nobody_recognisable_goes_to_a_person():
    v, c = _run(("Application", "Nothing in these rules shall apply to cases pending on the appointed day."),
                ("Duties", FILLER))
    assert c["Exemptions"]["result"] == "UNKNOWN"


def test_no_text_means_not_checked_not_no_exemption():
    v, c = _run()
    assert c["Exemptions"]["result"] == "UNKNOWN" and c["Exemptions"]["expected"] == "not extracted"
    assert c["Thresholds"]["result"] == "UNKNOWN" and c["Thresholds"]["expected"] == "not extracted"
    assert set(v["strength"]["notChecked"]) == {"Exemptions", "Thresholds"}


def test_a_stub_is_not_a_text():
    v, c = _run(("Notice", "Rules notified. See the gazette."))
    assert c["Exemptions"]["expected"] == "not extracted"


# ---------------------------------------------------------------- thresholds
def test_a_size_condition_goes_to_a_person():
    v, c = _run(("Application", "These rules apply to every hospital having fifty or more beds."),
                ("Duties", FILLER))
    assert c["Thresholds"]["result"] == "UNKNOWN"
    assert "fifty or more beds" in c["Thresholds"]["clauseText"]


def test_a_fine_is_not_a_size_condition():
    v, c = _run(("Penalties", "Whoever contravenes these rules shall be punishable with fine not "
                              "exceeding Rs. 5 lakh rupees."), ("Duties", FILLER))
    assert c["Thresholds"]["result"] == "MATCH"


def test_employing_ten_or_more_is_a_condition():
    v, c = _run(("Application", "This Act applies to every establishment employing ten or more workers."),
                ("Duties", FILLER))
    assert c["Thresholds"]["result"] == "UNKNOWN"


# ---------------------------------------------------------------- the verdict
def test_a_regulation_read_in_full_can_finally_be_applicable():
    v, c = _run(COMMENCE_ON_PUBLICATION, ("Duties", FILLER))
    assert v["verdict"] == "APPLICABLE", v["why"]
    # entity 35 + jurisdiction 20 + in force 15 + thresholds 10 + exemptions 10 + sector 5
    assert v["strength"]["confirmed"] == 95
    assert v["confidence"] == "High"


def test_a_licence_only_match_is_never_an_unqualified_yes():
    facts = dict(HOSPITAL, licences=["Food licence (FSSAI)"])
    reg = dict(REG, regulator_short="FSSAI", sector="Food Safety",
               title="Food Safety and Standards (Food Recall Procedure) Regulations, 2017")
    rules = [{"entity_type": "food business operator", "role": "ADDRESSEE", "source_clause": "2",
              "applicability_rule": "Every food business operator shall have a recall plan."}]
    v, c = _run(COMMENCE_ON_PUBLICATION, ("Duties", FILLER), reg=reg, rules=rules, facts=facts)
    assert c["Exemptions"]["result"] == "MATCH" and c["Thresholds"]["result"] == "MATCH"
    assert v["verdict"] == "CONDITIONAL", "a kitchen licence made a hospital a food manufacturer"
    assert "entity type" in v["why"]


# ---------------------------------------------------------------- dates
def test_the_stored_issue_date_formats_can_be_read():
    for raw, want in (("Dec 30, 2025", "2025-12-30"), ("30-Dec-2025", "2025-12-30"),
                      ("3-Dec-2025", "2025-12-03"), ("30.12.2025", "2025-12-30"),
                      ("2025-12-30", "2025-12-30"), ("December 30, 2025", "2025-12-30")):
        assert str(A._parse_date(raw)) == want, raw
    assert A._parse_date("2025") is None, "a year alone is not a date"


def test_a_silent_text_with_a_stored_issue_date_is_in_force():
    v, c = _run(("Duties", FILLER), reg=dict(REG, issued_on="Dec 30, 2025"))
    assert c["In force"]["result"] == "MATCH" and c["In force"]["inferred"]


# ---------------------------------------------------------------- only our own type goes green
def test_a_sector_match_is_never_an_unqualified_yes():
    """The dry run turned Honey Grading Rules green through the Pharmacy sector."""
    facts = {"entityType": "Private company limited by shares", "jurisdictions": ["India"],
             "sectors": ["Pharmacy"], "licences": []}
    rules = [{"entity_type": "pharmacy", "role": "ADDRESSEE", "source_clause": "1",
              "applicability_rule": "These rules apply to every pharmacy."}]
    v, c = _run(COMMENCE_ON_PUBLICATION, ("Duties", FILLER), rules=rules, facts=facts)
    assert c["Entity type"]["result"] == "MATCH"
    assert v["verdict"] == "CONDITIONAL" and 'sector "Pharmacy"' in v["why"]


def test_an_employer_match_is_never_an_unqualified_yes():
    facts = {"entityType": "Private company limited by shares", "jurisdictions": ["India"],
             "sectors": [], "licences": [], "employees": 413}
    rules = [{"entity_type": "employer", "role": "ADDRESSEE", "source_clause": "1",
              "applicability_rule": "Every employer shall pay wages on time."}]
    v, c = _run(COMMENCE_ON_PUBLICATION, ("Duties", FILLER), rules=rules, facts=facts)
    assert v["verdict"] == "CONDITIONAL" and "employee count" in v["why"]
