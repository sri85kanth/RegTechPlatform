"""
The defect that read as a network hang for two days.

`document_frequency` ran one query per entity name:

    SELECT COUNT(DISTINCT regulation_id) FROM obligations
     WHERE lower(description) LIKE '%name%' OR lower(title) LIKE '%name%'

A leading wildcard cannot use an index, so each was a full sequential scan of
a 110 MB table — 14.6 s apiece on the deployment, times 1,143 company entities
= 4.6 hours. And load_brain() calls it once per ingested document.

These are hermetic: a fake connection stands in for Postgres, so the tests
assert the SHAPE of the access (one scan, all names) as well as the answer.
"""
import os

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

OBLIGATIONS = [
    ("reg-a", "KYC Policy review", "The KYC Policy shall be reviewed annually."),
    ("reg-a", "Board reporting", "A report shall be placed before the Board."),
    ("reg-b", "KYC Policy", "Every entity shall maintain a KYC Policy."),
    ("reg-c", "Waste handling", "Bio-medical waste shall be segregated at source."),
]


class _Cursor:
    def __init__(self, rows): self._rows = list(rows)
    def fetchmany(self, n=1000):
        out, self._rows = self._rows[:n], self._rows[n:]
        return out
    def fetchone(self): return self._rows[0] if self._rows else None


class FakeCon:
    """Counts how many times the obligations text is scanned."""
    def __init__(self, rows=OBLIGATIONS):
        self.rows, self.scans, self.queries = rows, 0, []

    def execute(self, sql, params=None):
        q = " ".join(sql.split())
        self.queries.append(q)
        if "FROM obligations" in q and "coalesce(title" in q:
            self.scans += 1
            return _Cursor([(rid, f"{t} {d}".lower()) for rid, t, d in self.rows])
        if "COUNT(*), COUNT(DISTINCT regulation_id) FROM obligations" in q:
            return _Cursor([(len(self.rows), len({r[0] for r in self.rows}))])
        return _Cursor([])


def test_counts_regulations_not_rows():
    """A name in two obligations of the same regulation counts once."""
    from regulatory_ingestion.precision import document_frequency
    df = document_frequency(FakeCon(), ["KYC Policy", "Board", "Bio-medical waste", "absent"])
    assert df["KYC Policy"] == 2       # reg-a and reg-b, not 3 rows
    assert df["Board"] == 1
    assert df["Bio-medical waste"] == 1
    assert df["absent"] == 0


def test_the_whole_corpus_is_scanned_once_not_once_per_name():
    """The actual fix. 1,143 names must not mean 1,143 scans."""
    from regulatory_ingestion.precision import document_frequency
    con = FakeCon()
    names = [f"name-{i}" for i in range(200)] + ["KYC Policy"]
    df = document_frequency(con, names)
    assert con.scans == 1, f"the obligations table was scanned {con.scans} times"
    assert df["KYC Policy"] == 2


def test_no_leading_wildcard_like_survives():
    """
    The shape that could not use an index. If this comes back, so does the
    4.6-hour ingest.
    """
    from regulatory_ingestion.precision import document_frequency
    con = FakeCon()
    document_frequency(con, ["KYC Policy"])
    assert not any("LIKE" in q.upper() for q in con.queries), con.queries


def test_empty_and_blank_names_are_ignored():
    from regulatory_ingestion.precision import document_frequency
    assert document_frequency(FakeCon(), []) == {}
    assert document_frequency(FakeCon(), ["", "   ", None]) == {}


def test_matching_is_case_insensitive():
    from regulatory_ingestion.precision import document_frequency
    df = document_frequency(FakeCon(), ["kyc policy", "BOARD"])
    assert df["kyc policy"] == 2
    assert df["BOARD"] == 1


def test_the_precision_gate_is_computed_once_per_corpus():
    """
    load_brain() runs per document. Recomputing a corpus-wide statistic for
    every document is what turned one slow scan into seven.
    """
    from regulatory_ingestion import matcher
    matcher._GENERIC_CACHE.clear()
    con = FakeCon()
    names = ["KYC Policy", "Board"]
    for _ in range(5):
        matcher._generic_names_cached(con, names)
    assert con.scans == 1, f"the gate was recomputed {con.scans} times for one corpus"


