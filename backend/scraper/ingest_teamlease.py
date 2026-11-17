"""
Register and ingest the TeamLease RegTech legal-update PDFs.

The PDFs were bulk-copied to the server (/root/TeamLeasePDFs) with a manifest
(input/teamlease_manifest.csv) carrying title, date, category, state, regulator
and the original blob URL for each one. link_teamlease.sh (run as root) hard-links
every fully arrived file to output/documents/<id>.pdf, which is exactly where
extract_pdf_text.extract_one and pipeline.process look — so nothing is fetched.

This script, run as brain, does the rest in parallel worker processes, one
connection each:

  1. create the regulation row + sector / region / type join rows
  2. extract (ingest_backlog.extract_validated: PDF check, OCR fallback, layout)
  3. pipeline.process: hash -> sections -> obligations -> applicability ->
     matcher -> impact -> provenance

Only ids whose PDF is already linked are taken; ids already MAPPED (or left
OCR_REQUIRED) are skipped, so a re-run picks up where the last one stopped.
--follow keeps polling for newly linked files while the upload is still running.

    python ingest_teamlease.py --limit 50 --workers 8          # pilot
    python ingest_teamlease.py --workers 8 --follow            # everything
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
MANIFEST = HERE / "input" / "teamlease_manifest.csv"
DOCS_DIR = HERE / "output" / "documents"
EXTRACTED = HERE / "output" / "extracted"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# Marks a document whose text carries no numbered structure and is therefore
# stored as one section — see _full_text_fallback.
FULLTEXT = "unstructured (full text)"
MIN_SECTION = 80          # rag.regulatory_chunks ignores anything shorter

# TeamLease's category -> the sector names the library filters already use.
# Categories with no existing equivalent keep their own name.
SECTOR = {
    "Labour": "Labour & Employment",
    "Finance & Taxation": "Taxation",
    "Secretarial": "Corporate / Companies",
    "EHS": "Environment",
    "Commercial": "Commercial",
    "Industry Specific": "Industry Specific",
    "Reports": "Reports",
}
UTS = {"andaman and nicobar islands", "chandigarh", "dadra and nagar haveli and daman and diu",
       "dadra and nagar haveli", "daman and diu", "delhi", "jammu and kashmir", "ladakh",
       "lakshadweep", "puducherry"}

_con = None


def _init_worker(generic: set[str], defer_ocr: bool = True) -> None:
    """Freeze the precision gate in this worker. pipeline.process calls
    load_brain() per document, and without a frozen gate every worker runs the
    corpus-wide name scan itself (~50 min each on this host)."""
    from regulatory_ingestion import matcher
    matcher._FROZEN = generic

    if defer_ocr:
        # A scan costs 300 s of tesseract per page and, with 8 workers on 4
        # cores, it does not finish inside that limit anyway: the batch dropped
        # from ~1,400 documents/hour to ~600 while a handful of scans occupied
        # the workers. Telling extract_one that OCR is unavailable makes it stop
        # at the honest place — the document is recorded OCR_REQUIRED — and the
        # --ocr-pass run then does those documents at a concurrency where
        # tesseract can actually finish.
        from regulatory_ingestion import ocr
        ocr.available = lambda: (False, "OCR deferred to the dedicated --ocr-pass run")


def _worker_con():
    """This worker's connection, reconnecting if the old one died.

    A worker outlives many documents, and its connection can be closed under it
    (server restart, idle timeout, the process being stopped and continued).
    Without this check the worker keeps the dead handle and every remaining
    document it is handed fails with "the connection is closed" — 36 documents
    were lost that way before the check existed.
    """
    global _con
    from regulatory_ingestion.db import connect
    if _con is not None:
        try:
            _con.execute("SELECT 1").fetchone()
            return _con
        except Exception:  # noqa: BLE001 — any dead-connection error means reconnect
            try:
                _con.close()
            except Exception:  # noqa: BLE001
                pass
            _con = None
    _con = connect()
    return _con


def regulator_short(name: str) -> str:
    m = re.search(r"\(([^()]{2,15})\)\s*$", name or "")
    return m.group(1).strip() if m else (name or "").strip()


def iso_date(s: str) -> str | None:
    try:
        return datetime.strptime(s.strip(), "%b %d, %Y").date().isoformat()
    except (ValueError, AttributeError):
        return None


def register_one(con, d: dict, multi: bool) -> None:
    from ingest_harvest import instrument_type
    rid = d["id"]
    title = d["title"] + (f" (document {d['doc_no']})" if multi else "")
    rtype = instrument_type(title)
    state = (d["state"] or "").strip()
    central = state.lower() in ("", "central", "all india", "pan india")
    sector = SECTOR.get(d["category"], d["category"])
    con.execute(
        """INSERT INTO regulations
             (id, title, regulator, regulator_short, regulation_type, sector,
              jurisdiction, country, state, issued_on, published_date, source_url,
              official_document_url, ingestion_status, status, source_verified,
              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (id) DO UPDATE SET
             title=EXCLUDED.title, regulator=EXCLUDED.regulator,
             regulator_short=EXCLUDED.regulator_short, sector=EXCLUDED.sector,
             state=EXCLUDED.state, issued_on=EXCLUDED.issued_on,
             published_date=EXCLUDED.published_date, source_url=EXCLUDED.source_url,
             official_document_url=EXCLUDED.official_document_url,
             updated_at=EXCLUDED.updated_at""",
        (rid, title, d["regulator"], regulator_short(d["regulator"]), rtype, sector,
         "India", "India", None if central else state, d["date"], iso_date(d["date"]),
         d["article_url"] or d["source_url"], d["source_url"],
         "DISCOVERED", "Active", 0, _now(), _now()))
    con.execute("""INSERT INTO regulation_sectors (regulation_id, sector, derived_from, evidence)
                   VALUES (?,?,?,?) ON CONFLICT DO NOTHING""",
                (rid, sector, "TEAMLEASE", d["category"]))
    if central:
        region = ("*", "ALL", "ALL_INDIA")
    else:
        region = (state, "UT" if state.lower() in UTS else "STATE", "STATE_SPECIFIC")
    con.execute("""INSERT INTO regulation_regions
                     (regulation_id, state_ut, region_kind, coverage, derived_from, evidence)
                   VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING""",
                (*((rid,) + region), "TEAMLEASE", state or "Central"))
    con.execute("""INSERT INTO regulation_types (regulation_id, type, source_type)
                   VALUES (?,?,?) ON CONFLICT DO NOTHING""",
                (rid, rtype, "TeamLease RegTech legal update"))
    con.commit()


_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff]")


def _clean(s: str) -> str:
    """Strip control bytes a PDF text layer can carry.

    Postgres rejects NUL outright ("text fields cannot contain NUL (0x00)
    bytes") and the document is lost at the INSERT, after extraction has already
    been paid for. The other C0 controls are not text either; tab, newline and
    carriage return are kept.

    Lone surrogates (\\ud800-\\udfff) go too: a PDF text layer can decode into
    one, and it is not encodable as UTF-8, so writing the extraction JSON dies
    with "surrogates not allowed" — one document was lost that way.
    """
    return _CONTROL.sub("", s or "")


def _sanitise(doc: dict) -> dict:
    for s in doc.get("sections", []):
        s["text"] = _clean(s.get("text"))
        s["title"] = _clean(s.get("title"))
        s["chars"] = len(s["text"])
    doc["title"] = _clean(doc.get("title"))
    return doc


def _has_usable_section(doc: dict) -> bool:
    return any(len((s.get("text") or "")) > MIN_SECTION for s in doc.get("sections", []))


def ocr_backlog(con, rows: list[dict]) -> list[dict]:
    """Documents parked as OCR_REQUIRED, for the low-concurrency OCR pass."""
    ids = {r[0] for r in con.execute(
        "SELECT id FROM regulations WHERE id LIKE ? AND ingestion_status = 'OCR_REQUIRED'",
        ("tl-%",)).fetchall()}
    out = [d for d in rows if d["id"] in ids and (DOCS_DIR / f"{d['id']}.pdf").exists()]
    for d in out:
        (EXTRACTED / f"{d['id']}.json").unlink(missing_ok=True)
    return out


def _full_text_fallback(doc: dict) -> dict:
    """Store the document's own text as ONE section when it has no numbered structure.

    These are notifications and circulars — three pages, one announcement, no
    CHAPTER or "1." for parse_any_structure to find. The pipeline stores them
    either way, but rag.regulatory_chunks builds chunks only from sections and
    from obligations (which are themselves parsed out of sections), so a
    document with no sections is in the database and absent from every search.

    One section holding the whole notice is not invented structure: it is the
    notice. The origin stays visible — structureFamily says the text is
    unstructured and the extraction method records the fallback — so nothing
    downstream can mistake this for a document that parsed into real sections.
    """
    import io
    import extract_pdf_text as X
    from pypdf import PdfReader

    blob = (X.DOCS_STORE / f"{doc['id']}.pdf").read_bytes()
    reader = PdfReader(io.BytesIO(blob))
    text, _furniture = X._strip_furniture([p.extract_text() or "" for p in reader.pages])
    if len(text.strip()) < 400:
        # a scan: extract_one already OCR'd it, but returns no raw text, so redo
        # it here rather than store a page of nothing
        from regulatory_ingestion import ocr as _ocr
        ok, _why = _ocr.available()
        if ok:
            text = _ocr.ocr_pdf(blob)["text"]
    text = (text or "").strip()
    if len(text) <= MIN_SECTION:
        return doc          # genuinely empty — leave it honestly empty
    doc["sections"] = [{"no": "1", "title": (doc.get("title") or "")[:180],
                        "text": text, "chars": len(text)}]
    doc["structureFamily"] = FULLTEXT
    doc["method"] = (doc.get("method") or "") + " · full-text fallback (no numbered structure)"
    doc["chars"] = len(text)
    return doc


def extract_validated(con, reg) -> bool:
    """ingest_backlog.extract_validated, plus the fallback above.

    Kept here rather than patched into ingest_backlog so the backlog runner —
    which works on official, structured instruments — keeps its own behaviour.
    """
    import extract_pdf_text as X
    from regulatory_ingestion import pipeline
    rid = reg["id"]
    ext_f = X.OUT_DIR / f"{rid}.json"
    if ext_f.exists():
        try:
            doc = json.loads(ext_f.read_text())
        except (ValueError, OSError):
            doc = None
        if doc and (_has_usable_section(doc) or doc.get("structureFamily") == FULLTEXT):
            # an extraction written before _sanitise existed can still hold NULs,
            # which only fail later, at the INSERT
            if any("\x00" in (s.get("text") or "") for s in doc.get("sections", [])):
                ext_f.write_text(json.dumps(_sanitise(doc), ensure_ascii=False))
            return True
        ext_f.unlink(missing_ok=True)   # re-extract: the fallback may rescue it
    X.OUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        doc = X.extract_one({"id": rid, "title": reg["title"] or rid,
                             "regulatorShort": reg["regulator_short"] or "",
                             "pdfUrl": reg["official_document_url"]})
    except Exception as e:  # noqa: BLE001 — recorded per class, batch continues
        msg = f"{type(e).__name__}: {e}"
        # A scan whose OCR ran out of time is not a failed document: the text
        # layer is genuinely absent and OCR is the answer, it just cannot finish
        # while 8 workers share 4 cores. Record what the pipeline already means
        # by that — OCR_REQUIRED — so a later low-concurrency pass picks it up
        # instead of it being buried as FAILED.
        if isinstance(e, subprocess.TimeoutExpired) or "timed out after" in str(e):
            pipeline.set_status(con, rid, "OCR_REQUIRED")
            pipeline.log(con, rid, "extract", "OCR_REQUIRED", f"OCR timed out: {msg}"[:280])
            con.commit()
            return False
        if "scanned PDF" in str(e):
            pipeline.set_status(con, rid, "OCR_REQUIRED")
            pipeline.log(con, rid, "extract", "OCR_REQUIRED", msg)
        else:
            pipeline.set_status(con, rid, "FAILED_FETCH")
            pipeline.log(con, rid, "download", "FAILED", msg)
        con.commit()
        return False
    if not _has_usable_section(doc):
        doc = _full_text_fallback(doc)
    ext_f.write_text(json.dumps(_sanitise(doc), ensure_ascii=False))
    return True


def ingest_one(d: dict, multi: bool) -> tuple[str, str, float, str]:
    """Runs in a worker process. Returns (id, final status, seconds, detail)."""
    from regulatory_ingestion import pipeline
    t0 = time.time()
    con = _worker_con()
    rid = d["id"]
    try:
        register_one(con, d, multi)
        reg = con.execute("SELECT id, title, regulator_short, official_document_url "
                          "FROM regulations WHERE id=?", (rid,)).fetchone()
        if not extract_validated(con, reg):
            con.commit()
            st = con.execute("SELECT ingestion_status FROM regulations WHERE id=?", (rid,)).fetchone()[0]
            return rid, st or "FAILED", time.time() - t0, ""
        pipeline.process(con, rid)
        st = con.execute("SELECT ingestion_status FROM regulations WHERE id=?", (rid,)).fetchone()[0]
        return rid, st, time.time() - t0, ""
    except Exception as e:  # noqa: BLE001 — one bad PDF must not stop the batch
        try:
            con = _worker_con()          # the failure may BE the connection
            con.rollback()
            pipeline.set_status(con, rid, "FAILED")
            pipeline.log(con, rid, "process", "FAILED", f"{type(e).__name__}: {e}")
            con.commit()
        except Exception:  # noqa: BLE001
            try:
                con.rollback()
            except Exception:  # noqa: BLE001
                pass
        return rid, "FAILED", time.time() - t0, f"{type(e).__name__}: {e}"[:300]


def empty_ones(con, rows: list[dict]) -> list[dict]:
    """Already-ingested documents that produced no chunk-eligible section.

    They were ingested before the full-text fallback existed, so they sit in the
    database with nothing a search can retrieve. Their stale extraction JSON is
    removed here so the fallback actually runs on the re-processing.
    """
    ids = {r[0] for r in con.execute(
        """SELECT g.id FROM regulations g
            WHERE g.id LIKE ?
              AND g.ingestion_status IN ('MAPPED', 'STRUCTURED')
              AND NOT EXISTS (SELECT 1 FROM sections s
                               WHERE s.regulation_id = g.id
                                 AND length(s.section_text) > ?)""",
        ("tl-%", MIN_SECTION)).fetchall()}
    out = [d for d in rows if d["id"] in ids and (DOCS_DIR / f"{d['id']}.pdf").exists()]
    for d in out:
        (EXTRACTED / f"{d['id']}.json").unlink(missing_ok=True)
    return out


def pending(con, rows: list[dict], retry_failed: bool) -> list[dict]:
    done_states = ("MAPPED", "OCR_REQUIRED") if retry_failed else \
                  ("MAPPED", "OCR_REQUIRED", "FAILED", "FAILED_FETCH")
    marks = ",".join("?" for _ in done_states)
    done = {r[0] for r in con.execute(
        f"SELECT id FROM regulations WHERE id LIKE ? AND ingestion_status IN ({marks})",
        ("tl-%",) + done_states).fetchall()}
    return [d for d in rows if d["id"] not in done and (DOCS_DIR / f"{d['id']}.pdf").exists()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", type=int, default=1,
                    help="how many shard processes are running in total")
    ap.add_argument("--shard", type=int, default=0,
                    help="which shard this process is (0-based); it takes every "
                         "Nth pending document")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--follow", action="store_true",
                    help="keep polling for newly linked PDFs until all manifest rows are done")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--ocr-pass", action="store_true",
                    help="re-process the documents parked as OCR_REQUIRED, with OCR enabled; "
                         "run few shards so tesseract finishes inside its timeout")
    ap.add_argument("--redo-empty", action="store_true",
                    help="re-process documents already ingested with no chunk-eligible "
                         "section, so the full-text fallback applies to them")
    ap.add_argument("--poll", type=int, default=120)
    ap.add_argument("--gate-drift-ok", action="store_true",
                    help="keep using the gate file after the corpus has grown past the "
                         "loader's tolerance; the drift is printed to the log")
    ap.add_argument("--gate-file", required=True,
                    help="precision gate from gate_offboard.py --compute; loaded once, "
                         "checked against the current corpus, frozen in every worker")
    a = ap.parse_args()

    import gate_offboard
    from regulatory_ingestion.db import connect
    rows = list(csv.DictReader(MANIFEST.open(encoding="utf-8-sig")))
    per_article: dict[str, int] = {}
    for d in rows:
        per_article[d["article_id"]] = per_article.get(d["article_id"], 0) + 1
    con = connect()
    names = [r[0] for r in con.execute("SELECT name FROM company_entities").fetchall()]
    try:
        generic = gate_offboard.load(con, Path(a.gate_file), names)
    except SystemExit as e:
        # The loader refuses a gate whose corpus has moved more than ~2%. Over a
        # 27,000-document ingest the corpus moves past that every few minutes,
        # and a shard restarted at hour six would simply die. This batch is
        # judged by ONE gate, frozen at the corpus the batch started from, which
        # is what frozen_precision_gate is for — but say so out loud, with the
        # numbers, so the choice is visible in the log rather than assumed.
        if not a.gate_drift_ok:
            raise
        g = json.loads(Path(a.gate_file).read_text())
        corpus = con.execute(
            "SELECT COUNT(DISTINCT regulation_id) FROM obligations").fetchone()[0]
        print(f"{_now()}  gate drift accepted (--gate-drift-ok): computed against "
              f"{g['corpus']} regulations, corpus now {corpus}; "
              f"{len(g['generic'])} generic names, frozen for this batch. ({e})", flush=True)
        generic = set(g["generic"])
    con.commit()

    _init_worker(generic, not a.ocr_pass)

    # One process, one shard. Parallelism comes from running several of these
    # (run_teamlease.sh), NOT from a worker pool inside one process: a pool of 8
    # lost every worker at document 400 and the parent then waited on futures
    # that could never arrive — five and a half hours of nothing, with no error.
    # Independent processes cannot deadlock each other, and a shard that dies is
    # restarted by the supervisor and simply re-reads what is still pending.
    tally: dict[str, int] = {}
    t_start = time.time()
    seen: set[str] = set()
    while True:
        if a.redo_empty:
            found = empty_ones(con, rows)
        elif a.ocr_pass:
            found = ocr_backlog(con, rows)
        else:
            found = pending(con, rows, a.retry_failed)
        con.commit()
        todo = [d for i, d in enumerate(found)
                if i % a.shards == a.shard and d["id"] not in seen]
        if a.limit:
            todo = todo[:max(0, a.limit - len(seen))]
        if todo:
            print(f"{_now()}  shard {a.shard}/{a.shards}: {len(todo)} documents", flush=True)
            for d in todo:
                seen.add(d["id"])
                rid, st, secs, detail = ingest_one(d, per_article[d["article_id"]] > 1)
                tally[st] = tally.get(st, 0) + 1
                done = sum(tally.values())
                rate = done / max(1.0, time.time() - t_start) * 3600
                print(f"[{done}] {rid:<22} {st:<13} {secs:6.1f}s  ({rate:.0f}/h) {detail}", flush=True)
        if (a.limit and len(seen) >= a.limit) or not a.follow:
            break
        if not todo:
            if not pending(con, rows, a.retry_failed):
                break
            time.sleep(a.poll)

    print(json.dumps({"shard": a.shard, "tally": tally,
                      "seconds": round(time.time() - t_start, 1)}))


if __name__ == "__main__":
    main()
