"""
Two defects that cost real time, pinned so they cannot come back.

1. A download with no deadline. `requests`' timeout bounds one socket read,
   not the transfer, so a host that trickles bytes holds the reader forever.
   Two ingestion jobs sat in that state for hours at 0.6% CPU.

2. A company profile that only ever appeared if someone ran a script by hand.
   Applicability keys off the profile, so without one the whole corpus returns
   nothing — which is what the product was doing.

Both layers are hermetic: no network, no database.
"""
import os

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")


# ------------------------------------------------------------------ download
class _Resp:
    """Enough of a streamed requests.Response to drive fetch()."""
    status_code = 200

    def __init__(self, chunks): self._chunks = chunks
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def raise_for_status(self): pass
    def iter_content(self, _n): yield from self._chunks


def test_fetch_returns_the_body_as_bytes():
    import extract_pdf_text as X
    calls = []

    def fake_get(url, **kw):
        calls.append(kw)
        return _Resp([b"%PDF-1.4", b"rest"])

    X.requests.get, real = fake_get, X.requests.get
    try:
        assert X.fetch("http://example/x.pdf") == b"%PDF-1.4rest"
    finally:
        X.requests.get = real
    # streamed, with connect and stall bounded separately — a single scalar
    # timeout is what allowed the unbounded read in the first place
    assert calls[0]["stream"] is True
    assert isinstance(calls[0]["timeout"], tuple) and len(calls[0]["timeout"]) == 2


def test_a_trickling_host_is_abandoned_and_not_retried():
    """
    The actual failure: bytes keep arriving, so no read ever times out. The
    transfer deadline must fire, and must NOT be retried — a host trickling
    now will trickle again, and three more attempts buy an hour of nothing.
    """
    import extract_pdf_text as X
    calls = []

    def fake_get(url, **kw):
        calls.append(url)
        return _Resp([b"a"] * 50)

    X.requests.get, real = fake_get, X.requests.get
    deadline = X.TRANSFER_DEADLINE
    X.TRANSFER_DEADLINE = 0
    try:
        with pytest.raises(X.TransferTooSlow) as e:
            X.fetch("http://slow/x.pdf", attempts=4)
    finally:
        X.requests.get, X.TRANSFER_DEADLINE = real, deadline
    assert "abandoned" in str(e.value)
    # its own class, so a bare socket timeout from urllib3 is not mistaken for
    # a deadline breach and silently stripped of its retries
    assert issubclass(X.TransferTooSlow, TimeoutError)
    assert not issubclass(X.requests.Timeout, X.TransferTooSlow)
    assert len(calls) == 1, f"a deadline breach was retried {len(calls)} times"


def test_a_refused_connection_is_still_retried():
    """Throttling is not a bad document; the back-off must survive the fix."""
    import extract_pdf_text as X
    calls = []

    def fake_get(url, **kw):
        calls.append(url)
        raise X.requests.ConnectionError("refused")

    X.requests.get, real = fake_get, X.requests.get
    X.time.sleep, real_sleep = lambda _s: None, X.time.sleep
    try:
        with pytest.raises(X.requests.ConnectionError):
            X.fetch("http://throttled/x.pdf", attempts=3)
    finally:
        X.requests.get, X.time.sleep = real, real_sleep
    assert len(calls) == 3


def test_download_limits_are_all_present():
    import extract_pdf_text as X
    assert X.CONNECT_TIMEOUT and X.STALL_TIMEOUT and X.TRANSFER_DEADLINE
    assert X.STALL_TIMEOUT < X.TRANSFER_DEADLINE
    # a 12 MB gazette PDF has been measured at 24 KB/s ≈ 525s; the ceiling has
    # to clear that or the fix breaks honest slow downloads
    assert X.TRANSFER_DEADLINE >= 600


# ------------------------------------------------------------------- profile
class _Row:
    def __init__(self, v): self._v = v
    def fetchone(self): return self._v


