"""
Run the ingestion pipeline over every regulation that has a document URL but no
document — the 1,100-regulation coverage gap, worked through with validation.

Order of honesty:
  1. the PDF is downloaded here first, and a response that is not actually a
     PDF (login page, listing HTML, error page) is recorded FAILED_FETCH and
     never handed to the extractor — a page is not a document;
  2. pipeline.process() then runs the normal chain (hash → extract → sections
     → obligations → applicability → matcher → impact → provenance) and keeps
     its own honest stops (OCR_REQUIRED when there is no text layer);
  3. nothing existing is deleted; regs that fail stay DISCOVERED/FAILED with
     the reason in ingestion_jobs.

    python ingest_backlog.py --limit 8            # small proof batch
    python ingest_backlog.py                      # the whole backlog
"""
from __future__ import annotations

import argparse
import json
import time

import extract_pdf_text as X
from regulatory_ingestion import pipeline
from regulatory_ingestion.db import connect


def targets(con, ids=None):
    if ids:
        # explicit ids are re-run even when a documents row already exists —
        # that is how a half-committed failure (docs written, mapping crashed)
        # gets finished
        marks = ",".join("?" for _ in ids)
        return con.execute(
            f"""SELECT id, title, regulator_short, official_document_url
                FROM regulations WHERE id IN ({marks}) ORDER BY id""", list(ids)).fetchall()
    q = """SELECT id, title, regulator_short, official_document_url FROM regulations g
           WHERE official_document_url LIKE 'http%'
             AND coalesce(ingestion_status,'') <> 'OCR_REQUIRED'
             AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=g.id)
           ORDER BY id"""
    return con.execute(q).fetchall()


def extract_validated(con, reg) -> bool:
    """One fetch + extraction via extract_one (PDF magic check, cached bytes,
    OCR fallback when available); the JSON lands where pipeline.process looks."""
    rid = reg["id"]
    ext_f = X.OUT_DIR / f"{rid}.json"
    if ext_f.exists():
        return True
    X.OUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        doc = X.extract_one({"id": rid, "title": reg["title"] or rid,
                             "regulatorShort": reg["regulator_short"] or "",
                             "pdfUrl": reg["official_document_url"]})
    except Exception as e:  # noqa: BLE001 — recorded per class below, batch continues
        msg = f"{type(e).__name__}: {e}"
        if "scanned PDF" in str(e):
            pipeline.set_status(con, rid, "OCR_REQUIRED")
            pipeline.log(con, rid, "extract", "OCR_REQUIRED", msg)
        else:
            pipeline.set_status(con, rid, "FAILED_FETCH")
            pipeline.log(con, rid, "download", "FAILED", msg)
        return False
    ext_f.write_text(json.dumps(doc, ensure_ascii=False))
    return True


def run(limit: int = 0, delay: float = 3.0, ids=None) -> dict:
    con = connect()
    rows = targets(con, ids)
    if limit:
        rows = rows[:limit]
    tally = {"targets": len(rows), "mapped": 0, "ocr_required": 0, "failed_fetch": 0, "failed_process": 0}
    t0 = time.time()
    for n, r in enumerate(rows, 1):
        rid = r["id"]
        print(f"[{n}/{len(rows)}] {rid}")
        if not extract_validated(con, r):
            key = "ocr_required" if "OCR" in (con.execute(
                "SELECT ingestion_status FROM regulations WHERE id=?", (rid,)).fetchone()[0] or "") else "failed_fetch"
            tally[key] += 1
            time.sleep(delay)
            continue
        try:
            pipeline.process(con, rid)
            status = con.execute("SELECT ingestion_status FROM regulations WHERE id=?", (rid,)).fetchone()[0]
            tally["mapped" if status == "MAPPED" else "ocr_required"] += 1
        except Exception as e:  # noqa: BLE001 — one bad PDF must not stop the batch
            con.rollback()
            tally["failed_process"] += 1
            pipeline.set_status(con, rid, "FAILED")
            pipeline.log(con, rid, "process", "FAILED", f"{type(e).__name__}: {e}")
        time.sleep(delay)
    tally["seconds"] = round(time.time() - t0, 1)
    return tally


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--delay", type=float, default=3.0)
    ap.add_argument("--ids", nargs="*")
    a = ap.parse_args()
    print(json.dumps(run(a.limit, a.delay, a.ids)))
