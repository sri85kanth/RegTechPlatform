"""
Recover India Code Acts through the Internet Archive.

India Code's DSpace has been dead on every route for weeks (handle, bitstream,
REST, OAI — one identical error page), and it is 845 regulations, 48% of the
library. The Wayback Machine crawled it for years. This resolver:

  1. asks the CDX API for a snapshot of the Act's handle page, parses the
     archived page for its /bitstream/...pdf link;
  2. failing that, asks CDX for any archived bitstream under the handle's own
     path prefix — the DSpace layout guarantees /bitstream/<prefix>/<item>/...;
  3. fetches the PDF bytes from the archive (the `id_` form, original bytes),
     validates %PDF, and caches them where the pipeline expects the file.

PROVENANCE, HONESTLY
--------------------
official_document_url is set to the LIVE indiacode bitstream URL — the
canonical source — while source_checks records that the bytes came from a
dated Wayback snapshot and must be re-verified against the live site when it
returns (the nightly probe already tells us when that happens). Nothing here
invents a document: no snapshot, no row.

    python wayback_indiacode.py --limit 20            # trial
    python wayback_indiacode.py --apply               # the backlog
"""
from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
import requests

from regulatory_ingestion import pipeline
from regulatory_ingestion.db import connect

HEADERS = {"User-Agent": "company-brain-research/1.0 (regulatory archive recovery; contact: admin)"}
CDX = "https://web.archive.org/cdx/search/cdx"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
BITSTREAM = re.compile(r"/bitstream/[^\"'\s>]+?\.pdf", re.I)


def _prefer_english(paths: list[str]) -> list[str]:
    """DSpace items carry aYYYY-N.pdf (English) beside HYYYY-N.pdf (Hindi)."""
    def rank(u: str) -> tuple:
        name = u.rsplit("/", 1)[-1].lower()
        return (name.startswith("h"), "hindi" in name, len(name))
    return sorted(dict.fromkeys(paths), key=rank)
MIN_PDF = 10_000          # an Act under 10 KB is a stub, not a statute


def _cdx(params: dict, timeout: int = 40) -> list[list[str]]:
    r = requests.get(CDX, params={"output": "json", "filter": "statuscode:200", **params},
                     headers=HEADERS, timeout=timeout)
    if r.status_code != 200:
        return []
    try:
        rows = r.json()
    except ValueError:
        return []
    return rows[1:] if rows else []


def _fetch_archived(ts: str, original: str, timeout: int = 90) -> bytes | None:
    url = f"https://web.archive.org/web/{ts}id_/{original}"
    r = requests.get(url, headers=HEADERS, timeout=timeout)
    if r.status_code == 200 and r.content.startswith(b"%PDF") and len(r.content) >= MIN_PDF:
        return r.content
    return None


def resolve_one(handle_url: str, delay: float) -> tuple[str, str, bytes] | None:
    """
    (live bitstream url, snapshot ts, pdf bytes) or None.

    Candidates from BOTH the archived handle page and the CDX bitstream-prefix
    query are pooled first, then ranked English-first — an Act whose page
    snapshot only lists the Hindi PDF still gets its English sibling when the
    archive holds one; Hindi (equally official) is the honest fallback.
    """
    pool: list[tuple[str, str]] = []                     # (ts, live url)
    for row in _cdx({"url": handle_url, "limit": "-3"}):          # newest 3 page snapshots
        ts = row[1]
        try:
            page = requests.get(f"https://web.archive.org/web/{ts}/{handle_url}",
                                headers=HEADERS, timeout=60)
        except requests.RequestException:
            continue
        time.sleep(delay)
        if page.status_code != 200:
            continue
        for path in BITSTREAM.findall(page.text):
            live = f"https://www.indiacode.nic.in{path}" if path.startswith("/") else path
            live = re.sub(r"^https?://web\.archive\.org/web/[^/]+/", "", live)
            pool.append((ts, live))
        if pool:
            break
    m = re.search(r"/handle/(\d+)/(\d+)", handle_url)
    if m:
        prefix = f"indiacode.nic.in/bitstream/{m.group(1)}/{m.group(2)}/"
        for row in _cdx({"url": prefix, "matchType": "prefix", "limit": "20", "collapse": "urlkey"}):
            if row[2].lower().endswith(".pdf"):
                pool.append((row[1], row[2]))
    ranked = _prefer_english([u for _, u in pool])
    for live in ranked:
        ts = next(t for t, u in pool if u == live)
        pdf = _fetch_archived(ts, live)
        time.sleep(delay)
        if pdf:
            return live, ts, pdf
    return None


def run(limit: int = 0, apply: bool = False, delay: float = 1.5) -> dict:
    con = connect()
    rows = con.execute(
        """SELECT id, source_url FROM regulations g
           WHERE source_url LIKE '%indiacode.nic.in/handle/%'
             AND (official_document_url IS NULL OR official_document_url='')
             AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=g.id)
           ORDER BY id""").fetchall()
    if limit:
        rows = rows[:limit]
    tally = {"targets": len(rows), "resolved": 0, "no_snapshot": 0, "errors": 0}
    for n, r in enumerate(rows, 1):
        cached = pipeline.DOCS_DIR / f"{r['id']}.pdf"
        if cached.exists() and cached.stat().st_size >= MIN_PDF:
            tally["resolved"] += 1
            continue
        try:
            got = resolve_one(r["source_url"], delay)
        except requests.RequestException:
            tally["errors"] += 1
            time.sleep(delay * 2)
            continue
        if not got:
            tally["no_snapshot"] += 1
            print(f"[{n}/{len(rows)}] {r['id']}: no usable snapshot")
            if apply:
                con.execute(
                    """INSERT INTO source_checks (regulation_id, checked_at, source_url, http_status, outcome, note)
                       VALUES (?,?,?,?,?,?)""",
                    (r["id"], _now(), r["source_url"], None, "URL_UNRESOLVED",
                     "no usable Wayback snapshot of handle page or bitstream prefix"))
                con.commit()
            continue
        live, ts, pdf = got
        tally["resolved"] += 1
        print(f"[{n}/{len(rows)}] {r['id']}: snapshot {ts} · {len(pdf)//1024} KB · {live[:80]}")
        if apply:
            pipeline.DOCS_DIR.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(pdf)
            con.execute("UPDATE regulations SET official_document_url=? WHERE id=?", (live, r["id"]))
            con.execute(
                """INSERT INTO source_checks (regulation_id, checked_at, source_url, http_status, outcome, note)
                   VALUES (?,?,?,?,?,?)""",
                (r["id"], _now(), r["source_url"], 200, "URL_RESOLVED",
                 f"bytes fetched from Wayback snapshot {ts}; canonical URL recorded; "
                 f"re-verify hash against live indiacode when it returns"[:280]))
            con.commit()
    return tally


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--delay", type=float, default=1.5)
    a = ap.parse_args()
    print(json.dumps(run(a.limit, a.apply, a.delay)))
