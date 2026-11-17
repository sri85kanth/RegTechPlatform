"""
The source watcher must be able to reach what it watches, check what the company
follows first, and never lose the first change to a missing baseline.

Hermetic: an in-memory SQLite database and a stubbed download, so this runs with
no Postgres and no network. The extraction step is stubbed too — it is the same
call for every copy, and what is under test is what the watcher does around it.
"""
import hashlib
import pathlib
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from regulatory_ingestion import source_urls, versions as V, watcher as W  # noqa: E402

STORE = "https://trplprodcompliance.blob.core.windows.net/actfiles/legalupdatedocs/53159/NCDEX-circular-February272026.pdf"
PROXY = "https://teamleaseregtech.com/filepdfproxy/?f=legalupdatedocs%2F53159%2FNCDEX-circular-February272026.pdf"


# ---------------------------------------------------------------- where to fetch
def test_teamlease_store_is_fetched_through_its_proxy():
    assert source_urls.fetchable(STORE) == PROXY
    assert source_urls.moved(STORE)


def test_spaces_are_encoded_once_whether_stored_raw_or_encoded():
    raw = "https://trplprodcompliance.blob.core.windows.net/actfiles/legalupdatedocs/7/My file.pdf"
    enc = "https://trplprodcompliance.blob.core.windows.net/actfiles/legalupdatedocs/7/My%20file.pdf"
    want = "https://teamleaseregtech.com/filepdfproxy/?f=legalupdatedocs%2F7%2FMy%20file.pdf"
    assert source_urls.fetchable(raw) == want
    assert source_urls.fetchable(enc) == want


@pytest.mark.parametrize("url", [
    "https://rbidocs.rbi.org.in/rdocs/notification/PDFs/181MD.PDF",
    "https://teamleaseregtech.com/updates/article/53159/x/",
    "https://trplprodcompliance.blob.core.windows.net/other/path.pdf",   # not the act-files layout
    "",
    None,
])
def test_everything_else_is_fetched_as_stored(url):
    assert source_urls.fetchable(url) == url
    assert not source_urls.moved(url)


# ---------------------------------------------------------------- a tiny database
@pytest.fixture
def con(tmp_path, monkeypatch):
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript("""
        CREATE TABLE regulations (id TEXT PRIMARY KEY, applicability TEXT, sector TEXT);
        CREATE TABLE documents (regulation_id TEXT PRIMARY KEY, source_url TEXT, document_hash TEXT, storage_path TEXT);
    """)
    W.init(c)
    # a changed copy is written to disk; keep it out of the repository
    monkeypatch.setattr(W, "DOCS", tmp_path)
    return c


def _reg(con, rid, applicability="NOT_APPLICABLE", sector="Banking", url="https://example.gov.in/a.pdf", h=None):
    con.execute("INSERT INTO regulations VALUES (?,?,?)", (rid, applicability, sector))
    con.execute("INSERT INTO documents VALUES (?,?,?,?)", (rid, url, h, None))


def _checked(con, rid, days_ago):
    at = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat(timespec="seconds")
    con.execute("INSERT INTO source_checks (regulation_id, checked_at, outcome) VALUES (?,?,?)", (rid, at, "UNCHANGED"))


# ---------------------------------------------------------------- what to check first
def test_what_applies_is_checked_first_and_the_rest_still_gets_a_share(con):
    for i in range(10):
        _reg(con, f"bank-{i}")                                   # everything else, never checked
    for i in range(3):
        _reg(con, f"applies-{i}", applicability="CONDITIONAL")    # applies, never checked
    _reg(con, "applies-old", applicability="APPLICABLE"); _checked(con, "applies-old", 3)
    _reg(con, "applies-fresh", applicability="APPLICABLE"); _checked(con, "applies-fresh", 0)
    _reg(con, "health-0", sector="Healthcare & Hospitals")

    picked = W.due(con, max_age_hours=24, limit=6)

    assert len(picked) == 6
    # four of six go to the company's own documents: applies first, never-checked before old
    assert picked[:3] == sorted(picked[:3]) and all(p.startswith("applies-") for p in picked[:3])
    assert picked[3] == "applies-old"
    # the rest of the pass still reaches everything else
    assert all(p.startswith("bank-") for p in picked[4:])
    # checked within the last day: not due
    assert "applies-fresh" not in picked


