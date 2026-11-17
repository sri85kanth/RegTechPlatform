"""
Source watcher — the missing half of change detection.

WHY DETECTION HAS NEVER FIRED
-----------------------------
Comparing versions requires two crawls of the same document at different times.
Nothing ever performed the second crawl, so `section_changes` was empty not
because the code was broken but because it was never given anything to compare.
This is that second crawl.

WHAT A CHECK DOES
-----------------
    re-fetch the official PDF
      -> hash it
         -> identical?  UNCHANGED
         -> different?  re-extract and capture a version, then
              no prior version   -> BASELINE_CAPTURED   (NOT a change)
              unreadable copy    -> CHANGED_UNVERIFIED  (bytes moved, diff unknown)
              prior version      -> CHANGED, with real rows in section_changes

Every outcome is recorded. A source checked and found unchanged is a FACT worth
storing — it is what lets the UI say "verified unchanged on 3 Sept" instead of
the much weaker "no change detected".

BASELINE_CAPTURED EXISTS BECAUSE OF A REAL FALSE POSITIVE
---------------------------------------------------------
The original ingest stored a document_hash but never captured a section
snapshot. So the first watcher pass finds the hash "different", captures the
first comparable version, and used to report CHANGED with zero changes — a
regulation nobody had ever compared, shown to a reviewer as "Change detected".
That is the single worst failure mode for this product, so a first capture is
now its own outcome and classifies as INSUFFICIENT_HISTORY.

POLITENESS
----------
These are government servers that already rate-limited this crawler once. Checks
are spread out, backed off, and capped per run.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import sqlite3
import time
from datetime import datetime, timezone

import requests

from . import source_urls

HERE = pathlib.Path(__file__).parent.parent
DOCS = HERE / "output" / "documents"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 Chrome/126 Safari/537.36"}
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

def init(con: sqlite3.Connection) -> sqlite3.Connection:
    """
    source_checks is owned by change_status.py — the five-state classifier reads
    `outcome` from it to justify CHECKED_UNCHANGED. This module writes into that
    same table rather than a parallel one, and only ADDS the two columns it needs.
    """
    from . import change_status
    change_status.init(con)
    cols = {r[1] for r in con.execute("PRAGMA table_info(source_checks)")}
    if "changes_found" not in cols:
        con.execute("ALTER TABLE source_checks ADD COLUMN changes_found INTEGER DEFAULT 0")
    con.executescript(
        "CREATE INDEX IF NOT EXISTS idx_schecks_at ON source_checks(checked_at);")
    con.commit()
    return con


# What the company has to follow is checked first. With ~30,000 documents and a
# nightly pass of a few dozen, plain oldest-first order reaches any one document
# about once in 500 nights — so 398 of the 459 regulations that apply to the
# hospital had never been checked at all. Applicable ones come first, then the
# rest of its own sector, and a share of every pass still goes to everything else
# so no document is left behind for good.
APPLIES = ("APPLICABLE", "CONDITIONAL")
OWN_SECTORS = ("Healthcare & Hospitals", "Healthcare")
PRIORITY_SHARE = 2 / 3


def due(con, max_age_hours: int = 24, limit: int = 25) -> list[str]:
    """
    Which documents to re-check. Only regulations we actually hold a document
    for — there is nothing to compare otherwise — and none checked within
    `max_age_hours`. Within that: what applies to the company, then its own
    sector, then everything else; never-checked before oldest-checked in each.
    """
    init(con)
    cutoff = datetime.fromtimestamp(time.time() - max_age_hours * 3600, timezone.utc).isoformat(timespec="seconds")
    # The alias cannot be used inside an ORDER BY expression in Postgres, so the
    # ordering is done in an outer query over a named subselect.
    base = """SELECT rid, last_checked, tier FROM (
                SELECT d.regulation_id AS rid,
                       (SELECT MAX(checked_at) FROM source_checks s
                         WHERE s.regulation_id = d.regulation_id) AS last_checked,
                       CASE WHEN r.applicability IN (?, ?) THEN 0
                            WHEN r.sector IN (?, ?) THEN 1
                            ELSE 2 END AS tier
                FROM documents d
                LEFT JOIN regulations r ON r.id = d.regulation_id
                WHERE d.source_url IS NOT NULL AND d.source_url <> ''
              ) t
              WHERE (last_checked IS NULL OR last_checked < ?) {extra}
              ORDER BY {order}
              LIMIT ?"""
    args = (*APPLIES, *OWN_SECTORS, cutoff)
    own = "tier, (last_checked IS NOT NULL), last_checked ASC"
    oldest = "(last_checked IS NOT NULL), last_checked ASC"
    pick = lambda extra, order, n: [r["rid"] for r in con.execute(base.format(extra=extra, order=order), (*args, n)).fetchall()]

    out = pick("AND tier < 2", own, max(1, round(limit * PRIORITY_SHARE))) if limit > 0 else []
    # the rest of the pass goes to everything else, oldest first …
    out += pick("AND tier = 2", oldest, max(0, limit - len(out))) if limit > len(out) else []
    # … and if nothing else is due, the company's own documents fill it up
    if len(out) < limit:
        chosen = set(out)
        out += [rid for rid in pick("AND tier < 2", own, limit + len(out)) if rid not in chosen][: limit - len(out)]
    return out


def _record(con, rid, outcome, *, http=None, chash=None, prev=None, detail="", changes=0):
    url = con.execute(
        "SELECT source_url FROM documents WHERE regulation_id=?", (rid,)).fetchone()
    con.execute(
        """INSERT INTO source_checks (regulation_id, checked_at, source_url, outcome,
             http_status, content_hash, previous_hash, note, changes_found)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (rid, _now(), url["source_url"] if url else None, outcome, http, chash, prev,
         detail[:400], changes))
    con.commit()
    return {"regulation_id": rid, "outcome": outcome, "detail": detail, "changesFound": changes}


