"""
Mining a folder against a context must produce records you can argue with.

Every test here is a way an extractor quietly lies: a run-on line swallowed into
a name, "N/A" recorded as a person, a sentence captured as a value, two files
disagreeing and one silently winning, a relationship pointing at a node that was
never created. Each of those produces a Company Brain that looks populated and
is not, which is worse than an empty one.
"""
import os
import pathlib

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

from regulatory_ingestion import content_extract as C  # noqa: E402


def find(records, kind, name=None):
    out = [r for r in records if r.kind == kind]
    if name is not None:
        out = [r for r in out if C.norm_name(r.name) == C.norm_name(name)]
    return out


# ------------------------------------------------------------ labelled lines
def test_a_labelled_owner_becomes_a_person_and_an_attribute():
    text = "Biomedical Equipment Maintenance Policy\nDocument Owner: Priya Sharma\nVersion: 2.1\n"
    recs, edges = C.from_text(text, "bio/maintenance-policy.docx", context="Biomedical Department")
    doc = find(recs, "document")[0]
    assert doc.attrs["owner"] == "Priya Sharma"
    assert doc.attrs["version"] == "2.1"
    assert find(recs, "person", "Priya Sharma")
    assert any(e.kind == "owner_by" and C.norm_name(e.target) == "priya sharma" for e in edges)


def test_every_record_carries_the_phrase_that_produced_it():
    text = "Vendor: Siemens Healthineers\n"
    recs, _ = C.from_text(text, "amc.docx")
    v = find(recs, "vendor", "Siemens Healthineers")[0]
    assert v.evidence and "Vendor: Siemens Healthineers" in v.evidence[0].phrase
    assert v.evidence[0].file == "amc.docx"


def test_several_people_on_one_line_are_several_people():
    text = "Reviewed by: Priya Sharma, Rahul Menon and A. Khan\n"
    recs, _ = C.from_text(text, "sop.docx")
    got = {C.norm_name(r.name) for r in find(recs, "person")}
    assert got == {"priya sharma", "rahul menon", "a khan"}


def test_a_run_on_line_does_not_swallow_the_next_label():
    text = "Owner: Priya Sharma    Version: 2.1\n"
    recs, _ = C.from_text(text, "p.docx")
    names = [r.name for r in find(recs, "person")]
    assert names == ["Priya Sharma"], names


def test_placeholder_values_are_not_records():
    for junk in ("N/A", "TBD", "-", "Not applicable", "nil"):
        recs, _ = C.from_text(f"Owner: {junk}\n", "p.docx")
        assert not find(recs, "person"), junk


def test_a_sentence_is_not_a_value():
    """"Owner: the department head shall ensure…" is a clause, not a name."""
    text = "Owner: the department head shall ensure that records are retained\n"
    recs, _ = C.from_text(text, "p.docx")
    assert not find(recs, "person")


def test_an_unknown_label_is_ignored_rather_than_guessed():
    recs, _ = C.from_text("Favourite Colour: Blue\n", "p.docx")
    doc = find(recs, "document")[0]
    assert "Blue" not in str(doc.attrs.values())


# --------------------------------------------------------------- the document
def test_the_document_itself_is_always_a_record():
    recs, _ = C.from_text("Some prose with no labels at all.", "bio/Calibration SOP.pdf")
    docs = find(recs, "document")
    assert len(docs) == 1
    assert docs[0].name == "Calibration SOP"


def test_the_document_type_comes_from_what_it_says_it_is():
    recs, _ = C.from_text("x", "Information Security Policy.docx")
    assert find(recs, "document")[0].attrs["documentType"] == "Policy"
    recs, _ = C.from_text("x", "Calibration SOP.docx")
    assert find(recs, "document")[0].attrs["documentType"] == "Procedure"


def test_a_document_that_does_not_say_is_unclassified_not_guessed():
    recs, _ = C.from_text("plain text", "scan0001.pdf")
    assert find(recs, "document")[0].attrs["documentType"] == "Unclassified"


def test_the_context_is_carried_on_every_record():
    text = "Owner: Priya Sharma\nVendor: Siemens\n"
    recs, _ = C.from_text(text, "f.docx", context="Biomedical Department")
    assert all(r.attrs.get("collectionContext") == "Biomedical Department" for r in recs)