def test_own_documents_fill_the_pass_when_nothing_else_is_due(con):
    for i in range(5):
        _reg(con, f"applies-{i}", applicability="APPLICABLE")
    picked = W.due(con, limit=4)
    # a priority share of 3, then the other slot, with nothing else due, goes to them too
    assert len(picked) == 4 and len(set(picked)) == 4 and all(p.startswith("applies-") for p in picked)


# ---------------------------------------------------------------- one check
class _Resp:
    def __init__(self, content):
        self.status_code, self.content, self.headers = 200, content, {}


SECTIONS_V1 = [{"no": "1", "title": "Scope", "text": "These rules apply to every hospital licensed in the State."},
               {"no": "2", "title": "Records", "text": "Records shall be kept for five years."}]
SECTIONS_V2 = [{"no": "1", "title": "Scope", "text": "These rules apply to every hospital licensed in the State."},
               {"no": "2", "title": "Records", "text": "Records shall be kept for ten years and produced on demand."}]


def test_teamlease_document_is_fetched_through_the_proxy_and_saved_as_a_baseline(con, monkeypatch):
    pdf = b"%PDF-1.7 v1"
    _reg(con, "tl-1", applicability="CONDITIONAL", url=STORE, h=hashlib.sha256(pdf).hexdigest())
    asked = []
    monkeypatch.setattr(W.requests, "get", lambda url, **kw: asked.append(url) or _Resp(pdf))
    monkeypatch.setattr(W, "_sections_of", lambda content, allow_ocr: (SECTIONS_V1, ""))

    res = W.check(con, "tl-1")

    assert asked == [PROXY]
    assert res["outcome"] == "UNCHANGED"
    assert "first comparable version" in res["detail"] and "TeamLease" in res["detail"]
    vs = V.versions(con, "tl-1")
    assert len(vs) == 1 and vs[0]["source_url"] == PROXY
    # the check is recorded against the stored URL, which is left as it was
    assert con.execute("SELECT source_url FROM source_checks WHERE regulation_id='tl-1'").fetchone()[0] == STORE
    assert con.execute("SELECT source_url FROM documents WHERE regulation_id='tl-1'").fetchone()[0] == STORE

    # checked again, still unchanged: no second, identical version
    W.check(con, "tl-1")
    assert len(V.versions(con, "tl-1")) == 1


def test_a_change_after_an_unchanged_check_is_detected_not_lost(con, monkeypatch):
    v1, v2 = b"%PDF-1.7 v1", b"%PDF-1.7 v2"
    _reg(con, "reg-1", applicability="APPLICABLE", h=hashlib.sha256(v1).hexdigest())
    serving = {"pdf": v1, "sections": SECTIONS_V1}
    monkeypatch.setattr(W.requests, "get", lambda url, **kw: _Resp(serving["pdf"]))
    monkeypatch.setattr(W, "_sections_of", lambda content, allow_ocr: (serving["sections"], ""))

    assert W.check(con, "reg-1")["outcome"] == "UNCHANGED"     # baseline saved here
    serving.update(pdf=v2, sections=SECTIONS_V2)                 # the regulator rewords clause 2
    res = W.check(con, "reg-1")

    # before the fix this was BASELINE_CAPTURED: the first real change, recorded as no change
    assert res["outcome"] == "CHANGED"
    rows = con.execute("SELECT section_number, change_class FROM section_changes WHERE regulation_id='reg-1'").fetchall()
    assert [(r[0], r[1]) for r in rows] == [("2", "WORDING")]


def test_an_unreadable_copy_saves_no_baseline(con, monkeypatch):
    pdf = b"%PDF-1.7 scan"
    _reg(con, "scan-1", applicability="APPLICABLE", h=hashlib.sha256(pdf).hexdigest())
    monkeypatch.setattr(W.requests, "get", lambda url, **kw: _Resp(pdf))
    monkeypatch.setattr(W, "_sections_of", lambda content, allow_ocr: (None, "the copy is a scan"))

    res = W.check(con, "scan-1")
    assert res["outcome"] == "UNCHANGED" and "first comparable version" not in res["detail"]
    assert V.versions(con, "scan-1") == []
