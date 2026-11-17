"""The inbox list carries the regulation each notification is about."""
import sqlite3

from regulatory_ingestion import notifications as N


def _db():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("CREATE TABLE users (id TEXT PRIMARY KEY)")
    con.execute("CREATE TABLE regulations (id TEXT PRIMARY KEY, title TEXT, regulator_short TEXT, applicability TEXT)")
    con.executemany("INSERT INTO regulations VALUES (?,?,?,?)", [
        ("rbi-1", "Master Direction - KYC", "RBI", "NOT_APPLICABLE"),
        ("cpcb-1", "Bio-Medical Waste Management Rules, 2016", "CPCB", "APPLICABLE"),
    ])
    N._READY = False
    N.init(con)
    for i, reg in enumerate(["rbi-1", "cpcb-1", None, "gone-1"]):
        N.push(con, kind="source_changed", title=f"t{i}", dedupe_key=f"k{i}", role="viewer", regulation_id=reg)
    return con


def test_list_with_regulation_adds_title_regulator_and_applicability():
    rows = {r["title"]: r for r in N.for_user(_db(), {"id": "u1", "role": "admin"}, with_regulation=True)}
    assert len(rows) == 4
    assert rows["t0"]["regulation_applicability"] == "NOT_APPLICABLE"
    assert rows["t0"]["regulator_short"] == "RBI"
    assert rows["t1"]["regulation_title"] == "Bio-Medical Waste Management Rules, 2016"
    assert rows["t1"]["regulation_applicability"] == "APPLICABLE"
    # no regulation, or one no longer in the library: still listed, with nothing joined
    assert rows["t2"]["regulation_applicability"] is None
    assert rows["t3"]["regulation_title"] is None


def test_list_without_regulation_is_unchanged():
    rows = N.for_user(_db(), {"id": "u1", "role": "admin"})
    assert len(rows) == 4
    assert "regulation_applicability" not in rows[0]
    # read-state helpers still see every notification
    con = _db()
    assert N.unread_count(con, {"id": "u1", "role": "admin"}) == 4
