"""
Why a hospital matched nothing, pinned so it cannot come back.

Two hard-coded vocabularies decided applicability, and until 2026-09-10 every
entry in both was financial:

  * parsers.APPLICABILITY_VOCAB — what the extractor looks for in a
    regulation's text. No healthcare term, so a hospital regulation produced
    roughly one applicability rule per document.
  * applicability.ENTITY_SYNONYMS — how a rule's entity type is matched to the
    company. Also no healthcare family.

And the company side read only `entity_type`, which for a hospital is
"Private company limited by shares" — a corporate form, not a regulated-entity
type. It matched no family, so every verdict in the corpus fell through to
REVIEW_REQUIRED with "could not be matched to a known family".

These are hermetic: no database, no network.
"""
import os

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

HOSPITAL = {
    "entityType": "Private company limited by shares",
    "sectors": ["Healthcare & Hospitals", "Diagnostics & Laboratory", "Pharmacy", "Blood Bank"],
    "licences": ["Blood Centre Licence", "Drug Licence", "Pndt Registration"],
    "jurisdictions": ["India"],
}


def test_the_extractor_can_name_a_hospital():
    """A type absent from the vocabulary can never become an applicability rule."""
    from regulatory_ingestion.parsers import APPLICABILITY_VOCAB
    vocab = {v.lower() for v in APPLICABILITY_VOCAB}
    for term in ("hospitals", "clinical establishment", "blood banks", "pharmacies",
                 "occupier", "employers", "genetic clinics", "manufacturers"):
        assert term in vocab, f"the extractor has no word for {term!r}"
    # the financial vocabulary must survive the addition
    for term in ("nbfcs", "banks", "regulated entities"):
        assert term in vocab


def test_a_hospital_profile_now_resolves_to_families():
    """The exact profile that produced 1,542 REVIEW_REQUIRED verdicts."""
    from regulatory_ingestion.applicability import company_entity_families
    fams, origin = company_entity_families(HOSPITAL)
    assert "hospital" in fams
    assert "laboratory" in fams
    assert "pharmacy" in fams
    assert "blood centre" in fams
    # and each one must be able to say which field it came from
    for f in fams:
        assert origin[f].startswith(("sector", "licence", "entity type")), origin[f]


def test_entity_type_alone_would_still_have_matched_nothing():
    """Documents the actual defect: the corporate form carries no signal."""
    from regulatory_ingestion.applicability import _families
    assert _families("Private company limited by shares") == set()


def test_sectors_and_licences_are_read_not_just_entity_type():
    from regulatory_ingestion.applicability import company_entity_families
    only_sector, origin = company_entity_families(
        {"entityType": "Private company limited by shares", "sectors": ["Healthcare & Hospitals"]})
    assert only_sector == {"hospital"}
    assert origin["hospital"] == 'sector "Healthcare & Hospitals"'


def test_a_financial_company_is_unaffected():
    """The change must not reclassify anything that already worked."""
    from regulatory_ingestion.applicability import company_entity_families
    fams, _ = company_entity_families(
        {"entityType": "NBFC — Investment & Credit Company", "sectors": ["Lending"], "licences": []})
    assert "nbfc" in fams
    assert "hospital" not in fams


def test_a_hospital_is_not_a_bank():
    """The families must stay disjoint — a wider vocabulary is not a looser one."""
    from regulatory_ingestion.applicability import company_entity_families
    fams, _ = company_entity_families(HOSPITAL)
    assert not ({"bank", "nbfc", "insurer", "payment", "intermediary"} & fams)


def test_word_boundaries_still_hold():
    """
    Regression guard for the bug the boundary matching was introduced for: 're'
    is a substring of 'Asset REconstruction'. New terms must not reopen it —
    'importer' must not fire on 'important', 'factory' not on 'satisfactory'.
    """
    from regulatory_ingestion.applicability import _families
    assert "manufacturer" not in _families("this is an important consideration")
    assert "occupier" not in _families("a satisfactory outcome")
    assert "regulated entity" not in _families("Asset Reconstruction Companies")


def test_an_empty_profile_still_decides_nothing():
    from regulatory_ingestion.applicability import company_entity_families
    fams, origin = company_entity_families({})
    assert fams == set() and origin == {}


