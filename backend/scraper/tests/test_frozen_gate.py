"""
A batch must be judged by one precision gate, not by a gate that moves under it.

matcher._generic_names_cached recomputes the generic-name set whenever the
corpus grows past a bucket boundary — 25 regulations. Ingesting a hundred
documents crosses four of those, so the gate that decided document 1's matches
is not the gate that decides document 100's, and re-running the same batch in a
different order can produce different matches. frozen_precision_gate pins it.
"""
import os

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

from regulatory_ingestion import matcher  # noqa: E402


class _Con:
    """Counts how often the expensive scan is asked for, and grows as it goes."""

    def __init__(self):
        self.scans = 0
        self.regulations = 1500

    def execute(self, sql, params=None):
        if "COUNT(DISTINCT regulation_id)" in sql:
            self.regulations += 30          # every call crosses a 25-regulation bucket
            return _Row((100_000, self.regulations))
        raise AssertionError(f"unexpected query: {sql}")


class _Row:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


@pytest.fixture(autouse=True)
def _clean_cache():
    matcher._GENERIC_CACHE.clear()
    matcher._FROZEN = None
    yield
    matcher._GENERIC_CACHE.clear()
    matcher._FROZEN = None


def _count_scans(monkeypatch):
    calls = {"n": 0}

    def fake_df(con, names):
        calls["n"] += 1
        return {n: 1 for n in names}

    monkeypatch.setattr("regulatory_ingestion.precision.document_frequency", fake_df)
    return calls


def test_without_freezing_a_growing_corpus_rescans(monkeypatch):
    calls = _count_scans(monkeypatch)
    con = _Con()
    for _ in range(4):
        matcher._generic_names_cached(con, ["alpha", "beta"])
    assert calls["n"] == 4, "each bucket crossing should recompute when not frozen"


def test_freezing_scans_once_for_the_whole_batch(monkeypatch):
    calls = _count_scans(monkeypatch)
    con = _Con()
    with matcher.frozen_precision_gate(con, ["alpha", "beta"]):
        for _ in range(4):
            matcher._generic_names_cached(con, ["alpha", "beta"])
    assert calls["n"] == 1, "a frozen gate is computed once and reused"


def test_the_gate_is_released_afterwards(monkeypatch):
    _count_scans(monkeypatch)
    con = _Con()
    with matcher.frozen_precision_gate(con, ["alpha"]):
        pass
    assert matcher._FROZEN is None, "the freeze must not outlive the batch"


def test_the_gate_is_released_even_when_the_batch_raises(monkeypatch):
    _count_scans(monkeypatch)
    con = _Con()
    with pytest.raises(RuntimeError):
        with matcher.frozen_precision_gate(con, ["alpha"]):
            raise RuntimeError("one bad document")
    assert matcher._FROZEN is None


# ---------------------------------------------------------------------------
# A precomputed gate must be used as given, and refused when it does not fit.
def test_a_precomputed_gate_is_used_without_scanning(monkeypatch):
    calls = _count_scans(monkeypatch)
    con = _Con()
    with matcher.frozen_precision_gate(con, ["alpha"], precomputed={"alpha"}) as g:
        assert g == {"alpha"}
        assert matcher._generic_names_cached(con, ["alpha"]) == {"alpha"}
    assert calls["n"] == 0, "a supplied gate must not trigger the scan"


def test_a_gate_from_a_different_corpus_is_refused(tmp_path):
    import json

    import gate_offboard

    f = tmp_path / "gate.json"
    f.write_text(json.dumps({"computed_at": "then", "corpus": 900, "obligations": 1,
                             "name_count": 2, "seconds": 1.0, "generic": ["alpha"]}))

    class _C:
        def execute(self, sql, params=None):
            return _Row((100_000, 1500))            # corpus has moved from 900 to 1500

    with pytest.raises(SystemExit) as e:
        gate_offboard.load(_C(), f, ["alpha", "beta"])
    assert "recompute" in str(e.value)


def test_a_gate_for_a_different_entity_set_is_refused(tmp_path):
    import json

    import gate_offboard

    f = tmp_path / "gate.json"
    f.write_text(json.dumps({"computed_at": "then", "corpus": 1500, "obligations": 1,
                             "name_count": 99, "seconds": 1.0, "generic": []}))

    class _C:
        def execute(self, sql, params=None):
            return _Row((100_000, 1500))

    with pytest.raises(SystemExit) as e:
        gate_offboard.load(_C(), f, ["alpha", "beta"])
    assert "entity names" in str(e.value)