def _sections_of(content: bytes, *, allow_ocr: bool) -> tuple[list | None, str]:
    """
    A downloaded PDF's sections, by the one extraction every version goes through.
    (None, why) when it cannot be read — a scan with no OCR, or a failed parse.
    """
    try:
        import io
        import sys
        from pypdf import PdfReader
        sys.path.insert(0, str(HERE))
        from extract_pdf_text import parse_structure

        text = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(content)).pages)
        if len(text.strip()) < 400:
            if not allow_ocr:
                return None, "the copy is a scan"
            from . import ocr as _ocr
            ok, why = _ocr.available()
            if not ok:
                return None, f"the new copy is a scan and {why}"
            text = _ocr.ocr_pdf(content)["text"]
        return parse_structure(text)["sections"], ""
    except Exception as e:
        return None, f"re-extraction failed: {type(e).__name__}: {e}"


def check(con, rid: str, *, timeout: int = 90) -> dict:
    """Re-fetch one document and compare. Never raises — the outcome is the result."""
    init(con)
    doc = con.execute(
        "SELECT source_url, document_hash, storage_path FROM documents WHERE regulation_id=?",
        (rid,)).fetchone()
    if not doc or not doc["source_url"]:
        return _record(con, rid, "NO_URL", detail="no stored document URL to re-check")

    # conditional GET: a 304 answers the question for free and is kinder to
    # servers that have rate-limited this crawler before
    con.execute("""CREATE TABLE IF NOT EXISTS source_cache (
        regulation_id TEXT PRIMARY KEY, etag TEXT, last_modified TEXT)""")
    cache = con.execute("SELECT etag, last_modified FROM source_cache WHERE regulation_id=?",
                        (rid,)).fetchone()
    cond = dict(HEADERS)
    if cache and cache["etag"]:
        cond["If-None-Match"] = cache["etag"]
    if cache and cache["last_modified"]:
        cond["If-Modified-Since"] = cache["last_modified"]

    # the stored URL is the record of where the document came from; a source that
    # has moved its files is fetched from where they are now (see source_urls)
    fetch_url = source_urls.fetchable(doc["source_url"])
    via = " (fetched through TeamLease's current file address)" if fetch_url != doc["source_url"] else ""
    try:
        r = requests.get(fetch_url, headers=cond, timeout=timeout)
        if r.status_code == 304:
            return _record(con, rid, "UNCHANGED", http=304, chash=doc["document_hash"],
                           prev=doc["document_hash"],
                           detail="HTTP 304 — the server's validators say unchanged; nothing downloaded.")
        if r.status_code == 200 and (r.headers.get("ETag") or r.headers.get("Last-Modified")):
            con.execute("""INSERT INTO source_cache (regulation_id, etag, last_modified)
                           VALUES (?,?,?)
                           ON CONFLICT (regulation_id) DO UPDATE SET
                             etag=EXCLUDED.etag, last_modified=EXCLUDED.last_modified""",
                        (rid, r.headers.get("ETag"), r.headers.get("Last-Modified")))
            con.commit()
        if r.status_code != 200:
            return _record(con, rid, "UNREACHABLE", http=r.status_code,
                           detail=f"HTTP {r.status_code}{via}")
        if not r.content[:5].startswith(b"%PDF"):
            return _record(con, rid, "UNREACHABLE", http=r.status_code,
                           detail=f"response was not a PDF (portal page or redirect){via}")
    except Exception as e:
        return _record(con, rid, "UNREACHABLE", detail=f"{type(e).__name__}: {str(e)[:180]}{via}")

    new_hash = hashlib.sha256(r.content).hexdigest()
    old_hash = doc["document_hash"]

    if new_hash == old_hash:
        # A verified no-change is a real finding, not an absence of one.
        # With no comparable version yet, this copy becomes one now. Otherwise the
        # first real change would arrive with nothing behind it and be recorded as
        # BASELINE_CAPTURED — the change itself lost. Extracted by the same code a
        # later copy will be, so the two can only differ where the words do.
        from . import versions as V
        V.init(con)
        saved = ""
        if not V.versions(con, rid):
            sections, _why = _sections_of(r.content, allow_ocr=False)
            if sections and V.capture(con, rid, sections, document_hash=new_hash, source_url=fetch_url):
                saved = " Saved as the first comparable version, so a later change can be compared."
        return _record(con, rid, "UNCHANGED", http=200, chash=new_hash, prev=old_hash,
                       detail=f"Byte-identical to the stored copy.{saved}{via}")

    # ---- the document actually moved ------------------------------------
    DOCS.mkdir(parents=True, exist_ok=True)
    (DOCS / f"{rid}.pdf").write_bytes(r.content)

    sections, why = _sections_of(r.content, allow_ocr=True)
    if sections is None:
        return _record(con, rid, "CHANGED_UNVERIFIED", http=200, chash=new_hash, prev=old_hash,
                       detail=f"Source bytes changed but {why}. No section comparison was performed.")

    from . import versions as V
    V.init(con)
    prior = V.versions(con, rid)
    new_vid = V.capture(con, rid, sections, document_hash=new_hash, source_url=fetch_url)

    if new_vid is None:
        # PDF bytes differ but the extracted text is identical — a re-issue with
        # new metadata, not a regulatory change. Saying otherwise would be a
        # false positive of exactly the kind this system must not produce.
        con.execute("UPDATE documents SET document_hash=? WHERE regulation_id=?", (new_hash, rid))
        con.commit()
        return _record(con, rid, "UNCHANGED", http=200, chash=new_hash, prev=old_hash,
                       detail="PDF bytes differ but the extracted text is identical "
                              "(re-issued file, no wording change).")

    con.execute("UPDATE documents SET document_hash=? WHERE regulation_id=?", (new_hash, rid))
    con.commit()

    if not prior:
        # NOT A CHANGE. The stored document_hash came from the original ingest,
        # which never captured a section snapshot, so this crawl is the FIRST
        # comparable version. There is nothing behind it to diff against, and
        # reporting CHANGED here is a false positive of exactly the kind this
        # system exists to avoid — it puts "Change detected" on a regulation
        # nobody has ever compared. A second crawl is what makes detection
        # possible; until then the honest state is INSUFFICIENT_HISTORY.
        return _record(con, rid, "BASELINE_CAPTURED", http=200, chash=new_hash, prev=old_hash,
                       detail="First comparable version captured. No prior version exists, "
                              "so no change is being asserted.")

    changes = V.compare(con, rid, prior[-1]["id"], new_vid, persist=True)
    # Inserting one footnote renumbers every marker after it, so a real
    # amendment of two paragraphs can surface as forty "changed" sections.
    # Reporting the raw count trains reviewers to ignore the alert.
    wording = sum(1 for c in changes if c.get("change_class") == "WORDING")
    renumbered = len(changes) - wording
    res = _record(con, rid, "CHANGED", http=200, chash=new_hash, prev=old_hash,
                  changes=len(changes),
                  detail=(f"{wording} section(s) changed in wording"
                          + (f", {renumbered} renumbered only" if renumbered else "")
                          + "."))
    # Alert immediately. A change found at 2am that waits for a sweep is the
    # exact failure this is meant to remove.
    try:
        from . import notifications as _n
        _n.generate(con)
    except Exception:
        pass          # a notification failure must never lose the detection itself
    return res


def run(con, *, limit: int = 25, delay: float = 3.0, max_age_hours: int = 24,
        progress=print) -> dict:
    """One watcher pass. Safe to schedule; safe to interrupt."""
    init(con)
    ids = due(con, max_age_hours=max_age_hours, limit=limit)
    progress(f"  {len(ids)} document(s) due for a source check")
    tally: dict[str, int] = {}
    changed: list[dict] = []
    for n, rid in enumerate(ids, 1):
        res = check(con, rid)
        tally[res["outcome"]] = tally.get(res["outcome"], 0) + 1
        if res["outcome"] in ("CHANGED", "CHANGED_UNVERIFIED"):
            changed.append(res)
        progress(f"  [{n}/{len(ids)}] {rid}: {res['outcome']} — {res['detail'][:80]}")
        if delay:
            time.sleep(delay)
    return {"checked": len(ids), "outcomes": tally, "changed": changed, "at": _now()}