# ------------------------------------------------------------- relationships
def test_a_cross_reference_becomes_an_edge_with_its_sentence():
    text = "Calibration is carried out in accordance with the Biomedical Equipment Policy at all sites."
    _, edges = C.from_text(text, "sop.docx")
    refs = [e for e in edges if e.kind == "references"]
    assert refs and C.norm_name(refs[0].target) == "biomedical equipment policy"
    assert "in accordance with" in refs[0].evidence.phrase


def test_a_reference_to_itself_is_not_an_edge():
    text = "This document, as per the Biomedical Equipment Policy, applies everywhere."
    _, edges = C.from_text(text, "Biomedical Equipment Policy.docx")
    assert not [e for e in edges if e.kind == "references"]


def test_an_edge_to_something_never_created_is_dropped():
    """A relationship to a node that does not exist is how a graph fills with
    nodes nobody can explain."""
    result = {"context": "", "records": [
        C.Record(kind="document", name="Calibration SOP", evidence=[C.Evidence("a.docx", "x")])],
        "edges": [C.Edge(source="Calibration SOP", kind="references",
                         target="A Policy That Was Never Collected",
                         evidence=C.Evidence("a.docx", "as per …"))]}
    ents = C.to_entities(result, "integration:folder")
    assert C.to_relationships(result, ents) == []


# --------------------------------------------------------------- aggregation
def test_the_same_person_in_two_files_is_one_record_with_both_evidences():
    recs = []
    for f in ("a.docx", "b.docx"):
        r, _ = C.from_text("Owner: Priya Sharma\n", f)
        recs.extend(r)
    agg = C.aggregate(recs)
    people = find(agg, "person", "Priya Sharma")
    assert len(people) == 1
    assert {e.file for e in people[0].evidence} == {"a.docx", "b.docx"}


def test_corroboration_across_files_raises_confidence():
    one = C.aggregate(C.from_text("Vendor: Siemens\n", "a.docx")[0])
    two = C.aggregate(C.from_text("Vendor: Siemens\n", "a.docx")[0]
                      + C.from_text("Vendor: Siemens\n", "b.docx")[0])
    assert find(two, "vendor")[0].confidence > find(one, "vendor")[0].confidence


def test_a_vendor_and_a_person_with_the_same_name_stay_separate():
    recs = C.from_text("Owner: Apollo\n", "a.docx")[0] + C.from_text("Vendor: Apollo\n", "b.docx")[0]
    agg = C.aggregate(recs)
    assert len(find(agg, "person", "Apollo")) == 1
    assert len(find(agg, "vendor", "Apollo")) == 1


def test_two_files_that_disagree_keep_both_answers():
    """One file silently winning is the failure mode; a contradiction is a fact
    about the corpus and the reviewer needs to see it."""
    recs = (C.from_text("Owner: Priya Sharma\nVersion: 2.1\n", "Biomedical Policy.docx")[0]
            + C.from_text("Owner: Priya Sharma\nVersion: 3.0\n", "Biomedical Policy.docx")[0])
    agg = C.aggregate(recs)
    doc = find(agg, "document", "Biomedical Policy")[0]
    assert doc.attrs["version"] == "2.1"                       # first stated wins the slot
    assert doc.attrs["version__alternatives"] == ["3.0"]       # and the other is not lost


def test_a_file_whose_name_is_too_short_still_produces_a_record():
    recs, _ = C.from_text("Owner: Priya Sharma\n", "a.docx")
    assert find(C.aggregate(recs), "document", "a.docx")


def test_an_unnamed_record_is_dropped():
    assert C.aggregate([C.Record(kind="person", name="  ")]) == []


# ------------------------------------------------------- Company Brain shape
def test_unknown_attributes_survive_into_attrs():
    text = "Retention: 5 years after disposal\nClassification: Confidential\nContract: AMC/2026/17\n"
    recs, _ = C.from_text(text, "amc.docx")
    ents = C.to_entities({"context": "Biomedical", "records": C.aggregate(recs), "edges": []},
                         "integration:folder")
    doc = [e for e in ents if e["type"] != "Person"][0]
    assert doc["attrs"]["retention"] == "5 years after disposal"
    assert doc["attrs"]["classification"] == "Confidential"
    assert doc["attrs"]["contract"] == "AMC/2026/17"


