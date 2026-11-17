"""Proves the change-detection code path. A throwaway DB — NOT evidence about production data."""
import sqlite3, sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from regulatory_ingestion import versions as V

con = sqlite3.connect(":memory:"); con.row_factory = sqlite3.Row
con.executescript("CREATE TABLE regulations (id TEXT PRIMARY KEY);")
con.execute("INSERT INTO regulations VALUES ('t-1')")
V.init(con)

v1_sections = [{"no": "3.1", "title": "KYC", "text": "Banks shall verify identity within 30 days."},
               {"no": "3.2", "title": "Records", "text": "Records shall be kept for five years."}]
v1 = V.capture(con, "t-1", v1_sections)
assert v1, "first capture must create a version"

# identical re-capture must NOT create a phantom second version
assert V.capture(con, "t-1", v1_sections) is None, "identical content must dedup"
print("PASS  identical re-capture is deduped (no phantom version)")

# a genuine textual change
v2_sections = [{"no": "3.1", "title": "KYC", "text": "Banks shall verify identity within 15 days."},
               {"no": "3.2", "title": "Records", "text": "Records shall be kept for five years."},
               {"no": "3.3", "title": "Reporting", "text": "Banks shall report quarterly."}]
v2 = V.capture(con, "t-1", v2_sections)
assert v2 and v2 != v1, "changed content must create a second version"
print("PASS  changed content creates a genuine second version")

changes = V.compare(con, "t-1", v1, v2)
by = {c["section_number"]: c for c in changes}
assert by["3.1"]["change_type"] == "modified", by["3.1"]
assert "3.2" not in by, "an unchanged section must not be reported as changed"
assert by["3.3"]["change_type"] == "added", by["3.3"]
print("PASS  3.1 modified, 3.2 correctly silent, 3.3 added")

runs = by["3.1"]["diff_runs"]
import json
runs = json.loads(runs) if isinstance(runs, str) else runs
assert any(r["type"] == "removed" and "30" in r["text"] for r in runs), runs
assert any(r["type"] == "added" and "15" in r["text"] for r in runs), runs
print("PASS  word diff marks '30' removed and '15' added (red/green source)")

n = con.execute("SELECT COUNT(*) FROM section_changes WHERE regulation_id='t-1'").fetchone()[0]
assert n == 2, n
print("PASS  section_changes persisted (%d rows)" % n)

try:
    V.compare(con, "t-1", None, v2); print("FAIL  compare(None) should raise"); sys.exit(1)
except ValueError:
    print("PASS  compare() rejects a missing version instead of reporting mass deletion")
print("\nAll detection-path tests passed.")
