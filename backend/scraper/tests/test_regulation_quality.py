"""
Regulation-side guarantees: the legal chain must hold in the data, and the
report must keep telling the truth about where it does not.
"""
import os
import pathlib

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

# A database answering is NOT the same as the live corpus being present. This
# repository has a stale local replica: it connects, but the migrations and
# backfills that the assertions below depend on have only been applied on the
# deployment. Running them there produced 13 false failures.
#
# So the live layer is opt-in. run_tests.sh sets LIVE_DB_TESTS=1 on the host
# that owns the corpus; anywhere else these skip with a reason instead of
# failing for a condition the developer never created.
_OPT_IN = os.getenv("LIVE_DB_TESTS") == "1"
try:
    from regulatory_ingestion.db import connect
    connect().execute("SELECT 1").fetchone()
    _DB = True
except Exception:
    _DB = False

live = pytest.mark.skipif(
    not (_DB and _OPT_IN),
    reason="live-corpus tests: set LIVE_DB_TESTS=1 on the machine holding the corpus",
)


# ---------------------------------------------------------------- hermetic
def test_amendment_backfill_reads_the_database_not_static_json():
    """
    The defect that kept regulation_amendments empty: the backfill iterated
    `public/data/extracted/*.json`, a directory from a retired architecture.
    """
    import ast
    path = pathlib.Path(__file__).resolve().parent.parent / "backfill_amendments.py"
    tree = ast.parse(path.read_text())
    # The module docstring names the retired path on purpose, to explain the
    # defect. Only executable code is checked here.
    code = ast.unparse(ast.Module(
        body=[n for n in tree.body if not (isinstance(n, ast.Expr)
                                           and isinstance(n.value, ast.Constant))],
        type_ignores=[]))
    assert "public" not in code and ".glob(" not in code, \
        "the amendment backfill must not read the retired static-JSON export"
    assert "FROM sections" in code, "it must read section text from the database"


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


# ------------------------------------------- "Applies to us" on the library list
@live
def test_the_library_row_carries_the_company_verdict():
    """The list has to show applicability without the reader opening each row."""
    from regulatory_ingestion.api_regulations import list_regulations
    row = list_regulations(page=1, size=1)["items"][0]
    assert "applicability" in row


@live
def test_the_librarys_verdict_agrees_with_the_compliance_tables():
    """
    `regulations.applicability` is a materialised copy, so it can go stale — and
    it did: it held 13 CONDITIONAL from an old run while the engine's own tables
    said 17, and the library quietly filtered on the old numbers. Both come from
    applicability.evaluate(), so where both exist they must agree.
    """
    from regulatory_ingestion.db import connect
    disagreeing = connect().execute("""
        SELECT COUNT(*) FROM applicability_results ar
          JOIN regulations r ON r.id = ar.regulation_id
         WHERE r.applicability IS NOT NULL AND r.applicability <> ar.verdict""").fetchone()[0]
    assert disagreeing == 0, (
        f"{disagreeing} regulations show one verdict in the library and another in "
        "the compliance tables — run materialise_applicability.py --apply")


# ------------------------------- promoting a section-level obligation to a duty
def test_a_duty_with_an_owner_is_promotable():
    from extract_clauses import promotable
    assert promotable({
        "description": "The licensee shall upload a solvency certificate before the 10th of each month.",
        "responsible_entity": "The licensee"})


def test_a_duty_nobody_owes_is_not_promotable():
    """With no subject the sentence states how the world is, not what a party must do."""
    from extract_clauses import promotable
    assert not promotable({
        "description": "These rules shall come into force on the date of publication.",
        "responsible_entity": None})


def test_a_fee_table_is_never_a_requirement():
    """An OCR'd schedule carries a 'shall' somewhere; it is still a price list."""
    from extract_clauses import promotable
    assert not promotable({
        "description": "Rs. 75/- PER BLS VII. Imported Wine & Cider (B.I.O) Rs. 80/- PER BLS "
                       "VIII. Indian Made Wine 12/- per bottle of 750 mls/650 mls shall apply",
        "responsible_entity": "Re"})


def test_text_with_no_duty_word_is_not_promotable():
    from extract_clauses import promotable
    assert not promotable({
        "description": "Physio Tricuspid Annuloplasty Ring / Carpentier-Edwards, Chennai 600010.",
        "responsible_entity": "The applicant"})
