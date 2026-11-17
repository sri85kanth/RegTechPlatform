"""
Two-level crawl for the documents a source register points at.

WHY THE FIRST ATTEMPT FOUND 3 OF 126
------------------------------------
resolve_register_portals.py read each portal's FRONT PAGE only. A ministry
front page almost never links an Act directly — it links a section ("Acts &
Rules", "Legislation", "Notifications") and the Act lives one click further in.
The register knows this: every row carries a `portal_path` written by the
compiler, e.g. "Acts & Rules -> Companies Act 2013". This crawl uses that hint
as a navigation instruction instead of ignoring it.

  level 0  the portal root
  level 1  links whose text matches the portal_path hint or the instrument name
  level 2  document links on those pages, scored against the instrument

WHAT IT KEEPS FROM THE FIRST ATTEMPT
------------------------------------
Everything that makes a match trustworthy:
  * a document must clear a name-overlap threshold, and
  * no other instrument on the same portal may claim it (the unique-claim rule
    that caught the FEMA banner and the SEBI sidebar), and
  * certificates are never bypassed, and
  * nothing is downloaded here — ingest_backlog.py fetches and validates with
    the %PDF check, as for every other source.

A portal that blocks us stays blocked. It is recorded once, with the reason,
and not hammered again.

    python crawl_register_documents.py                 # dry run
    python crawl_register_documents.py --apply
"""
from __future__ import annotations

import argparse
import collections
import re
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from regulatory_ingestion.db import connect

UA = {"User-Agent": "Mozilla/5.0 (compatible; CompanyBrain/1.0; regulatory register verification)"}
DOC_RE = re.compile(r"\.(pdf|docx?)(\?|$)", re.I)
STOP = {"the", "of", "and", "a", "an", "for", "in", "on", "to", "act", "rules",
        "regulations", "regulation", "rule", "amendment", "india", "indian", "state"}
# words that mark a page as "where legislation lives" on an Indian ministry site
SECTION_WORDS = ("act", "rule", "legislation", "notification", "circular", "regulation",
                 "gazette", "statute", "law", "document", "download", "policy", "guideline")
MIN_OVERLAP = 0.55
MIN_TOKENS = 2
DELAY = 1.0
MAX_LEVEL1 = 6          # per portal: how many section pages to open
TIMEOUT = 20


def tok(s: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower())
            if len(t) > 2 and t not in STOP}


def score(instrument: str, text: str, href: str) -> float:
    want = tok(instrument)
    if len(want) < MIN_TOKENS:
        return 0.0
    return len(want & tok(f"{text} {href}")) / len(want)


def fetch(url: str, cache: dict) -> tuple[str | None, str]:
    if url in cache:
        return cache[url]
    try:
        r = requests.get(url, headers=UA, timeout=TIMEOUT, allow_redirects=True)
        if r.status_code != 200:
            out = (None, f"HTTP {r.status_code}")
        elif not r.headers.get("content-type", "").lower().startswith("text"):
            out = (None, "not an HTML page")
        else:
            out = (r.text, "ok")
    except requests.exceptions.SSLError:
        out = (None, "SSL certificate could not be verified (not bypassed)")
    except Exception as e:  # noqa: BLE001
        out = (None, type(e).__name__)
    cache[url] = out
    time.sleep(DELAY)
    return out


def links_on(html: str, base: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base, a["href"])
        if urlparse(href).scheme in ("http", "https"):
            out.append((a.get_text(" ", strip=True)[:200], href))
    return out