def test_a_blood_bank_is_not_a_bank():
    """
    The false positive that adding healthcare vocabulary created, and the
    reason boundary matching is not sufficient on its own: "bank" sits inside
    "blood bank" with clean word boundaries on both sides. A hospital holding a
    blood centre licence would have been handed every RBI banking regulation.
    """
    from regulatory_ingestion.applicability import _families
    assert _families("Blood Bank") == {"blood centre"}
    assert _families("blood centre licence") == {"blood centre"}
    # a real bank is still a bank
    assert "bank" in _families("Scheduled Commercial Banks")
    assert "bank" in _families("Payments Bank")


def test_longest_phrase_wins_generally():
    from regulatory_ingestion.applicability import _families
    # the specific reading beats the generic one it contains
    assert _families("genetic laboratory") == {"genetic clinic"}
    # but a plain laboratory is still a laboratory
    assert _families("pathology laboratory") == {"laboratory"}


def test_every_vocabulary_term_can_reach_a_verdict():
    """
    The invariant that caught a defect older than this change.

    evaluate() skips any rule whose entity_type resolves to no family
    ("if not fam: continue"). So a term the extractor looks for but the family
    map does not know produces a finding that can never affect an answer —
    silently. Eight financial terms were in that state from the start, among
    them "Housing Finance Companies" and "Asset Reconstruction Companies": an
    HFC would not have matched its own regulations.

    Every term the extractor searches for must therefore be a term the matcher
    understands. If you add one without the other, this fails.
    """
    from regulatory_ingestion.applicability import _families
    from regulatory_ingestion.parsers import APPLICABILITY_VOCAB
    orphans = [v for v in APPLICABILITY_VOCAB if not _families(v)]
    assert orphans == [], (
        f"{len(orphans)} vocabulary terms resolve to no entity family, so any rule "
        f"they produce is silently ignored by evaluate(): {orphans}")


# ------------------------------------------------- guidance documents
def _toc(n):
    """A table of contents, as a real one is extracted: dotted leaders, no text."""
    return [(str(i), f"Chapter {i} ......................................", "")
            for i in range(1, n + 1)]


def test_a_guidance_document_with_no_scope_clause_is_still_read():
    """
    hosp-061, the Hospital Infection Control Guidelines: 352 sections addressed
    to hospitals throughout, whose first twelve "sections" are the contents
    page. The targeted read found nothing and the document produced a single
    applicability rule — it looked as though it bound nobody.
    """
    from regulatory_ingestion.parsers import scan_addressees
    items = _toc(12) + [
        ("13", "Infection prevention programme",
         "Every hospital shall constitute an infection prevention and control committee.")]
    best = scan_addressees(items)
    assert "hospitals" in best or "hospital" in best
    found = best.get("hospital") or best.get("hospitals")
    assert found["role"].startswith("ADDRESSEE")


def test_the_fallback_only_fires_when_the_targeted_read_is_empty():
    """It must not be able to change a result the narrow read already produced."""
    from regulatory_ingestion.parsers import scan_addressees
    items = [("1", "Scope", "This Act applies to all clinical establishments.")] + \
            [("2", "Lending", "Loans granted by the bank to hospitals shall be reported.")]
    best = scan_addressees(items)
    # the scope clause answered it; the counterparty sentence must not promote
    assert best["clinical establishment"]["role"].startswith("ADDRESSEE")
    assert best.get("hospitals", {}).get("role", "COUNTERPARTY") != "ADDRESSEE_SCOPE"


def test_the_fallback_still_refuses_a_counterparty_mention():
    """Reading more text may not lower the standard."""
    from regulatory_ingestion.parsers import scan_addressees
    items = _toc(12) + [
        ("13", "Priority sector",
         "Loans granted by the bank to hospitals shall be classified under priority "
         "sector lending and reported by the bank.")]
    best = scan_addressees(items)
    for ent in ("hospital", "hospitals"):
        if ent in best:
            assert not best[ent]["role"].startswith("ADDRESSEE"), best[ent]


def test_the_scanner_has_one_implementation():
    """
    reclassify_applicability.py carried its own copy, so a change in the
    pipeline silently did not apply to the corpus-wide rescan.
    """
    import inspect

    import reclassify_applicability as R
    src = inspect.getsource(R)
    assert "scan_addressees(" in src
    assert "for ent in APPLICABILITY_VOCAB" not in src, "the duplicate scanner is back"


