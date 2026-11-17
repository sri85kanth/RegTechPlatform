"""
Store the gap assessments and the hospital's document graph in the database, so
the app's Impact Cascade page (/cascade, served by api_cascade.py) reads them
live instead of from a published snapshot.

    python cascade_sync.py <company upload folder> <hosp6_gap.json> <regs_gap.json>

Tables (created if missing):
  gap_assessments   one row per assessed requirement: status, risk, rewritten
                    obligation/requirement, covering documents, gap, fix
  cascade_graph     one row (id='company'): the policies/SOPs/forms/controls/risks
                    graph with document text, as JSON
Re-running replaces both, so it is safe after any new assessment run.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect                       # noqa: E402
from cascade_build import company_graph, from_nabh, from_regs      # noqa: E402

SCHEMA = """
CREATE TABLE IF NOT EXISTS gap_assessments (
  requirement_id TEXT PRIMARY KEY,
  regulation_id  TEXT NOT NULL,
  unit_group     TEXT, unit_code TEXT, unit_title TEXT,
  item_code      TEXT, requirement_text TEXT,
  category       TEXT,
  status         TEXT NOT NULL,      -- MET PARTIAL GAP NOT_COVERED NOT_APPLICABLE
  risk           TEXT NOT NULL,      -- Critical High Medium Low None
  obligation     TEXT, testable_requirement TEXT, responsible TEXT, frequency TEXT,
  covered_by     TEXT,               -- JSON array of document codes
  gap TEXT, fix TEXT, consequence TEXT,
  position       INTEGER,
  assessed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_gap_reg ON gap_assessments(regulation_id);
ALTER TABLE gap_assessments ADD COLUMN IF NOT EXISTS sub_requirements TEXT;   -- JSON: guidebook requirements under an element
ALTER TABLE gap_assessments ADD COLUMN IF NOT EXISTS interpretation TEXT;     -- guidebook interpretation of the element
ALTER TABLE gap_assessments ADD COLUMN IF NOT EXISTS source_page INTEGER;
CREATE TABLE IF NOT EXISTS cascade_graph (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT);
"""


def main() -> None:
    folder, nabh, regs = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    con = connect()
    con.executescript(SCHEMA)
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")

    rows = []
    req_ids = {}
    # NABH 6th: requirement ids follow nabh6_load's scheme
    for reg in from_nabh(nabh):
        for u in reg["units"]:
            for i in u["items"]:
                code = i["c"]
                std, letter = code.rsplit(".", 1)
                rid = f"{reg['id']}-sec-{std.lower().replace('.', '-')}-{letter}-r"
                req_ids[rid] = reg["id"]
                rows.append((rid, reg["id"], u["g"], u["u"], u["ut"], code, i["t"], i["cat"], i["st"], i["rk"],
                             i["ob"], i["rq"], i["who"], "", json.dumps(i["by"]), i["gap"], i["fix"], i["why"],
                             json.dumps(i.get("subs") or []), i.get("interp") or "", i.get("gbp")))
    for reg in from_regs(regs):
        for u in reg["units"]:
            for i in u["items"]:
                rows.append((i["rid"], reg["id"], u["g"], u["u"], u["ut"], i["c"], i["t"], "", i["st"], i["rk"],
                             i["ob"], i["rq"], i["who"], "", json.dumps(i["by"]), i["gap"], i["fix"], i["why"],
                             "[]", "", None))
    known = {r["id"] for r in con.execute("SELECT id FROM requirements WHERE id = ANY(?)", ([r[0] for r in rows],))}
    rows = [r for r in rows if r[0] in known]
    # only the regulations this run rebuilds — rows written by an in-app upload
    # (regulatory_ingestion/reg_upload.py) belong to their job and stay
    con.execute("DELETE FROM gap_assessments WHERE regulation_id = ANY(?) AND requirement_id NOT LIKE ?",
                (sorted({r[1] for r in rows}), "%-u________-c%"))
    con.executemany(
        """INSERT INTO gap_assessments (requirement_id,regulation_id,unit_group,unit_code,unit_title,item_code,
             requirement_text,category,status,risk,obligation,testable_requirement,responsible,frequency,
             covered_by,gap,fix,consequence,sub_requirements,interpretation,source_page,position,assessed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (requirement_id) DO NOTHING""",
        [r + (n, ts) for n, r in enumerate(rows)])

    g = company_graph(folder)
    con.execute("DELETE FROM cascade_graph WHERE id='company'")
    con.execute("INSERT INTO cascade_graph (id,payload,updated_at) VALUES ('company',?,?)",
                (json.dumps({"docs": g["docs"], "risks": g["risks"]}, ensure_ascii=False), ts))
    con.commit()
    tally: dict = {}
    for r in rows:
        tally[r[8]] = tally.get(r[8], 0) + 1
    print(f"gap_assessments {len(rows)} rows · {tally} · graph docs {len(g['docs'])} risks {len(g['risks'])}")


if __name__ == "__main__":
    main()
