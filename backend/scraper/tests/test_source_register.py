"""
A curated register must survive import with its judgements intact.

The compiler's own warning — that filing accreditation standards and scheme
conditions beside legislation is the most common structural error — is encoded
here as a test, so a later import cannot quietly flatten it.
"""
import json
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
EXTRACT = pathlib.Path(__file__).resolve().parent.parent / "data/registers/hospital_register.json"


# ---------------------------------------------------------------- hermetic
def test_extract_is_present_and_hashed():
    doc = json.loads(EXTRACT.read_text())
    assert len(doc["sha256"]) == 64, "the register extract must carry its source hash"
    assert doc["instruments"], "no instruments in the extract"
    assert doc["portals"], "no portal index in the extract"


def test_importer_never_marks_a_register_row_mapped():
    """A register names an instrument; it does not fetch a document."""
    src = (pathlib.Path(__file__).resolve().parent.parent / "import_source_register.py").read_text()
    assert "'MAPPED'" not in src and '"MAPPED"' not in src, \
        "a register entry must never be created as MAPPED"
    assert "DISCOVERED" in src


def test_status_flags_are_defined_not_invented():
    import import_source_register as I
    assert set(I.STATUS_LABEL) == {"V", "D", "?", "S"}
    assert "not legislation" in I.STATUS_LABEL["S"].lower()


# ---------------------------------------------------------------- live
@live
def test_register_rows_match_the_extract():
    doc = json.loads(EXTRACT.read_text())
    con = connect()
    n = con.execute("SELECT COUNT(*) FROM source_register WHERE register = ?",
                    (doc["register"],)).fetchone()[0]
    assert n == len(doc["instruments"]), \
        f"{n} rows in the database vs {len(doc['instruments'])} in the register"


@live
def test_import_is_idempotent():
    con = connect()
    dupes = con.execute(
        """SELECT COUNT(*) FROM (SELECT register, seq FROM source_register
             GROUP BY 1,2 HAVING COUNT(*) > 1) d""").fetchone()[0]
    assert dupes == 0, f"{dupes} duplicate register entries"


@live
def test_standards_are_not_filed_as_legislation():
    """The structural error the register itself warns against."""
    con = connect()
    bad = con.execute(
        """SELECT COUNT(*) FROM source_register sr
             JOIN regulations g ON g.id = sr.regulation_id
            WHERE sr.is_statute = FALSE
              AND g.regulation_type NOT ILIKE '%not legislation%'""").fetchone()[0]
    assert bad == 0, f"{bad} non-statutes are typed as legislation"


@live
def test_every_register_entry_keeps_its_provenance():
    con = connect()
    bad = con.execute(
        """SELECT COUNT(*) FROM source_register
            WHERE source_file IS NULL OR source_sha256 IS NULL OR portal IS NULL""").fetchone()[0]
    assert bad == 0, f"{bad} register rows lost their source file, hash or portal"


@live
def test_no_register_entry_invented_a_document_url():
    """
    Nothing may acquire a deep link it was not given — but "given" now includes
    one the crawler found and then verified by opening it.

    This used to assert that a DISCOVERED register entry carries no document
    URL at all, because at the time the only way a URL could appear on an
    unfetched row was invention. crawl_register_documents.py changed that: it
    follows the register's own portal hint, opens each candidate, checks the
    PDF magic bytes, reads the first pages and requires the instrument to be
    named in the text — then records a URL_RESOLVED source_check saying so.
    A verified-but-not-yet-ingested URL is a real state, and the old assertion
    called it a defect.

    So the guarantee is narrowed to what it was always about: a URL with no
    evidence behind it. DISCOVERED still means DISCOVERED — this says nothing
    about whether the document has been fetched.
    """
    con = connect()
    bad = con.execute(
        """SELECT COUNT(*) FROM source_register sr JOIN regulations g ON g.id = sr.regulation_id
            WHERE g.official_document_url IS NOT NULL AND g.official_document_url <> ''
              AND g.ingestion_status = 'DISCOVERED'
              AND NOT EXISTS (SELECT 1 FROM source_checks sc
                               WHERE sc.regulation_id = g.id AND sc.outcome = 'URL_RESOLVED')"""
    ).fetchone()[0]
    assert bad == 0, (
        f"{bad} unfetched register entries carry a document URL with no record of "
        "where it came from or that it was verified")


@live
def test_open_questions_survive_import():
    """Rows flagged '?' must keep their question, not be silently resolved."""
    con = connect()
    n = con.execute("SELECT COUNT(*) FROM source_register WHERE status = '?'").fetchone()[0]
    if n == 0:
        pytest.skip("this register has no open-question rows")
    without_note = con.execute(
        "SELECT COUNT(*) FROM source_register WHERE status='?' AND (notes IS NULL OR notes='')"
    ).fetchone()[0]
    assert without_note == 0, f"{without_note} open-question rows lost their note"