def test_ingesting_one_document_does_not_reopen_the_scan():
    """
    The flaw in the first version of this cache. Keying on the exact obligation
    count meant every ingested document moved the key, so the 14-minute scan
    ran again per document — exactly what the cache was added to prevent.
    """
    from regulatory_ingestion import matcher
    matcher._GENERIC_CACHE.clear()
    con = FakeCon()
    matcher._generic_names_cached(con, ["KYC Policy"])
    for i in range(400):                       # a document's worth of obligations
        con.rows = con.rows + [("reg-a", f"duty {i}", "text")]
        matcher._generic_names_cached(con, ["KYC Policy"])
    assert con.scans == 1, f"a small corpus change recomputed the gate {con.scans} times"


def test_the_gate_recomputes_when_the_corpus_moves_materially():
    """A cache that never invalidates would silently freeze the gate."""
    from regulatory_ingestion import matcher
    matcher._GENERIC_CACHE.clear()
    con = FakeCon()
    matcher._generic_names_cached(con, ["KYC Policy"])
    con.rows = con.rows + [(f"reg-{i}", "New duty", "A new obligation appears.")
                           for i in range(matcher._OBL_BUCKET + 1)]
    matcher._generic_names_cached(con, ["KYC Policy"])
    assert con.scans == 2, "the gate did not notice the corpus had grown materially"


# ------------------------------------------------- ambiguous compound retrieval
def test_a_blood_bank_query_demotes_a_financial_bank():
    """
    Measured failure: "what records must a blood bank keep and for how long"
    returned "The bank shall also maintain such registers" — a financial bank,
    out of 845 banking Acts. The embedding sees bank/records/maintain.
    """
    from regulatory_ingestion.rag import _demote_decoys
    out = [
        {"title": "Banking Regulation Act", "content": "The bank shall also maintain such registers"},
        {"title": "Blood Centre Rules", "content": "Every blood centre shall keep records of donors"},
    ]
    got = _demote_decoys(out, "what records must a blood bank keep and for how long")
    assert got[0]["title"] == "Blood Centre Rules", [r["title"] for r in got]


def test_an_infection_control_query_demotes_animal_welfare():
    """
    Measured failure: "hospital infection prevention and control committee
    duties" returned the Prevention of Cruelty to Animals Act.
    """
    from regulatory_ingestion.rag import _demote_decoys
    out = [
        {"title": "Prevention of Cruelty to Animals Act", "content": "prevention and control of cruelty"},
        {"title": "Hospital IPC Guidelines", "content": "the infection control committee shall meet"},
    ]
    got = _demote_decoys(out, "hospital infection prevention and control committee duties")
    assert got[0]["title"] == "Hospital IPC Guidelines", [r["title"] for r in got]


def test_a_decoy_is_demoted_never_dropped():
    """
    Recall must not fall. Returning nothing is a worse answer than returning
    something imperfect with its evidence attached.
    """
    from regulatory_ingestion.rag import _demote_decoys
    out = [{"title": "Banking Regulation Act", "content": "the bank shall maintain registers"}]
    got = _demote_decoys(out, "blood bank records")
    assert len(got) == 1, "the only candidate was dropped instead of demoted"


def test_an_unrelated_query_is_left_alone():
    """The guard fires only on a compound it knows; everything else is untouched."""
    from regulatory_ingestion.rag import _demote_decoys
    out = [{"title": "A", "content": "alpha"}, {"title": "B", "content": "beta"}]
    assert _demote_decoys(list(out), "capital adequacy ratio") == out


def test_the_reranker_order_survives_inside_each_group():
    """Stable sort: the guard fixes the split, not the ranking within it."""
    from regulatory_ingestion.rag import _demote_decoys
    out = [
        {"title": "blood A", "content": "blood centre records"},
        {"title": "blood B", "content": "blood bank register"},
        {"title": "bank C", "content": "the bank shall maintain"},
    ]
    got = _demote_decoys(out, "blood bank records")
    assert [r["title"] for r in got] == ["blood A", "blood B", "bank C"]

