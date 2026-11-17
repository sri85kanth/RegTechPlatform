"""
Find document links on the portals a source register points at.

WHY THIS IS NOT enrich_detail_pages.py
--------------------------------------
That resolver refuses a listing page on purpose: "only URL patterns that
identify ONE regulation are eligible". A register records ROOT PORTALS, and 22
of these serve more than one instrument — labour.gov.in alone carries 16. So
resolution cannot work here; this is discovery, and it has to earn each link.

HOW A LINK IS EARNED
--------------------
For every instrument, links on its portal are scored on token overlap with the
instrument's name. A link is written only when it is BOTH:

  * a confident match  — MIN_OVERLAP of the instrument's significant tokens, and
  * a unique claim     — no other instrument on that portal scores it as well.

The unique-claim rule is the one that already saved this project twice: 42 FEMA
regulations once shared one RBI banner PDF, and 35 SEBI pages resolved to a
single sidebar file. A document claimed by two instruments belongs to neither.

WHAT IT WILL NOT DO
-------------------
- No certificate verification is disabled. A portal with a broken chain is
  reported, not fetched insecurely.
- Nothing is downloaded. A candidate URL is recorded; ingest_backlog.py fetches
  and validates it with the %PDF check, as for every other source.
- An unmatched instrument stays DISCOVERED with the reason recorded. A register
  entry with no document is a real state, not a failure to hide.

    python resolve_register_portals.py                  # dry run
    python resolve_register_portals.py --apply
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
DOC_RE = re.compile(r"\.(pdf|docx?|xlsx?)(\?|$)", re.I)
STOP = {"the", "of", "and", "a", "an", "for", "in", "on", "to", "act", "rules",
        "regulations", "regulation", "rule", "amendment", "india", "indian", "state"}
MIN_OVERLAP = 0.60      # of the instrument's significant tokens
MIN_TOKENS = 2          # never match on a single word
DELAY = 1.2             # polite between portal fetches


def tokens(s: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower())
            if len(t) > 2 and t not in STOP}


def score(instrument: str, link_text: str, href: str) -> float:
    want = tokens(instrument)
    if len(want) < MIN_TOKENS:
        return 0.0
    have = tokens(f"{link_text} {href}")
    return len(want & have) / len(want)


def fetch(url: str) -> tuple[str | None, str]:
    """Returns (html, reason). Certificate problems are reported, never bypassed."""
    try:
        r = requests.get(url, headers=UA, timeout=25, allow_redirects=True)
        if r.status_code != 200:
            return None, f"HTTP {r.status_code}"
        if not r.headers.get("content-type", "").lower().startswith("text"):
            return None, "not an HTML page"
        return r.text, "ok"
    except requests.exceptions.SSLError:
        return None, "SSL certificate could not be verified (not bypassed)"
    except Exception as e:  # noqa: BLE001
        return None, type(e).__name__


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--register", default=None)
    a = ap.parse_args()
    con = connect()

    where = "WHERE register = ?" if a.register else ""
    params = (a.register,) if a.register else ()
    entries = [dict(r) for r in con.execute(
        f"""SELECT id, seq, instrument, portal, portal_path, regulation_id, status
              FROM source_register {where} ORDER BY portal, seq""", params).fetchall()]

    by_portal: dict[str, list[dict]] = collections.defaultdict(list)
    for e in entries:
        by_portal[e["portal"]].append(e)

    stats = collections.Counter()
    writes: list[tuple[str, str, str]] = []
    unreachable: list[tuple[str, str]] = []

    for portal, group in by_portal.items():
        html, reason = fetch(portal)
        time.sleep(DELAY)
        if html is None:
            stats["portal unreachable"] += 1
            unreachable.append((portal, reason))
            stats["instruments blocked"] += len(group)
            continue
        stats["portal fetched"] += 1

        soup = BeautifulSoup(html, "html.parser")
        links: list[tuple[str, str]] = []
        for a_tag in soup.find_all("a", href=True):
            href = urljoin(portal, a_tag["href"])
            if urlparse(href).scheme not in ("http", "https"):
                continue
            links.append((a_tag.get_text(" ", strip=True)[:180], href))

        # score every instrument against every link, then keep unique claims
        claims: dict[str, list[tuple[float, dict]]] = collections.defaultdict(list)
        best: dict[str, tuple[float, str, str]] = {}
        for e in group:
            ranked = sorted(
                ((score(e["instrument"], t, h), t, h) for t, h in links),
                key=lambda x: -x[0])
            if ranked and ranked[0][0] >= MIN_OVERLAP:
                s, t, h = ranked[0]
                best[e["id"]] = (s, t, h)
                claims[h].append((s, e))

        for eid, (s, text, href) in best.items():
            others = [c for c in claims[href] if c[1]["id"] != eid]
            if others:
                stats["rejected — claimed by another instrument"] += 1
                continue
            if not DOC_RE.search(href):
                stats["match is a page, not a document"] += 1
                continue
            entry = next(e for e in group if e["id"] == eid)
            writes.append((entry["regulation_id"], href, entry["instrument"]))
            stats["document found"] += 1

        for e in group:
            if e["id"] not in best:
                stats["no confident match on the portal"] += 1

    if a.apply:
        for rid, href, _ in writes:
            con.execute(
                """UPDATE regulations SET official_document_url=?, updated_at=now()::text
                    WHERE id=? AND (official_document_url IS NULL OR official_document_url='')""",
                (href, rid))
            con.execute(
                """INSERT INTO source_checks (regulation_id, outcome, note, checked_at)
                   VALUES (?,?,?, now()::text)""",
                (rid, "URL_RESOLVED", "matched on the register's portal by name overlap"))
        con.commit()

    print(f"instruments considered : {len(entries)}")
    for k, v in stats.most_common():
        print(f"  {k:<42} {v}")
    print(f"\ndocuments {'written' if a.apply else 'that would be written'}: {len(writes)}")
    for rid, href, name in writes[:12]:
        print(f"   {name[:44]:<46} {href[:78]}")
    if unreachable:
        print(f"\nportals that could not be read ({len(unreachable)}):")
        for u, why in unreachable[:14]:
            print(f"   {why:<46} {u}")
    if not a.apply:
        print("\n(dry run — pass --apply to record the URLs)")


if __name__ == "__main__":
    main()