class _Con:
    def __init__(self, existing=0):
        self.existing, self.writes = existing, []

    def execute(self, sql, params=None):
        s = " ".join(sql.split())
        if "COUNT(*) FROM company_profile" in s:
            return _Row((self.existing,))
        if s.startswith("INSERT INTO company_profile"):
            self.writes.append(params)
            return _Row(None)
        if "SELECT id FROM company_profile" in s:
            return _Row((7,))
        return _Row(None)

    def commit(self): pass


def _facts(**kw):
    out = {k: {"value": v, "file": "01-org.docx", "evidence": v if isinstance(v, str) else ""}
           for k, v in kw.items()}
    return out


def test_profile_is_never_created_without_an_evidenced_name():
    """Rule 6 applied to identity: no evidence, no record."""
    import derive_company_profile as D
    con = _Con(existing=0)
    created, why = D.write_profile(con, _facts(hq_state="Karnataka"))
    assert created is False and "legal name" in why
    assert con.writes == []


def test_an_existing_profile_is_never_overwritten():
    import derive_company_profile as D
    con = _Con(existing=1)
    created, why = D.write_profile(con, _facts(legal_name="Nirmaya Hospitals Private Limited"))
    assert created is False and "already exists" in why
    assert con.writes == []


def test_a_created_profile_cites_the_file_it_came_from():
    import derive_company_profile as D
    con = _Con(existing=0)
    created, why = D.write_profile(con, _facts(legal_name="Nirmaya Hospitals Private Limited"))
    assert created is True
    assert "UNVERIFIED" in why and "01-org.docx" in why
    assert con.writes[0][0] == "Nirmaya Hospitals Private Limited"


def test_heading_words_are_stripped_from_a_captured_name():
    import derive_company_profile as D
    assert D.clean_name("Entity Particulars Nirmaya Hospitals Private Limited") == \
        "Nirmaya Hospitals Private Limited"


def test_derive_reads_a_folder_and_cites_each_fact(tmp_path):
    import derive_company_profile as D
    (tmp_path / "01-org-profile.txt").write_text(
        "Entity Particulars\nNirmaya Hospitals Private Limited is a private company "
        "limited by shares, a multispecialty tertiary care hospital established in 2011 "
        "in Karnataka, holding a Drug Licence and a Biomedical Waste Authorisation.")
    facts = D.derive(tmp_path)
    assert facts["legal_name"]["value"] == "Nirmaya Hospitals Private Limited"
    assert facts["hq_state"]["value"] == "Karnataka"
    assert "Healthcare & Hospitals" in facts["sectors"]["value"]
    for k, v in facts.items():
        if k != "_files_examined":
            assert v["file"], f"{k} was derived without naming its source file"


def test_an_empty_folder_proposes_nothing(tmp_path):
    import derive_company_profile as D
    facts = D.derive(tmp_path)
    assert "legal_name" not in facts


# ----------------------------------------------------- the sync-time proposal
def test_sync_says_nothing_when_a_profile_already_exists(tmp_path):
    from regulatory_ingestion import integrations as I
    assert I._propose_profile(_Con(existing=1), tmp_path) == ""


def test_a_failed_proposal_never_fails_the_sync():
    """The collection succeeded. A profile it could not derive is a note."""
    from regulatory_ingestion import integrations as I

    class Broken:
        def execute(self, *a, **k): raise RuntimeError("database gone")

    note = I._propose_profile(Broken(), "/nonexistent")
    assert note.startswith(" Company profile could not be derived")
    assert "RuntimeError" in note


def test_folder_sync_proposes_a_profile():
    """The wiring itself: a path sync must reach the proposal."""
    import inspect
    from regulatory_ingestion import integrations as I
    src = inspect.getsource(I.sync)
    assert "_propose_profile(con, folder_base)" in src
    assert "folder_base = pathlib.Path" in src