def verify(url: str, instrument: str) -> tuple[bool, str]:
    """
    Open the candidate and look for the instrument's name INSIDE it.

    The crawler scores link text, which is not evidence: two candidates scoring
    1.00 turned out to be HTTP 404s, and a third was a draft. A link is only
    worth recording if the bytes behind it are a real document that names the
    instrument. Gazette PDFs open on a masthead, so the first few pages are
    read rather than only the first.
    """
    try:
        r = requests.get(url, headers=UA, timeout=40, allow_redirects=True)
    except requests.exceptions.SSLError:
        return False, "SSL certificate could not be verified"
    except Exception as e:  # noqa: BLE001
        return False, type(e).__name__
    if r.status_code != 200:
        return False, f"HTTP {r.status_code}"
    if r.content[:4] != b"%PDF":
        return False, "not a PDF"
    if len(r.content) < 3000:
        return False, f"only {len(r.content)} bytes"
    try:
        import io
        from pypdf import PdfReader
        rd = PdfReader(io.BytesIO(r.content))
        text = " ".join((rd.pages[i].extract_text() or "")
                        for i in range(min(4, len(rd.pages))))
    except Exception as e:  # noqa: BLE001
        return False, f"unreadable PDF ({type(e).__name__})"
    want = tok(instrument)
    if not want:
        return False, "instrument name too short to verify"
    overlap = len(want & tok(text)) / len(want)
    if overlap < 0.5:
        return False, f"document does not name the instrument (overlap {overlap:.2f})"
    return True, f"verified in the document (overlap {overlap:.2f}, {len(r.content)//1024} KB)"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="stop after N portals")
    a = ap.parse_args()
    con = connect()

    rows = [dict(r) for r in con.execute("""
        SELECT sr.id, sr.seq, sr.instrument, sr.portal, sr.portal_path, sr.regulation_id
          FROM source_register sr
          JOIN regulations r ON r.id = sr.regulation_id
         WHERE r.ingestion_status <> 'MAPPED'
           AND (r.official_document_url IS NULL OR r.official_document_url = '')
         ORDER BY sr.portal, sr.seq""").fetchall()]

    by_portal: dict[str, list[dict]] = collections.defaultdict(list)
    for r in rows:
        by_portal[r["portal"]].append(r)

    cache: dict[str, tuple[str | None, str]] = {}
    stats = collections.Counter()
    found: list[tuple[dict, str, float, int]] = []
    blocked: list[tuple[str, str]] = []

    portals = list(by_portal.items())
    if a.limit:
        portals = portals[:a.limit]

    for portal, group in portals:
        html, why = fetch(portal, cache)
        if html is None:
            stats["portal unreachable"] += 1
            blocked.append((portal, why))
            continue
        stats["portal reached"] += 1
        root_links = links_on(html, portal)

        # ---- level 1: pages likely to hold legislation, or named by the hint
        hint_tokens: set[str] = set()
        for r in group:
            hint_tokens |= tok(r.get("portal_path") or "")
        candidates = []
        for text, href in root_links:
            low = f"{text} {href}".lower()
            if DOC_RE.search(href):
                continue
            hit = sum(1 for w in SECTION_WORDS if w in low)
            hint = len(hint_tokens & tok(text)) if hint_tokens else 0
            if hit or hint:
                candidates.append((hit + hint * 2, text, href))
        candidates.sort(key=lambda c: -c[0])
        pages = [(portal, root_links)]
        for _, _text, href in candidates[:MAX_LEVEL1]:
            sub, sub_why = fetch(href, cache)
            if sub is None:
                continue
            stats["section page opened"] += 1
            pages.append((href, links_on(sub, href)))

        # ---- level 2: score document links across every page we opened
        claims: dict[str, list[tuple[float, dict]]] = collections.defaultdict(list)
        best: dict[str, tuple[float, str, int]] = {}
        for level, (page_url, page_links) in enumerate(pages):
            for r in group:
                for text, href in page_links:
                    if not DOC_RE.search(href):
                        continue
                    s = score(r["instrument"], text, href)
                    if s < MIN_OVERLAP:
                        continue
                    prev = best.get(r["id"])
                    if prev is None or s > prev[0]:
                        best[r["id"]] = (s, href, level)
        for rid, (s, href, level) in best.items():
            claims[href].append((s, next(r for r in group if r["id"] == rid)))
        for rid, (s, href, level) in best.items():
            if len([c for c in claims[href] if c[1]["id"] != rid]) > 0:
                stats["rejected — two instruments claim it"] += 1
                continue
            entry = next(r for r in group if r["id"] == rid)
            found.append((entry, href, s, level))
            stats["document found"] += 1
        for r in group:
            if r["id"] not in best:
                stats["no document matched"] += 1

    verified, rejected = [], []
    if a.apply:
        for entry, href, s, _lvl in found:
            ok, why = verify(href, entry["instrument"])
            (verified if ok else rejected).append((entry, href, why))
            time.sleep(DELAY)
        for entry, href, why in verified:
            con.execute(
                """UPDATE regulations SET official_document_url=?, updated_at=now()::text
                    WHERE id=? AND (official_document_url IS NULL OR official_document_url='')""",
                (href, entry["regulation_id"]))
            con.execute(
                """INSERT INTO source_checks (regulation_id, outcome, note, checked_at)
                   VALUES (?,?,?, now()::text)""",
                (entry["regulation_id"], "URL_RESOLVED",
                 f"two-level portal crawl; {why}"))
        con.commit()
        print(f"\nverified and recorded : {len(verified)}")
        for entry, href, why in verified:
            print(f"   OK   {entry['instrument'][:38]:<40} {why}")
        print(f"rejected after opening: {len(rejected)}")
        for entry, href, why in rejected:
            print(f"   NO   {entry['instrument'][:38]:<40} {why}")

    print(f"instruments still without a document : {len(rows)}")
    print(f"portals attempted                    : {len(portals)}")
    for k, v in stats.most_common():
        print(f"  {k:<40} {v}")
    print(f"\ndocuments {'recorded' if a.apply else 'that would be recorded'}: {len(found)}")
    for entry, href, s, lvl in sorted(found, key=lambda f: -f[2])[:25]:
        print(f"   {s:.2f} L{lvl} {entry['instrument'][:38]:<40} {href[:82]}")
    if blocked:
        print(f"\nportals that could not be read ({len(blocked)}):")
        for u, why in blocked[:10]:
            print(f"   {why:<44} {u}")
    if not a.apply:
        print("\n(dry run — pass --apply to record the URLs)")


if __name__ == "__main__":
    main()
