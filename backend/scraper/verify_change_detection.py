#!/usr/bin/env python3
"""
End-to-end proof that section-level change detection works on a REAL document.

WHY THIS SCRIPT EXISTS
----------------------
test_version_diff.py proves the diff algorithm using real text with a synthetic
edit. That demonstrates the mechanism but not the product: it never shows that
this system can take two real copies of a real regulation and report what the
regulator actually changed.

This does. It fetches two genuine archived copies of an official RBI PDF from
the Internet Archive, runs them through the SAME production code path the
nightly watcher uses -- pypdf -> parse_structure -> versions.capture ->
versions.compare -- and prints the sections that actually moved.

NOTHING IS FABRICATED. Both inputs are bytes RBI served. The only thing this
script supplies is the pair; every word of the diff comes from the documents.

It writes to a scratch SQLite database by default, so production history is
untouched. Pass --persist to record the result against the real regulation.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import pathlib
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))

from extract_pdf_text import parse_structure          # noqa: E402
from regulatory_ingestion import versions as V        # noqa: E402

WAYBACK = "https://web.archive.org/web/{ts}id_/{url}"   # id_ = original bytes, unrewritten
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 Chrome/126 Safari/537.36"}


def fetch(url: str, ts: str | None = None) -> bytes:
    target = WAYBACK.format(ts=ts, url=url) if ts else url
    req = urllib.request.Request(target, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as f:
        data = f.read()
    if not data[:5].startswith(b"%PDF"):
        raise SystemExit(f"not a PDF ({len(data)} bytes) from {target}")
    return data


def sections_of(pdf: bytes) -> list[dict]:
    from pypdf import PdfReader
    text = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages)
    if len(text.strip()) < 400:
        raise SystemExit("extracted text too short — this copy needs OCR")
    return parse_structure(text)["sections"]


def as_iso(ts: str | None) -> str | None:
    """Wayback stamps look like 20250517233414. That is the date the copy is FROM."""
    if not ts:
        return None
    return datetime.strptime(ts, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc).isoformat(timespec="seconds")


def store(con, rid, secs, pdf, url, ts):
    """
    Capture a version, or find the one already holding this content.

    capture() returns None when the content is already stored — which is the
    normal case for the newer copy, since the live document is what was
    ingested. That is not a failure: it is the version we want to diff against,
    so look it up rather than giving up.
    """
    import hashlib
    vid = V.capture(con, rid, secs,
                    document_hash=hashlib.sha256(pdf).hexdigest(),
                    captured_at=as_iso(ts), source_url=url,
                    retrieved_from="INTERNET_ARCHIVE" if ts else "REGULATOR")
    if vid is not None:
        return vid, True
    key = V._key_h("\n".join((x.get("text") or "").strip() for x in secs
                              if (x.get("text") or "").strip()))
    row = con.execute("SELECT id FROM document_versions WHERE regulation_id=? AND content_hash=?",
                      (rid, key)).fetchone()
    return (row[0] if row else None), False


def scratch_db() -> sqlite3.Connection:
    """A throwaway mirror of the real schema, so production history is untouched."""
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    schema = V.SCHEMA.replace(
        "REFERENCES regulations(id) ON DELETE CASCADE", "")
    con.execute("CREATE TABLE regulations (id TEXT PRIMARY KEY)")
    con.executescript(schema)
    return con


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="the official document URL")
    ap.add_argument("--old", required=True, help="Wayback timestamp of the older copy")
    ap.add_argument("--new", help="Wayback timestamp of the newer copy; omit to use the LIVE document")
    ap.add_argument("--rid", default="verify", help="regulation id to record against")
    ap.add_argument("--persist", action="store_true",
                    help="write to the production database instead of a scratch one")
    ap.add_argument("--max-show", type=int, default=8)
    a = ap.parse_args()

    print("SOURCE".ljust(12), a.url)
    print("OLD COPY".ljust(12), f"Internet Archive snapshot {a.old}")
    print("NEW COPY".ljust(12), f"Internet Archive snapshot {a.new}" if a.new else "live from the regulator")
    print()

    old_pdf = fetch(a.url, a.old)
    new_pdf = fetch(a.url, a.new) if a.new else fetch(a.url)
    print(f"  old: {len(old_pdf):>9,} bytes  sha256 {hashlib.sha256(old_pdf).hexdigest()[:16]}")
    print(f"  new: {len(new_pdf):>9,} bytes  sha256 {hashlib.sha256(new_pdf).hexdigest()[:16]}")
    if hashlib.sha256(old_pdf).digest() == hashlib.sha256(new_pdf).digest():
        print("\nIdentical bytes — nothing to compare. Pick two different snapshots.")
        return 2

    old_secs, new_secs = sections_of(old_pdf), sections_of(new_pdf)
    print(f"\n  parsed {len(old_secs)} sections from the old copy, {len(new_secs)} from the new")

    if a.persist:
        from regulatory_ingestion.db import connect
        con = connect()
        print(f"  PERSISTING to the production database as '{a.rid}'")
    else:
        con = scratch_db()
        con.execute("INSERT INTO regulations VALUES (?)", (a.rid,))

    v1, new1 = store(con, a.rid, old_secs, old_pdf, a.url, a.old)
    v2, new2 = store(con, a.rid, new_secs, new_pdf, a.url, a.new)
    if v1 is None or v2 is None or v1 == v2:
        print("\nThe extracted TEXT is identical even though the PDF bytes differ. "
              "That is a re-issued file, not a regulatory change.")
        return 2
    if a.persist:
        for vid, fresh, which in ((v1, new1, "older"), (v2, new2, "newer")):
            print(f"  {which} copy -> version {vid} ({'stored now' if fresh else 'already held'})")

    # Order by date, never by insertion order: the archived copy is inserted
    # last but belongs first, and a backwards diff reports every insertion as a
    # deletion.
    order = {r["id"]: r["captured_at"] for r in V.versions(con, a.rid)}
    lo, hi = sorted((v1, v2), key=lambda v: order.get(v) or "")
    changes = V.compare(con, a.rid, lo, hi, persist=a.persist)
    wording = [c for c in changes if c["change_class"] == "WORDING"]
    renum = len(changes) - len(wording)
    print(f"\n{'='*74}")
    print(f"RESULT: {len(changes)} section(s) differ between the two real copies")
    print(f"        {len(wording):>3} changed in WORDING      <- what a reviewer must read")
    print(f"        {renum:>3} renumbered only        <- footnote/cross-reference shift")
    print("="*74)

    wording.sort(key=lambda c: -(c["words_added"] + c["words_removed"]))
    for c in wording[:a.max_show]:
        print(f"\nSection {c['section_number']}  [{c['change_type']}]  "
              f"+{c['words_added']} / -{c['words_removed']} words")
        for run in c["diff_runs"]:
            if run["type"] == "equal":
                continue
            mark = "+" if run["type"] == "added" else "-"
            print(f"    {mark} {run['text'].strip()[:200]}")
    if len(wording) > a.max_show:
        print(f"\n  … {len(wording) - a.max_show} more section(s) with changed wording not shown")

    if not a.persist:
        print("\n(scratch database — production history untouched; pass --persist to record)")
    return 0 if changes else 1


if __name__ == "__main__":
    raise SystemExit(main())