# ------------------------------------------------- the role must survive the write
def test_the_ingest_pipeline_persists_the_addressee_role():
    """
    The defect that made every ingested regulation undecidable.

    applicability.evaluate() counts a rule only when its role starts with
    ADDRESSEE — deliberately, so an unclassified rule is never trusted as a
    finding. The pipeline's INSERT omitted the column, so extract_applicability
    decided the role and the write threw it away. Nine hospital regulations were
    extracted correctly as hospitals/Applies and every one came back
    REVIEW_REQUIRED, because the field that made them count was dropped between
    deciding it and saving it.
    """
    import inspect

    from regulatory_ingestion import pipeline
    src = inspect.getsource(pipeline.process)
    insert = src[src.index("INSERT INTO applicability_rules"):]
    insert = insert[:insert.index('"""')]
    assert "role" in insert, "the addressee role is computed and then not stored"
    assert "evidence" in insert, "the sentence the role was decided from is not stored"


def test_extract_applicability_returns_a_role_for_every_rule():
    """A rule with no role is invisible to evaluate(), so none may lack one."""
    from regulatory_ingestion.parsers import extract_applicability
    rules = extract_applicability([
        {"no": "1", "title": "Application",
         "text": "These rules shall apply to all hospitals and clinical establishments."}])
    assert rules
    for r in rules:
        assert r.get("role"), f"rule for {r['entity_type']!r} carries no role"


def test_a_rule_with_no_role_cannot_produce_a_match():
    """The guard itself: an unclassified rule must not be counted."""
    from regulatory_ingestion.applicability import evaluate
    facts = dict(HOSPITAL)
    unclassified = [{"entity_type": "hospitals", "applicability": "Applies",
                     "applicability_rule": "applies to all hospitals",
                     "source_clause": "Section 1", "confidence": 0.9, "role": None}]
    out = evaluate(_RegionCon([]), {"jurisdiction": "India", "regulator_short": "MoHFW"}, unclassified, facts)
    entity = next(c for c in out["checks"] if c["name"] == "Entity type")
    assert entity["result"] != "Match", "an unclassified rule was treated as a finding"


# --------------------------------------------------------------------------
# A licence the company COLLECTED counts as much as one it typed in. Without
# this the 12 certificates a hospital ingested were invisible to the engine.
class _Rows:
    def __init__(self, rows): self._rows = rows
    def fetchone(self): return self._rows[0] if self._rows else None
    def fetchall(self): return self._rows


class _Con:
    """Just enough of a connection for company_facts: a profile and some records."""
    def __init__(self, profile, entities): self.profile, self.entities = profile, entities

    def execute(self, sql, params=None):
        if "company_profile" in sql:
            return _Rows([self.profile] if self.profile else [])
        if "company_entities" in sql:
            return _Rows(self.entities)
        raise AssertionError(sql)


_PROFILE = {"id": 1, "legal_name": "Premier Hospital", "entity_type": None, "legal_form": None,
            "jurisdictions": '["India", "Telangana"]', "sectors": '["Healthcare"]',
            "licences": None, "employees": None, "turnover_cr": None, "customers": None,
            "listed": 0, "handles_personal_data": 0, "hq_state": "Telangana"}
_RECORDS = [{"name": "Clinical establishment registration", "type": "License"},
            {"name": "Drug licence", "type": "License"},
            {"name": "PCPNDT registration", "type": "License"},
            {"name": "Biomedical waste authorisation", "type": "License"},
            {"name": "CT scanner", "type": "Equipment"},
            {"name": "Dr. A. Nurse", "type": "Employee"}]


def test_a_collected_licence_reaches_the_engine():
    from regulatory_ingestion import applicability as A
    facts = A.company_facts(_Con(_PROFILE, _RECORDS))
    assert facts["licences"] == ["Clinical establishment registration", "Drug licence",
                                 "PCPNDT registration", "Biomedical waste authorisation"]
    fams, origin = A.company_entity_families(facts)
    assert {"hospital", "pharmacy", "genetic clinic", "waste generator"} <= fams
    assert "licence" in origin["pharmacy"], "the verdict must be able to cite the licence"


def test_equipment_and_people_are_not_licences():
    from regulatory_ingestion import applicability as A
    facts = A.company_facts(_Con(_PROFILE, _RECORDS))
    assert not any("scanner" in l.lower() or "nurse" in l.lower() for l in facts["licences"])


