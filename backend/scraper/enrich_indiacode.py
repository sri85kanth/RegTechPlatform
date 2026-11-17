"""
Recover document URLs for India Code regulations.

THE GAP
-------
India Code is the largest single source — 845 of 1,759 regulations — and none of
them carry a document URL. The discovery parser records the DSpace *handle page*
but never follows it to the PDF, so 48% of the library is a title with nothing
behind it. No amount of extraction work fixes that; the URL has to be recovered
first.

HOW
---
India Code runs DSpace. Each handle page links to one or more bitstreams — the
actual Act PDFs. This walks the handles, finds the bitstream, and records it.

    handle page  →  <a href="/bitstream/123456789/1362/1/a1872-01.pdf">  →  pdfUrl

STATUS AT TIME OF WRITING
-------------------------
indiacode.nic.in serves its static root but its DSpace application returns
nothing — handle pages and the site's own browse endpoint both time out. This
script is therefore written and NOT verified against the live site. It records
every attempt in source_checks, so when the site recovers the run simply works
and the failures are visible in the meantime rather than silent.

    python enrich_indiacode.py --limit 50          # try 50
    python enrich_indiacode.py --probe             # is the site back up?
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

from regulatory_ingestion.db import connect

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 Chrome/126 Safari/537.36"}
BASE = "https://www.indiacode.nic.in"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# DSpace exposes the file under /bitstream/<handle>/<seq>/<filename>
BITSTREAM = re.compile(r"/bitstream/[^\"'\s>]+\.pdf", re.I)


def probe(timeout: int = 20) -> dict:
    """Is the DSpace application actually answering? Root alone is not enough."""
    out = {}
    for name, url in (("root", f"{BASE}/"), ("browse", f"{BASE}/browse?type=shorttitle")):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            out[name] = f"HTTP {r.status_code} · {len(r.content)}b"
        except Exception as e:
            out[name] = type(e).__name__
    out["usable"] = out.get("browse", "").startswith("HTTP 200")
    return out


def find_pdf(handle_url: str, timeout: int = 30) -> tuple[str | None, str]:
    """Returns (pdf_url, note). Never raises — the note carries the reason."""
    try:
        r = requests.get(handle_url, headers=HEADERS, timeout=timeout)
    except Exception as e:
        return None, f"{type(e).__name__}: {str(e)[:70]}"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"

    soup = BeautifulSoup(r.text, "html.parser")
    hrefs = [a.get("href", "") for a in soup.find_all("a", href=True)]
    hits = [h for h in hrefs if BITSTREAM.search(h or "")]
    if not hits:
        # some records link the file only through an onclick or a data attribute
        m = BITSTREAM.search(r.text)
        if m:
            hits = [m.group(0)]
    if not hits:
        return None, "no bitstream link on the handle page"

    # prefer the English-language Act over regional-language copies
    best = sorted(hits, key=lambda h: (0 if re.search(r"a\d{4}", h, re.I) else 1, len(h)))[0]
    return (best if best.startswith("http") else BASE + best), "found"


def record(con, rid: str, outcome: str, note: str, url: str | None) -> None:
    """Every attempt is logged, so an outage is visible rather than silent."""
    con.execute(
        """INSERT INTO source_checks (regulation_id, checked_at, source_url, outcome, note)
           VALUES (?,?,?,?,?)""",
        (rid, _now(), url, outcome, note[:380]))


def run(limit: int, delay: float) -> dict:
    con = connect()
    rows = con.execute(
        """SELECT id, title, source_url FROM regulations
           WHERE regulator_short = 'India Code'
             AND (official_document_url IS NULL OR official_document_url = '')
             AND source_url IS NOT NULL AND source_url <> ''
           ORDER BY id LIMIT ?""", (limit,)).fetchall()

    print(f"  {len(rows)} India Code regulation(s) without a document URL\n")
    found = failed = 0
    for n, r in enumerate(rows, 1):
        url, note = find_pdf(r["source_url"])
        if url:
            con.execute("UPDATE regulations SET official_document_url=? WHERE id=?", (url, r["id"]))
            record(con, r["id"], "URL_FOUND", note, url)
            found += 1
            print(f"  [{n}/{len(rows)}] {r['id']}: {url[-58:]}")
        else:
            record(con, r["id"], "URL_NOT_FOUND", note, r["source_url"])
            failed += 1
            if failed <= 5 or failed % 25 == 0:
                print(f"  [{n}/{len(rows)}] {r['id']}: {note}")
        con.commit()
        time.sleep(delay)

    remaining = con.execute(
        """SELECT COUNT(*) FROM regulations WHERE regulator_short='India Code'
           AND (official_document_url IS NULL OR official_document_url='')""").fetchone()[0]
    return {"attempted": len(rows), "found": found, "failed": failed, "remaining": remaining}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--probe", action="store_true")
    a = ap.parse_args()

    if a.probe:
        p = probe()
        for k, v in p.items():
            print(f"  {k:<8} {v}")
        sys.exit(0 if p["usable"] else 1)

    p = probe()
    if not p["usable"]:
        print("  India Code's DSpace application is not responding "
              f"(root: {p['root']}, browse: {p['browse']}).")
        print("  Nothing to do until it recovers — re-run with --probe to check.")
        sys.exit(1)

    res = run(a.limit, a.delay)
    print(f"\n  found {res['found']}, failed {res['failed']}, "
          f"{res['remaining']} India Code regulations still without a document URL")
