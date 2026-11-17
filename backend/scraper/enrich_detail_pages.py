"""
Recover document URLs from per-regulation detail pages.

THE GAP
-------
945 regulations carry only a source_url. For India Code that URL is a DSpace
handle (see enrich_indiacode.py — the site is still down). But RBI FEMA
notifications and SEBI regulation pages are ordinary detail pages that link
straight to the official PDF; the discovery parser recorded the page and never
followed it. This walks those pages and records the PDF, nothing more.

WHAT IT WILL NOT DO
-------------------
Only URL patterns that identify ONE regulation are eligible. A listing page is
never treated as a document (standing rule), so TRAI/FSSAI rows whose
source_url is a shared listing are left alone — their fix is discovery, not
resolution. The PDF itself is not downloaded here; ingest_backlog.py does that
with validation.

    python enrich_detail_pages.py --limit 20          # dry run, prints choices
    python enrich_detail_pages.py --limit 200 --apply # write official_document_url
"""
from __future__ import annotations

import argparse
import re
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

import requests

from regulatory_ingestion.db import connect

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 Chrome/126 Safari/537.36"}
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# One regulation per page — the only shapes this script may touch.
ELIGIBLE = [
    re.compile(r"rbi\.org\.in/Scripts/BS_FemaNotifications\.aspx\?Id=\d+", re.I),
    re.compile(r"rbi\.org\.in/Scripts/(BS_ViewMasDirections|NotificationUser|BS_CircularIndexDisplay)\.aspx\?id=\d+", re.I),
    re.compile(r"sebi\.gov\.in/legal/(regulations|acts|rules)/.+\.html", re.I),
]

PDF_HREF = re.compile(r"""href=["']([^"']+\.pdf)["']""", re.I)


def _score(url: str, count: int) -> int:  # count = occurrences on THIS page
    """Rank candidate PDFs: the document beats icons, English beats Hindi."""
    u = url.lower()
    s = count * 2
    if "rbidocs.rbi.org.in" in u or "sebi.gov.in" in u:
        s += 3
    if "/content/pdfs/" in u or "/notification/pdfs/" in u or "/attachdocs/" in u:
        s += 2
    name = u.rsplit("/", 1)[-1]
    if len(name) > 12:
        s += 1
    if "hindi" in u or "/hi/" in u:
        s -= 5
    return s


def resolve(page_url: str, timeout: int = 45) -> tuple[str | None, int, str]:
    """(best pdf url | None, candidate count, note)."""
    r = requests.get(page_url, headers=HEADERS, timeout=timeout)
    if r.status_code != 200:
        return None, 0, f"HTTP {r.status_code}"
    hrefs = [urljoin(page_url, h) for h in PDF_HREF.findall(r.text)]
    if not hrefs:
        return None, 0, "no .pdf link on page"
    counts: dict[str, int] = {}
    for h in hrefs:
        counts[h] = counts.get(h, 0) + 1
    best = max(counts, key=lambda h: _score(h, counts[h]))
    return best, len(counts), f"{len(counts)} candidate(s)"


def run(limit: int = 0, apply: bool = False, delay: float = 2.0) -> dict:
    """
    TWO passes, learned the hard way twice (SEBI sidebar, then RBI's Utkarsh
    banner): first collect every page's candidates, then reject any PDF that
    appears on more than two DIFFERENT pages — a document shared by many pages
    is site furniture, never a regulation's own text. Scoring runs only on
    what survives.
    """
    con = connect()
    rows = con.execute(
        """SELECT id, source_url FROM regulations g
           WHERE (official_document_url IS NULL OR official_document_url='')
             AND source_url LIKE 'http%'
             AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=g.id)
           ORDER BY id""").fetchall()
    targets = [r for r in rows if any(p.search(r["source_url"]) for p in ELIGIBLE)]
    if limit:
        targets = targets[:limit]
    tally = {"resolved": 0, "no_pdf": 0, "http_error": 0, "furniture_only": 0,
             "eligible": len(targets), "ineligible_left": len(rows) - len(targets)}

    # pass 1 — fetch every page, remember its candidate PDFs
    page_cands: dict[str, dict[str, int]] = {}
    errors: dict[str, str] = {}
    for n, r in enumerate(targets, 1):
        try:
            resp = requests.get(r["source_url"], headers=HEADERS, timeout=45)
            if resp.status_code != 200:
                errors[r["id"]] = f"HTTP {resp.status_code}"
            else:
                counts: dict[str, int] = {}
                for h in PDF_HREF.findall(resp.text):
                    u = urljoin(r["source_url"], h)
                    counts[u] = counts.get(u, 0) + 1
                page_cands[r["id"]] = counts
        except requests.RequestException as e:
            errors[r["id"]] = type(e).__name__
        time.sleep(delay)

    # pass 2 — a URL on >2 different pages is furniture
    seen_on: dict[str, int] = {}
    for counts in page_cands.values():
        for u in counts:
            seen_on[u] = seen_on.get(u, 0) + 1
    furniture = {u for u, k in seen_on.items() if k > 2}

    for n, r in enumerate(targets, 1):
        if r["id"] in errors:
            pdf, cands, note = None, 0, errors[r["id"]]
        else:
            counts = {u: c for u, c in page_cands.get(r["id"], {}).items() if u not in furniture}
            dropped = len(page_cands.get(r["id"], {})) - len(counts)
            if counts:
                pdf = max(counts, key=lambda h: _score(h, counts[h]))
                cands, note = len(counts), f"{len(counts)} candidate(s), {dropped} furniture dropped"
            elif page_cands.get(r["id"]):
                pdf, cands, note = None, 0, "only site-furniture PDFs on page"
            else:
                pdf, cands, note = None, 0, "no .pdf link on page"
        if pdf:
            tally["resolved"] += 1
            print(f"  [{n}/{len(targets)}] {r['id']}: {note} -> {pdf[:90]}")
            if apply:
                con.execute("UPDATE regulations SET official_document_url=? WHERE id=?", (pdf, r["id"]))
                con.execute(
                    """INSERT INTO source_checks (regulation_id, checked_at, source_url, http_status, outcome, note)
                       VALUES (?,?,?,?,?,?)""",
                    (r["id"], _now(), r["source_url"], 200, "URL_RESOLVED", f"{note}; chose {pdf}"[:280]))
                con.commit()
        else:
            key = ("http_error" if note.startswith("HTTP") or note.endswith("Error")
                   else "furniture_only" if "furniture" in note else "no_pdf")
            tally[key] += 1
            print(f"  [{n}/{len(targets)}] {r['id']}: FAILED — {note}")
            if apply:
                con.execute(
                    """INSERT INTO source_checks (regulation_id, checked_at, source_url, http_status, outcome, note)
                       VALUES (?,?,?,?,?,?)""",
                    (r["id"], _now(), r["source_url"], None, "URL_UNRESOLVED", note[:280]))
                con.commit()
    return tally


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--delay", type=float, default=2.0)
    a = ap.parse_args()
    print(run(a.limit, a.apply, a.delay))