def test_a_typed_licence_and_a_collected_one_are_one_list():
    from regulatory_ingestion import applicability as A
    prof = dict(_PROFILE, licences='["Drug Licence", "Blood Centre Licence"]')
    facts = A.company_facts(_Con(prof, _RECORDS))
    assert facts["licences"][:2] == ["Drug Licence", "Blood Centre Licence"], "typed first"
    assert sum(1 for l in facts["licences"] if l.lower().startswith("drug")) == 1, "no duplicate"
    assert "Clinical establishment registration" in facts["licences"]


def test_a_database_without_records_still_yields_facts():
    from regulatory_ingestion import applicability as A
    facts = A.company_facts(_Con(_PROFILE, []))
    assert facts["licences"] == [] and facts["hqState"] == "Telangana"


# --------------------------------------------------------------------------
# Labour law addresses "every employer". Nothing on a hospital's profile uses
# that word, so the Code on Wages was reported NOT_APPLICABLE to a hospital
# with 413 employees on file.
def test_a_company_with_staff_is_an_employer():
    from regulatory_ingestion import applicability as A
    fams, origin = A.company_entity_families({"entityType": "Hospital", "employees": 413})
    assert "employer" in fams and "hospital" in fams
    assert "413" in origin["employer"], "the verdict must cite the count it rests on"


def test_no_staff_no_employer_family():
    from regulatory_ingestion import applicability as A
    for n in (None, "", 0, "0", "not known"):
        fams, _ = A.company_entity_families({"entityType": "Hospital", "employees": n})
        assert "employer" not in fams, n


def test_the_count_is_read_however_it_is_written():
    from regulatory_ingestion import applicability as A
    for n in (413, "413", " 413 ", "1,250", 7.0):
        fams, _ = A.company_entity_families({"employees": n})
        assert "employer" in fams, n


def test_the_verdict_reads_as_english():
    from regulatory_ingestion.applicability import _article
    assert [_article(w) for w in ("employer", "occupier", "hospital", "pharmacy")] == ["an", "an", "a", "a"]


# --------------------------------------------------------------------------
# Half of everything reported as reaching this hospital was a draft, and most of
# the rest was another state's rules. Both are now gates, both are pinned here.
class _RegionCon:
    """Answers only the regulation_regions query evaluate() makes."""
    def __init__(self, rows): self.rows = rows
    def execute(self, sql, params=None):
        if "applicability_rules" in sql and "thresholds" in sql:
            return _Rows([])        # no extracted size/turnover conditions
        assert "regulation_regions" in sql, sql
        return self
    def fetchall(self): return self.rows


_FACTS = {"entityType": "Hospital", "jurisdictions": ["India", "Telangana"],
          "hqState": "Telangana", "employees": 413, "licences": [], "sectors": []}
_RULES = [{"entity_type": "hospital", "role": "ADDRESSEE", "source_clause": "3",
           "applicability_rule": "These rules apply to every hospital."}]
_REG = {"id": "r1", "title": "The Clinical Establishments Act, 2010", "jurisdiction": "India",
        "issued_on": "2012-03-01", "regulator_short": "MoHFW", "sector": "Healthcare"}


def _verdict(reg, regions):
    from regulatory_ingestion import applicability as A
    v = A.evaluate(_RegionCon(regions), reg, _RULES, _FACTS)
    return v["verdict"], {c["name"]: c["result"] for c in v["checks"]}, v


def test_a_notified_instrument_that_names_us_reaches_us():
    verdict, results, _ = _verdict(_REG, [("India", "ALL_INDIA")])
    assert verdict == "CONDITIONAL", verdict
    assert results["In force"] == "MATCH" and results["Jurisdiction"] == "MATCH"


def test_a_draft_creates_no_duty():
    for title in ("Draft Telangana Occupational Safety Rules, 2026",
                  "The Income-Tax Bill, 2025",
                  "SEBI Consultation Paper on Disclosures",
                  "Proposed Amendment to the Factories Rules"):
        verdict, results, v = _verdict(dict(_REG, title=title), [("India", "ALL_INDIA")])
        assert verdict == "NOT_APPLICABLE", (title, verdict)
        assert results["In force"] == "NO_MATCH"
        assert "notified" in v["why"], v["why"]


def test_another_states_rules_do_not_apply_here():
    verdict, results, v = _verdict(dict(_REG, title="Rajasthan Occupational Safety Rules, 2023"),
                                   [("Rajasthan", "STATE_SPECIFIC")])
    assert verdict == "NOT_APPLICABLE" and results["Jurisdiction"] == "NO_MATCH"
    assert "Rajasthan" in v["checks"][1]["detail"] and "telangana" in v["checks"][1]["detail"].lower()


