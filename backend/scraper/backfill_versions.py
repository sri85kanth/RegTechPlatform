"""Capture version 1 for every document already extracted, so change status is accurate."""
import json, pathlib
from regulatory_ingestion.db import connect
from regulatory_ingestion import versions as V

EX = pathlib.Path(__file__).parent.parent / "company-brain-app" / "public" / "data" / "extracted"
con = connect()
V.init(con)
known = {r[0] for r in con.execute("SELECT id FROM regulations")}
hashes = {r[0]: r[1] for r in con.execute("SELECT regulation_id, document_hash FROM documents")}

new = skipped = 0
for f in sorted(EX.glob("*.json")):
    if f.name == "index.json":
        continue
    d = json.loads(f.read_text())
    rid = d.get("id")
    if rid not in known or not d.get("sections"):
        continue
    vid = V.capture(con, rid, d["sections"], document_hash=hashes.get(rid), page_count=d.get("pages"))
    if vid: new += 1
    else: skipped += 1
print(f"captured {new} first versions ({skipped} already present)")
print("  document_versions:", con.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0])
print("  section_snapshots:", con.execute("SELECT COUNT(*) FROM section_snapshots").fetchone()[0])