def test_a_mined_record_is_discovered_and_pending_not_verified():
    recs, _ = C.from_text("Owner: Priya Sharma\n", "a.docx")
    ents = C.to_entities({"context": "", "records": C.aggregate(recs), "edges": []}, "integration:folder")
    assert all(e["lifecycle"] == "Discovered" for e in ents)
    assert all(e["verification"] == "Pending" for e in ents)


def test_the_entity_keeps_its_evidence():
    recs, _ = C.from_text("Vendor: Siemens Healthineers\n", "bio/amc.docx")
    ents = C.to_entities({"context": "", "records": C.aggregate(recs), "edges": []}, "integration:folder")
    vendor = [e for e in ents if e["type"] == "Vendor"][0]
    assert vendor["attrs"]["evidence"][0]["file"] == "bio/amc.docx"
    assert vendor["provenance"]["sourceReference"] == "bio/amc.docx"


def test_the_domain_follows_from_the_record_not_from_a_dropdown():
    recs = (C.from_text("Owner: Priya Sharma\n", "a.docx")[0]
            + C.from_text("x", "Risk Register.xlsx")[0]
            + C.from_text("x", "Access Control Policy.docx")[0])
    ents = C.to_entities({"context": "", "records": C.aggregate(recs), "edges": []}, "integration:folder")
    domains = {e["name"]: e["domain"] for e in ents}
    assert domains["Priya Sharma"] == "people"
    assert domains["Access Control Policy"] == "policies"


# --------------------------------------------------------------- whole folder
def test_analyse_reports_the_files_it_could_not_read(tmp_path):
    (tmp_path / "policy.txt").write_text("Owner: Priya Sharma\nVersion: 1.0\n")
    (tmp_path / "photo.jpg").write_bytes(b"\xff\xd8\xff\xe0notanimage")
    out = C.analyse(tmp_path, context="Biomedical Department")
    assert out["files_read"] == 1
    assert out["files_unreadable"] == 1
    unread = [f for f in out["files"] if not f["read"]][0]
    assert unread["file"] == "photo.jpg" and unread["reason"]


def test_analyse_aggregates_across_the_folder(tmp_path):
    (tmp_path / "a.txt").write_text("Owner: Priya Sharma\nVendor: Siemens\n")
    (tmp_path / "b.txt").write_text("Owner: Priya Sharma\nVendor: GE Healthcare\n")
    out = C.analyse(tmp_path, context="Biomedical Department")
    assert out["by_kind"]["person"] == 1          # one person, seen twice
    assert out["by_kind"]["vendor"] == 2
    assert out["context"] == "Biomedical Department"


# --------------------------------------------------------------- typing bugs
# Found by running the extractor over a realistic biomedical folder rather than
# over fixtures written to match the code.
def test_a_contract_that_mentions_a_policy_is_still_a_contract():
    """The body said "…under the Biomedical Equipment Maintenance Policy" and
    the document was typed Policy. What a document calls ITSELF beats what it
    mentions, and the body is not the title."""
    text = ("ANNUAL MAINTENANCE CONTRACT\nVendor: Siemens Healthineers\n"
            "Covers all imaging equipment under the Biomedical Equipment Maintenance Policy.\n")
    recs, _ = C.from_text(text, "contracts/AMC Siemens 2026.txt")
    assert find(recs, "document")[0].attrs["documentType"] == "Agreement"


def test_the_name_beats_the_body():
    text = "This procedure is performed as required by the Equipment Maintenance Policy.\n"
    recs, _ = C.from_text(text, "Calibration Procedure.txt")
    doc = find(recs, "document")[0]
    assert doc.attrs["documentType"] == "Procedure"
    assert doc.confidence == 85                      # stated in its own title


def test_a_type_found_only_in_the_body_is_held_less_confidently():
    recs, _ = C.from_text("ANNUAL MAINTENANCE CONTRACT\nparties agree…", "AMC-2026-017.txt")
    doc = find(recs, "document")[0]
    assert doc.attrs["documentType"] == "Agreement"
    assert doc.confidence == 60


def test_a_vendor_does_not_overwrite_the_documents_own_name():
    """The vendor label wrote attrs["name"], which reads as the record's name."""
    recs, _ = C.from_text("Vendor: Siemens Healthineers\n", "AMC Siemens.txt")
    doc = find(recs, "document")[0]
    assert doc.name == "AMC Siemens"
    assert doc.attrs["vendor"] == "Siemens Healthineers"
    assert "name" not in doc.attrs
