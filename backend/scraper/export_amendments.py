"""Write per-regulation amendment history for the frontend."""
import json, pathlib
from collections import defaultdict
from regulatory_ingestion.db import connect
from regulatory_ingestion.company_db import init_amendments

OUT = pathlib.Path(__file__).parent.parent / "company-brain-app" / "public" / "data" / "amendments"
OUT.mkdir(parents=True, exist_ok=True)
con = init_amendments(connect()); con.row_factory = __import__("sqlite3").Row

by_reg = defaultdict(list)
for r in con.execute("SELECT * FROM regulation_amendments ORDER BY amended_on DESC, section_number"):
    by_reg[r["regulation_id"]].append(dict(r))

index = {}
for rid, rows in by_reg.items():
    circulars = {}
    for a in rows:
        c = circulars.setdefault(a["reference"], {
            "reference": a["reference"], "amendedOn": a["amended_on"],
            "instrument": a["instrument"], "actions": set(), "sections": [],
        })
        c["actions"].add(a["action"])
        if a["section_number"] and a["section_number"] not in c["sections"]:
            c["sections"].append(a["section_number"])
    timeline = sorted(
        [{**c, "actions": sorted(c["actions"]), "sectionCount": len(c["sections"])} for c in circulars.values()],
        key=lambda x: x["amendedOn"], reverse=True)
    payload = {
        "regulationId": rid,
        "total": len(rows),
        "circulars": len(timeline),
        "latest": timeline[0]["amendedOn"] if timeline else None,
        "timeline": timeline,
        "amendments": [{
            "section": a["section_number"], "sectionTitle": a["section_title"],
            "action": a["action"], "meaning": a["meaning"],
            "reference": a["reference"], "amendedOn": a["amended_on"],
            "context": a["context"],
        } for a in rows],
    }
    (OUT / f"{rid}.json").write_text(json.dumps(payload, ensure_ascii=False))
    index[rid] = {"total": payload["total"], "circulars": payload["circulars"], "latest": payload["latest"]}

(OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))
print(f"exported {len(index)} regulations → {OUT}")
for rid, v in index.items():
    print(f"  {rid:16} {v['total']:>4} amendments  {v['circulars']:>3} circulars  latest {v['latest']}")
