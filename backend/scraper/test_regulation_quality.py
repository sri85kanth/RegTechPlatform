"""
Regulation-side guarantees: the legal chain must hold in the data, and the
report must keep telling the truth about where it does not.
"""
import os
import pathlib

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

try:
    from regulatory_ingestion.db import connect
    connect().execute("SELECT 1").fetchone()
    _DB = True
except Exception:
    _DB = False

live = pytest.mark.skipif(not _DB, reason="no database on this machine")


# ---------------------------------------------------------------- hermetic
def test_amendment_backfill_reads_the_database_not_static_json():
    """
    The defect that kept regulation_amendments empty: the backfill iterated
    `public/data/extracted/*.json`, a directory from a retired architecture.
    """
    src = (pathlib.Path(__file__).resolve().parent.parent / "backfill_amendments.py").read_text()
    assert "public" not in src and "extracted" not in src, \
        "the amendment backfill must not read the retired static-JSON export"
    assert "FROM sections" in src, "it must read section text from the database"


def test_quality_report_has_no_hardcoded_totals():
    """Rule: never hard-code coverage numbers."""
    from regulatory_ingestion import regulation_quality as Q
    src = (pathlib.Path(Q.__file__)).read_text()
    for literal in ("1408", "1759", "111343", "94574", "34746", "1542"):
        assert literal not in src, f"quality report contains the hard-coded total {literal}"


def test_declared_but_empty_tables_are_reported_not_hidden():
    from regulatory_ingestion import regulation_quality as Q
    assert {"chapters", "reporting_requirements", "record_requirements",
            "disclosures", "definition_usages"} <= set(Q.DECLARED_BUT_EMPTY)


# ---------------------------------------------------------------- live
@live
def test_amendments_are_persisted():
    """regulation_amendments was 0; it must not silently return to 0."""
    con = connect()
    n = con.execute("SELECT COUNT(*) FROM regulation_amendments").fetchone()[0]
    assert n > 0, "no amendments persisted — the backfill is not running in the chain"


@live
def test_amendments_carry_reference_and_date():
    """An amendment without its circular reference is not evidence of anything."""
    con = connect()
    bad = con.execute(
        """SELECT COUNT(*) FROM regulation_amendments
            WHERE reference IS NULL OR reference = '' OR amended_on IS NULL""").fetchone()[0]
    assert bad == 0, f"{bad} amendments lack a reference or a date"


@live
def test_amendment_backfill_is_idempotent():
    """The unique index that was declared in the schema but missing in the database."""
    con = connect()
    dupes = con.execute(
        """SELECT COUNT(*) FROM (SELECT regulation_id, section_number, reference, action
             FROM regulation_amendments GROUP BY 1,2,3,4 HAVING COUNT(*) > 1) d""").fetchone()[0]
    assert dupes == 0, f"{dupes} duplicate amendment rows — the unique index is missing"


@live
def test_every_amendment_belongs_to_a_real_regulation():
    con = connect()
    orphan = con.execute(
        """SELECT COUNT(*) FROM regulation_amendments a WHERE NOT EXISTS
           (SELECT 1 FROM regulations r WHERE r.id = a.regulation_id)""").fetchone()[0]
    assert orphan == 0, f"{orphan} amendments reference a regulation that does not exist"


@live
def test_no_orphan_structural_rows():
    """Sections, clauses and obligations must hang off rows that exist."""
    con = connect()
    from regulatory_ingestion.regulation_quality import report
    d = report(con)["defects"]
    for k in ("orphanSections", "orphanClauses", "orphanObligations", "orphanRequirements",
              "obligationsWithBrokenSectionRef", "clausesWithBrokenParent"):
        assert d[k] == 0, f"{k} = {d[k]}"


@live
def test_requirements_keep_full_legal_lineage():
    con = connect()
    from regulatory_ingestion.regulation_quality import report
    lin = report(con)["lineage"]
    assert lin["requirementsWithObligation"]["pct"] == 100.0
    assert lin["requirementsWithSourceClause"]["pct"] == 100.0
    assert lin["sectionsWithText"]["pct"] == 100.0
    assert lin["clausesWithText"]["pct"] == 100.0


@live
def test_ingestion_chain_runs_the_amendment_pass():
    chain = pathlib.Path(__file__).resolve().parent.parent / "run_backlog.sh"
    if not chain.exists():
        pytest.skip("chain script not present")
    text = chain.read_text()
    assert "backfill_amendments.py --apply" in text, "the chain never rebuilds amendments"
    assert text.index("backfill_amendments.py") > text.index("backfill_semantics.py"), \
        "amendments must run after the text they are parsed from exists"


@live
def test_quality_report_tracks_the_live_corpus():
    from regulatory_ingestion.regulation_quality import report
    con = connect()
    r = report(con)
    assert r["corpus"]["regulations"] == con.execute(
        "SELECT COUNT(*) FROM regulations").fetchone()[0]
    assert r["corpus"]["sections"] == con.execute(
        "SELECT COUNT(*) FROM sections").fetchone()[0]
