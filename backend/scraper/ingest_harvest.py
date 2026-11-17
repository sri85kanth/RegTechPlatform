"""
Register and ingest the documents harvested by harvest_healthcare.py.

The harvester has already done the two expensive halves — the download and the
text extraction — and left `output/documents/<id>.pdf` and
`output/extracted/<id>.json` exactly where pipeline.process looks for them. So
this does the part that must happen next to the database: create the regulation
row, then run the normal chain (hash -> sections -> obligations ->
applicability -> matcher -> impact -> provenance).

pipeline.process re-reads the PDF off disk and re-computes its sha256 here, so
the hash stored against the document is of the bytes this machine holds, not a
number copied from somewhere else.

Nothing is invented: title, regulator and URL come from the harvest register,
which took them from the portal's own anchor text. A document whose extraction
produced no sections is left DISCOVERED with the reason recorded, not padded.

    python ingest_harvest.py --dry-run
    python ingest_harvest.py --apply --limit 100
"""
from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from regulatory_ingestion import matcher, pipeline
from regulatory_ingestion.db import connect

HERE = Path(__file__).parent
REGISTER = HERE / "output" / "healthcare_harvest.json"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


# A document ABOUT an instrument is not that instrument. "FAQ on Medical Device
# Rule, 2017" is an FAQ; "Addendum 01 to FAQ on Medical Devices Rules 2017" is an
# addendum to an FAQ. Typing either as a Rule would put explanatory material in
# the corpus with the authority of subordinate legislation, which is the kind of
# overstatement the applicability engine then has to be trusted not to act on.
ABOUT = re.compile(
    r"\b(faq|faqs|frequently asked|addendum|annexure|corrigend\w+|form|forms|"
    r"declaration|application|checklist|template|presentation|brochure|"
    r"training module|guidance tool|invitation|comments on|draft)\b", re.I)


def instrument_type(title: str) -> str:
    """What kind of instrument the title says it is. Unknown stays 'Document'."""
    t = (title or "").lower()
    if ABOUT.search(t):
        return "Guidance material"
    for pattern, kind in (
        (r"\brules?\b", "Rule"),
        (r"\bregulations?\b", "Regulation"),
        (r"\bact\b", "Act"),
        (r"\b(notification|gazette)\b", "Notification"),
        (r"\bor(der|ders)\b", "Order"),
        (r"\b(guideline|guidelines|guidance)\b", "Guideline"),
        (r"\b(standard|standards|accreditation)\b", "Standard"),
        (r"\b(circular|advisory)\b", "Circular"),
        (r"\b(policy|framework|plan)\b", "Policy"),
        (r"\b(manual|protocol|sop)\b", "Protocol"),
    ):
        if re.search(pattern, t):
            return kind
    return "Document"


