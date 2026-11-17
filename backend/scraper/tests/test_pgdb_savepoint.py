"""
A speculative probe must not be able to destroy the caller's transaction.

pgdb emulates sqlite's `lastrowid` by appending `RETURNING id` to every INSERT
that does not already have a RETURNING clause. When the target table has no
`id` column the probe fails, and the failure has to be undone.

It used to be undone with a plain ROLLBACK. That threw away the whole
transaction, not just the probe — so writing a regulation and then its facet
rows (regulation_sectors has no id column) erased the regulation and failed on
a foreign key pointing at the row it had just erased. Fourteen tables in this
schema have no `id` column, including impact_scores, which pipeline.process
writes for every document, and sessions, which every login writes.

These tests pin the two halves of the fix: the probe is undone with a
SAVEPOINT, and a table that has answered once is not asked again.
"""
import os

import pytest

os.environ.setdefault("RAG_WARM", "0")
os.environ.setdefault("TRACE_SINKS", "")

_OPT_IN = os.getenv("LIVE_DB_TESTS") == "1"
try:
    from regulatory_ingestion import pgdb
    from regulatory_ingestion.db import connect
    connect().execute("SELECT 1").fetchone()
    _DB = True
except Exception:                                   # noqa: BLE001
    _DB = False

live = pytest.mark.skipif(not (_DB and _OPT_IN),
                          reason="needs the live corpus; set LIVE_DB_TESTS=1 on the host that owns it")


def test_insert_target_parses_the_table_name():
    from regulatory_ingestion.pgdb import _insert_target
    assert _insert_target("INSERT INTO regulation_sectors (a,b) VALUES (1,2)") == "regulation_sectors"
    assert _insert_target("  insert   into   Regulations  (id) VALUES (1)") == "regulations"
    assert _insert_target('INSERT INTO "sections" (id) VALUES (1)') == "sections"
    assert _insert_target("SELECT 1") is None


@live
def test_a_write_survives_an_insert_into_a_table_without_an_id_column():
    """The regression itself: the second INSERT must not erase the first."""
    con = connect()
    rid = "zz-pgdb-savepoint-probe"
    con.execute("DELETE FROM regulations WHERE id=?", (rid,))
    con.commit()
    try:
        con.execute("INSERT INTO regulations (id, title, country) VALUES (?,?,?)",
                    (rid, "savepoint probe", "India"))
        # regulation_sectors has no id column, so this triggers the probe path
        con.execute("""INSERT INTO regulation_sectors (regulation_id, sector, derived_from)
                       VALUES (?,?,?) ON CONFLICT DO NOTHING""", (rid, "Healthcare", "TEST"))
        con.commit()
        assert con.execute("SELECT COUNT(*) FROM regulations WHERE id=?", (rid,)).fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM regulation_sectors WHERE regulation_id=?",
                           (rid,)).fetchone()[0] == 1
    finally:
        con.execute("DELETE FROM regulations WHERE id=?", (rid,))
        con.commit()


@live
def test_a_table_without_an_id_column_is_only_probed_once():
    con = connect()
    rid = "zz-pgdb-probe-cache"
    con.execute("DELETE FROM regulations WHERE id=?", (rid,))
    con.commit()
    pgdb._NO_ID_TABLES.discard("regulation_sectors")
    try:
        con.execute("INSERT INTO regulations (id, title, country) VALUES (?,?,?)",
                    (rid, "probe cache", "India"))
        con.execute("""INSERT INTO regulation_sectors (regulation_id, sector, derived_from)
                       VALUES (?,?,?) ON CONFLICT DO NOTHING""", (rid, "Healthcare", "TEST"))
        assert "regulation_sectors" in pgdb._NO_ID_TABLES
        con.commit()
    finally:
        con.execute("DELETE FROM regulations WHERE id=?", (rid,))
        con.commit()