def test_our_own_states_rules_do_apply():
    verdict, results, _ = _verdict(dict(_REG, title="Telangana Clinical Establishments Rules"),
                                   [("Telangana", "STATE_SPECIFIC")])
    assert verdict == "CONDITIONAL" and results["Jurisdiction"] == "MATCH"


def test_an_all_india_instrument_is_never_excluded_by_state():
    """A central Act often lists states it was extended to; that is not a carve-out."""
    verdict, _, _ = _verdict(_REG, [("Rajasthan", "STATE_SPECIFIC"), ("India", "ALL_INDIA")])
    assert verdict == "CONDITIONAL", verdict


def test_the_word_draft_inside_a_title_is_not_a_draft():
    """'Drafting' and 'Bill of Lading' are not draft instruments."""
    from regulatory_ingestion.applicability import _DRAFT_TITLE
    for t in ("Guidelines on Drafting of Contracts", "Bill of Lading Rules, 1856",
              "The Redrafted Companies Act"):
        assert not _DRAFT_TITLE.search(t), t


# --------------------------------------------------------------------------
# Eight of the twelve licences this hospital holds resolved to no family at all,
# so the instruments that govern them could never reach it.
def test_each_licence_the_hospital_holds_resolves_to_a_family():
    from regulatory_ingestion.applicability import _families
    expected = {
        "Clinical establishment registration": "hospital",
        "Drug licence": "pharmacy",
        "PCPNDT registration": "genetic clinic",
        "Biomedical waste authorisation": "waste generator",
        "Food licence (FSSAI)": "food business operator",
        "MTP licence": "approved place",
        "Labour licence": "principal employer",
        "Fire NOC": "building occupier",
    }
    for licence, family in expected.items():
        assert family in _families(licence), f"{licence} should establish {family}"


def test_a_pan_card_is_not_a_regulated_entity_type():
    """A tax identifier is not a licence to do anything; mapping it would hand a
    hospital the whole Income-tax corpus."""
    from regulatory_ingestion.applicability import _families
    for not_a_licence in ("PAN card", "GST registration", "TANA KOKAPET"):
        assert not _families(not_a_licence), not_a_licence


def test_holding_personal_data_makes_us_a_data_fiduciary():
    """The DPDP Act addresses data fiduciaries; nothing else on the profile says so."""
    from regulatory_ingestion import applicability as A
    fams, origin = A.company_entity_families({"entityType": "Hospital", "handlesPersonalData": True})
    assert "data fiduciary" in fams
    assert "personal data" in origin["data fiduciary"]
    fams2, _ = A.company_entity_families({"entityType": "Hospital", "handlesPersonalData": False})
    assert "data fiduciary" not in fams2


def test_the_extractor_now_looks_for_these_parties():
    """A family is inert unless the extractor can find the party in a regulation."""
    from regulatory_ingestion.parsers import APPLICABILITY_VOCAB
    lowered = {v.lower() for v in APPLICABILITY_VOCAB}
    for term in ("data fiduciaries", "food business operators", "approved places",
                 "principal employers", "contractors"):
        assert term in lowered, term


def test_a_blood_bank_is_still_not_a_bank():
    """The longest-phrase rule must survive the new entries."""
    from regulatory_ingestion.applicability import _families
    assert _families("Blood Bank Licence") == {"blood centre"}


def test_a_principal_employer_is_not_a_contractor():
    """Both appear in the Contract Labour Act, with different duties. A hospital
    that engages contract labour is the principal employer, never the contractor."""
    from regulatory_ingestion.applicability import _families
    assert _families("Labour licence") == {"principal employer"}
    assert _families("contractors") == {"contractor"}
    assert "contractor" not in _families("principal employer")


def test_a_fire_noc_does_not_make_a_hospital_a_factory():
    """"Occupier" in this corpus is the occupier of a factory or an electrical
    installation. A fire NOC says we occupy a building, nothing more."""
    from regulatory_ingestion.applicability import _families
    assert _families("Fire NOC") == {"building occupier"}
    assert _families("occupier") == {"occupier"}
    assert _families("factories") == {"occupier"}
    assert "occupier" not in _families("Fire NOC")