def register_one(con, d: dict) -> None:
    rid, title = d["id"], d["title"]
    con.execute(
        """INSERT INTO regulations
             (id, title, regulator, regulator_short, regulation_type, sector,
              jurisdiction, country, source_url, official_document_url,
              ingestion_status, status, source_verified, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (id) DO UPDATE SET
             title=EXCLUDED.title, regulator=EXCLUDED.regulator,
             regulator_short=EXCLUDED.regulator_short,
             official_document_url=EXCLUDED.official_document_url,
             source_url=EXCLUDED.source_url, updated_at=EXCLUDED.updated_at""",
        (rid, title, d["regulator"], d["short"], instrument_type(title), "Healthcare",
         "India", "India", d.get("origin") or d["url"], d["url"],
         "DISCOVERED", "Active", 0, _now(), _now()))
    # The library filters read the join tables, not regulations.sector — an
    # instrument written only to the columns is in the corpus and invisible.
    con.execute("""INSERT INTO regulation_sectors (regulation_id, sector, derived_from, evidence)
                   VALUES (?,?,?,?) ON CONFLICT DO NOTHING""",
                (rid, "Healthcare", "HARVEST", d["short"]))
    con.execute("""INSERT INTO regulation_regions
                     (regulation_id, state_ut, region_kind, coverage, derived_from, evidence)
                   VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING""",
                (rid, "*", "ALL", "ALL_INDIA", "HARVEST", d["short"]))
    con.execute("""INSERT INTO regulation_types (regulation_id, type, source_type)
                   VALUES (?,?,?) ON CONFLICT DO NOTHING""",
                (rid, instrument_type(title), "Harvested from regulator portal"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--gate-file", help="a precision gate computed by gate_offboard.py; "
                                        "skips the scan, which costs ~50 minutes on the VPS")
    a = ap.parse_args()

    data = json.loads(REGISTER.read_text())
    docs = [d for d in data["documents"] if d.get("sections")]
    skipped = [d for d in data["documents"] if not d.get("sections")]
    if a.limit:
        docs = docs[:a.limit]

    print(f"harvest      : {data['harvested_at']}  ({data['seconds']}s)")
    print(f"with text    : {len(docs)}   no sections (left DISCOVERED): {len(skipped)}")
    print(f"rejected     : {len(data['rejected'])} (not a PDF, duplicate bytes, or fetch error)")
    if not a.apply:
        for d in docs[:25]:
            print(f"  {d['short']:6} {instrument_type(d['title']):12} {d['sections']:4} sec  {d['title'][:70]}")
        print("\n(dry run — nothing written; pass --apply)")
        return

    con = connect()
    t0 = time.time()
    tally = {"mapped": 0, "ocr_required": 0, "failed": 0}
    # One precision gate for the whole batch: see matcher.frozen_precision_gate.
    # Without it the gate is recomputed every 25 regulations, which costs minutes
    # each time and makes a document's matches depend on its place in the queue.
    names = [r[0] for r in con.execute("SELECT name FROM company_entities").fetchall()]
    if a.gate_file:
        import gate_offboard
        gate = matcher.frozen_precision_gate(con, names, precomputed=gate_offboard.load(
            con, a.gate_file, names))
    else:
        gate = matcher.frozen_precision_gate(con, names)
    gate.__enter__()
    print(f"precision gate frozen over {len(names)} entity names "
          f"({time.time() - t0:.0f}s)", flush=True)
    for n, d in enumerate(docs, 1):
        rid = d["id"]
        print(f"[{n}/{len(docs)}] {rid} · {d['sections']} sections · {d['title'][:56]}", flush=True)
        try:
            register_one(con, d)
            con.commit()
            pipeline.process(con, rid)
            status = con.execute("SELECT ingestion_status FROM regulations WHERE id=?", (rid,)).fetchone()[0]
            tally["mapped" if status == "MAPPED" else "ocr_required"] += 1
            con.commit()
        except Exception as e:                      # noqa: BLE001 — one bad document must not end the batch
            con.rollback()
            tally["failed"] += 1
            pipeline.set_status(con, rid, "FAILED")
            pipeline.log(con, rid, "process", "FAILED", f"{type(e).__name__}: {e}"[:280])
            con.commit()
            print(f"    FAILED {type(e).__name__}: {e}"[:160], flush=True)

    # Documents that fetched but carry no text layer are recorded as such.
    for d in skipped:
        try:
            register_one(con, d)
            pipeline.set_status(con, d["id"], "OCR_REQUIRED")
            pipeline.log(con, d["id"], "extract", "OCR_REQUIRED",
                         d.get("error") or "no text layer in the PDF")
            con.commit()
        except Exception:                           # noqa: BLE001
            con.rollback()

    gate.__exit__(None, None, None)
    tally["seconds"] = round(time.time() - t0, 1)
    tally["per_document"] = round(tally["seconds"] / max(len(docs), 1), 1)
    print(json.dumps(tally))


if __name__ == "__main__":
    main()