def test_sync_time_proposal_reads_the_folder_and_cites_it(tmp_path):
    """
    End-to-end through the connector's own entry point — which is also the
    only thing that proves the deferred import of a top-level script resolves
    from inside the package.
    """
    from regulatory_ingestion import integrations as I
    (tmp_path / "01-org-profile.txt").write_text(
        "Entity Particulars\nNirmaya Hospitals Private Limited is a private company "
        "limited by shares, a multispecialty tertiary care hospital established in 2011 "
        "in Karnataka, holding a Drug Licence.")
    con = _Con(existing=0)
    note = I._propose_profile(con, tmp_path)
    assert "could not be derived" not in note
    assert "UNVERIFIED" in note and "01-org-profile.txt" in note
    assert con.writes[0][0] == "Nirmaya Hospitals Private Limited"


def test_a_derived_profile_is_recorded_as_unverified_with_its_sources():
    """
    "UNVERIFIED" must be a value in the row, not a sentence in a log line.
    Applicability for the whole corpus is computed against this profile, so a
    derived identity has to be distinguishable from a confirmed one.
    """
    import json

    import derive_company_profile as D
    seen = []

    class Recording(_Con):
        def execute(self, sql, params=None):
            seen.append(" ".join(sql.split()))
            return super().execute(sql, params)

    con = Recording(existing=0)
    D.write_profile(con, _facts(legal_name="Nirmaya Hospitals Private Limited",
                                hq_state="Karnataka"))
    insert = next(s for s in seen if s.startswith("INSERT INTO company_profile"))
    assert "source_verified" in insert
    # written as a literal 0, so no caller can pass a 1 in and skip review
    assert insert.rstrip(")").endswith(",0,?")
    provenance = json.loads(con.writes[0][-1])
    assert provenance["legal_name"]["file"] == "01-org.docx"
    assert provenance["legal_name"]["evidence"]
    assert provenance["hq_state"]["file"] == "01-org.docx"


def test_the_columns_it_claims_are_added_not_merely_declared():
    """
    CREATE TABLE IF NOT EXISTS no-ops on an existing table — that is exactly
    how an earlier change ended up writing to a column that did not exist.
    """
    import derive_company_profile as D
    seen = []

    class Recording(_Con):
        def execute(self, sql, params=None):
            seen.append(" ".join(sql.split()))
            return super().execute(sql, params)

    D.write_profile(Recording(existing=0), _facts(legal_name="X Y Private Limited"))
    altered = [s for s in seen if s.startswith("ALTER TABLE company_profile")]
    assert any("source_verified" in s for s in altered)
    assert any("derived_from" in s for s in altered)
    assert all("IF NOT EXISTS" in s for s in altered)


# ------------------------------------------------------- batched folder upload
def test_a_continuation_folder_must_sit_directly_under_the_upload_root(tmp_path, monkeypatch):
    """
    Batching means every batch after the first names a folder, so an
    attacker-controllable path reaches the filesystem. It must resolve to a
    direct child of ROOT or be refused — a refusal starts a new folder, which is
    harmless; a traversal would not be.
    """
    from regulatory_ingestion import upload_store as U
    monkeypatch.setattr(U, "ROOT", tmp_path)
    good = tmp_path / "folder-20260910-120000"
    good.mkdir()
    assert U.existing_batch_dir(str(good)) == good.resolve()

    # refusals
    assert U.existing_batch_dir("") is None
    assert U.existing_batch_dir(str(tmp_path / "does-not-exist")) is None
    assert U.existing_batch_dir("/etc") is None
    assert U.existing_batch_dir(str(good / ".." / ".." / "etc")) is None
    nested = good / "deeper"
    nested.mkdir()
    assert U.existing_batch_dir(str(nested)) is None, "a grandchild of ROOT was accepted"


def test_the_upload_endpoint_accepts_a_continuation_folder():
    """The wiring: without `into`, every batch would create its own folder."""
    import inspect

    from regulatory_ingestion import api_integrations as A
    src = inspect.getsource(A.upload_folder)
    assert "into" in src
    assert "existing_batch_dir" in src


