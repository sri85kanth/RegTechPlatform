"""The extractive answer can only quote — and it cites what it quotes."""
from regulatory_ingestion import answers as A


HITS = [
    {"content": "A monetary penalty of ₹10,000 per instance shall be imposed for detection of counterfeit notes. "
                "Branches shall report such detection to the issue office.",
     "regulation_id": "reg-x", "section_number": "3", "title": "Penalties", "source_id": "s1#0", "app_path": "/regulation/reg-x"},
    {"content": "The soiled note remittance schedule is unrelated text here.",
     "regulation_id": "reg-y", "section_number": "9", "title": "Other", "source_id": "s2#0", "app_path": None},
]


def test_best_sentences_quote_verbatim_with_citation():
    out = A._best_sentences("penalty for counterfeit notes", HITS, n=2)
    assert out and out[0]["regulation_id"] == "reg-x" and out[0]["section"] == "3"
    assert out[0]["text"] in HITS[0]["content"]                 # verbatim, never rewritten


def test_no_query_overlap_means_no_quote():
    assert A._best_sentences("zzz qqq vvv", HITS) == []


def test_answer_never_invents_without_hits(monkeypatch):
    monkeypatch.setattr(A.rag, "search", lambda *a, **k: [])
    out = A.answer("anything at all")
    assert out["mode"] == "no_evidence" and out["answer"] is None