# --------------------------------------- the setup form must offer what we derive
def _ts_list(name: str) -> list[str]:
    """Pull a string array out of the TypeScript source, without a JS runtime."""
    import pathlib
    import re
    src = (pathlib.Path(__file__).resolve().parents[2]
           / "company-brain-app/src/services/applicabilityProfile.ts")
    if not src.exists():
        return []
    text = src.read_text()
    body = text[text.index(f"export const {name} = ["):]
    body = body[body.index("[") + 1:body.index("];")]
    return re.findall(r"'([^']+)'", body)


def test_every_entity_type_the_deriver_produces_is_selectable():
    """
    A derived value the dropdown does not offer renders as unset, and the
    obvious way for a user to "fix" that is to pick something else — losing the
    answer their own documents gave. The two lists have to agree.
    """
    import derive_company_profile as D
    options = _ts_list("ENTITY_TYPES")
    if not options:
        pytest.skip("frontend source not present on this machine")
    for _rx, label in D.TYPE_RE:
        assert label in options, f"derived entity type {label!r} is not offered by Company Setup"


def test_every_sector_the_deriver_produces_is_selectable():
    import derive_company_profile as D
    options = _ts_list("SECTORS")
    if not options:
        pytest.skip("frontend source not present on this machine")
    for _rx, label in D.SECTOR_RE:
        assert label in options, f"derived sector {label!r} is not offered by Company Setup"


def test_the_healthcare_vocabulary_reaches_the_setup_form():
    """The complaint this fixed: a hospital could not describe itself."""
    types, sectors, licences = (_ts_list("ENTITY_TYPES"), _ts_list("SECTORS"), _ts_list("LICENCES"))
    if not types:
        pytest.skip("frontend source not present on this machine")
    assert any("Hospital" in t for t in types)
    assert any("Pharmac" in t for t in types)
    assert any("Blood centre" in t or "Blood Centre" in t for t in types)
    assert "Healthcare & Hospitals" in sectors
    assert "Clinical Establishment Registration" in licences
    assert any("Drug Licence" in l for l in licences)
    assert any("PNDT" in l for l in licences)


def test_an_employee_id_is_not_a_headcount():
    """
    "EMP-10499 Staff Nurse – Dialysis" proposed 10,499 employees for a 200-bed
    hospital. A number glued to a code by a hyphen is an identifier.
    """
    import derive_company_profile as D
    for ident in ("EMP-10499 Staff Nurse", "ID-4820 staff", "REF-99 personnel"):
        assert D.EMPLOYEES_RE.search(ident) is None, f"{ident!r} was read as a headcount"
    for real in ("a total of 1,240 employees", "842 personnel across both units"):
        assert D.EMPLOYEES_RE.search(real), f"{real!r} was not recognised"


def test_a_modifier_is_not_an_addressee():
    """
    "all applicable hospital records" is addressed to whoever keeps the records.
    Reading it as addressed to hospitals put an IRDAI circular and three TRAI
    cable-television consultations on a hospital's applicable list.
    """
    from regulatory_ingestion.addressee import role_in
    got = role_in("additional records giving all applicable hospital records and claims", "hospitals")
    assert not (got and got[0].startswith("ADDRESSEE")), got


def test_a_reported_suggestion_is_not_a_scope_clause():
    """A consultation paper quoting what stakeholders proposed is not enactment."""
    from regulatory_ingestion.addressee import role_in
    got = role_in("Another suggestion is for inclusion of all hospitals with 30 beds.", "hospitals")
    assert not (got and got[0].startswith("ADDRESSEE")), got


def test_a_real_distribution_list_still_counts():
    """The tightening must not cost recall on the thing it is for."""
    from regulatory_ingestion.addressee import role_in
    got = role_in("All hospitals and clinical establishments registered under the Act.", "hospitals")
    assert got and got[0].startswith("ADDRESSEE"), got
