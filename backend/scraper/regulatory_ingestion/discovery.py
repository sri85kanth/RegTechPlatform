"""
Discovery: notice NEW regulations appearing on regulator listing pages.

The watcher (watcher.py) answers "did a document we already track change?".
Nothing answered "did the regulator publish something we have never seen?" —
the library only grew when the scraper was run by hand. This closes that gap.

HONESTY RULES
-------------
- A listing entry is a LEAD, not a regulation. Rows land in
  discovered_regulations and surface as notifications; nothing here creates
  regulations, documents or obligations (mention is not detection).
- The first pass over a source records everything as BASELINE — one summary
  notification, not hundreds. Only items that appear AFTER the baseline are
  status NEW and notified individually.
- Every source fetch outcome is recorded, including failures, so a source that
  breaks is visible rather than silently quiet.

Parsers are deliberately self-contained (requests + BeautifulSoup): the bulk
scraper's crawl4ai stack stays out of the API process.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from . import notifications

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 Chrome/126 Safari/537.36"}
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
NOTIFY_CAP = 10          # per source per run; the rest fold into one summary


def init(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS discovered_regulations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT,
      detail_url TEXT NOT NULL UNIQUE,
      first_seen TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEW',
      note TEXT);
    CREATE INDEX IF NOT EXISTS idx_disc_source ON discovered_regulations(source, status);
    """)
    return con


# ---------------------------------------------------------------- parsers
def _clean(t: str) -> str:
    return re.sub(r"\s+", " ", t or "").strip()[:300]


def parse_rbi_md(html: str, base: str):
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select('a[href*="BS_ViewMasDirections.aspx"]'):
        href = a.get("href") or ""
        if "id=" not in href.lower():
            continue
        yield _clean(a.get_text()), urljoin(base, href)


def parse_sebi(html: str, base: str):
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select("a[href]"):
        href = a["href"]
        if re.search(r"/legal/(regulations|acts|rules)/.+\.html", href, re.I):
            yield _clean(a.get_text()), urljoin(base, href)


def parse_certin(html: str, base: str):
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select("a[href]"):
        href = a["href"]
        if href.lower().endswith(".pdf"):
            title = _clean(a.get_text()) or href.rsplit("/", 1)[-1]
            yield title, urljoin(base, href.lstrip("."))


def parse_cbic(html: str, base: str):
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select("a[href]"):
        href = a["href"]
        if href.lower().endswith(".pdf"):
            title = _clean(a.get_text()) or href.rsplit("/", 1)[-1]
            yield title, urljoin(base, href)


def parse_cci(html: str, base: str):
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select("a[href]"):
        href = a["href"]
        if href.lower().endswith(".pdf"):
            title = _clean(a.get_text()) or href.rsplit("/", 1)[-1]
            yield title, urljoin(base, href)


_RSS_ITEM = re.compile(r"<item>(.*?)</item>", re.S | re.I)
_RSS_FIELD = lambda tag: re.compile(rf"<{tag}>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</{tag}>", re.S | re.I)


def parse_rss(xml: str, base: str):
    """A feed is a contract; prefer it to scraping wherever a regulator offers one."""
    for m in _RSS_ITEM.finditer(xml):
        item = m.group(1)
        t = _RSS_FIELD("title").search(item)
        l = _RSS_FIELD("link").search(item)
        if t and l and l.group(1).strip():
            yield _clean(t.group(1)), l.group(1).strip()


def parse_trai(html: str, base: str):
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select('a[href$=".pdf"], a[href$=".PDF"]'):
        href = a["href"]
        if "/sites/default/files/" in href:
            title = _clean(a.get_text()) or href.rsplit("/", 1)[-1]
            yield title, urljoin(base, href)


SOURCES = [
    {"key": "rbi_master_directions", "url": "https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx", "parse": parse_rbi_md},
    # RBI FEMA has no server-rendered listing page we know of; FEMA notifications
    # already in the library are tracked per-document by the watcher instead.
    {"key": "sebi_regulations", "url": "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=3&smid=0", "parse": parse_sebi},
    {"key": "trai_regulations", "url": "https://trai.gov.in/release-publication/regulations", "parse": parse_trai},
    {"key": "rbi_notifications_rss", "url": "https://www.rbi.org.in/notifications_rss.xml", "parse": parse_rss},
    {"key": "certin_directions", "url": "https://www.cert-in.org.in/Directions70B.jsp", "parse": parse_certin},
    {"key": "cbic_gst_acts", "url": "https://cbic-gst.gov.in/gst-acts.html", "parse": parse_cbic},
    {"key": "cci_act", "url": "https://www.cci.gov.in/legal-framwork/act", "parse": parse_cci},
    # FSSAI, IRDAI, PFRDA, DGFT and MeitY render their lists in JavaScript —
    # probed 2026-09-06: zero server-side links. They join this table the day
    # the crawl stack lands on the box; pretending otherwise would just log
    # PARSED_EMPTY forever.
]

# India Code has been down for weeks; a cheap probe says when its DSpace answers
# again so enrich_indiacode.py (845 waiting regulations) can finally run.
INDIACODE_PROBE = "https://www.indiacode.nic.in/handle/123456789/1362"


def _norm(url: str) -> str:
    return url.split("#")[0].strip()


def _known_urls(con) -> set[str]:
    known = set()
    for col in ("source_url", "official_document_url"):
        for (u,) in con.execute(f"SELECT {col} FROM regulations WHERE {col} LIKE 'http%'").fetchall():
            known.add(_norm(u))
    for (u,) in con.execute("SELECT detail_url FROM discovered_regulations").fetchall():
        known.add(_norm(u))
    return known


def check_source(con, src, known: set[str]) -> dict:
    out = {"source": src["key"], "listed": 0, "new": 0, "status": "OK"}
    try:
        r = requests.get(src["url"], headers=HEADERS, timeout=45)
    except requests.RequestException as e:
        out["status"] = f"FETCH_FAILED: {type(e).__name__}"
        return out
    if r.status_code != 200:
        out["status"] = f"HTTP {r.status_code}"
        return out

    items, seen_here = [], set()
    for title, url in src["parse"](r.text, src["url"]):
        u = _norm(url)
        if u in seen_here:
            continue
        seen_here.add(u)
        items.append((title, u))
    out["listed"] = len(items)
    if not items:
        out["status"] = "PARSED_EMPTY"       # page changed shape — visible, not silent
        return out

    # Baseline = the FIRST successful scan of a source, marked by a sentinel
    # row so it stays true exactly once — even when that first scan finds
    # nothing unknown (otherwise the first genuinely new item would be
    # misfiled as baseline and never notified).
    baseline = con.execute(
        "SELECT COUNT(*) FROM discovered_regulations WHERE source=?", (src["key"],)).fetchone()[0] == 0
    fresh = [(t, u) for t, u in items if u not in known]
    status = "BASELINE" if baseline else "NEW"
    for title, url in fresh:
        did = "disc-" + hashlib.sha1(url.encode()).hexdigest()[:16]
        con.execute(
            """INSERT OR IGNORE INTO discovered_regulations (id, source, title, detail_url, first_seen, status)
               VALUES (?,?,?,?,?,?)""",
            (did, src["key"], title, url, _now(), status))
        known.add(url)
    if baseline:
        con.execute(
            """INSERT OR IGNORE INTO discovered_regulations (id, source, title, detail_url, first_seen, status)
               VALUES (?,?,?,?,?,?)""",
            ("disc-mark-" + src["key"], src["key"],
             f"[baseline marker — {len(items)} listing entries known when armed]",
             f"baseline://{src['key']}", _now(), "BASELINE"))
    con.commit()
    out["new"] = len(fresh)
    out["baseline"] = baseline

    if baseline:
        notifications.push(
            con, kind="discovery", severity="info", role="reviewer",
            title=f"Source watch armed: {src['key']}",
            body=f"{len(items)} listing entries known at arm time ({len(fresh)} recorded as baseline); "
                 "anything new from now on is flagged.",
            dedupe_key=f"discovery-baseline-{src['key']}")
    elif fresh:
        for title, url in fresh[:NOTIFY_CAP]:
            notifications.push(
                con, kind="discovery", severity="action", role="reviewer",
                title=f"New on {src['key']}: {title[:120]}",
                body=f"Listed at {url}. A lead, not yet a regulation — ingest it to make it one.",
                link=url, dedupe_key=f"discovery-{url}")
        if len(fresh) > NOTIFY_CAP:
            notifications.push(
                con, kind="discovery", severity="action", role="reviewer",
                title=f"{len(fresh) - NOTIFY_CAP} more new items on {src['key']}",
                body="See /api/watcher/discoveries for the full list.",
                dedupe_key=f"discovery-bulk-{src['key']}-{_now()[:10]}")
    return out


def probe_indiacode(con) -> str:
    try:
        r = requests.get(INDIACODE_PROBE, headers=HEADERS, timeout=25)
        up = r.status_code == 200 and "/bitstream/" in r.text
    except requests.RequestException:
        up = False
    if up:
        notifications.push(
            con, kind="discovery", severity="action", role="admin",
            title="India Code is answering again",
            body="DSpace handle pages resolve. Run enrich_detail work: python enrich_indiacode.py --limit 50 "
                 "then ingest_backlog.py — 845 regulations are waiting on it.",
            dedupe_key=f"indiacode-up-{_now()[:10]}")
        return "UP"
    return "STILL_DOWN"


def run(con) -> dict:
    init(con)
    known = _known_urls(con)
    results = [check_source(con, s, known) for s in SOURCES]
    return {"sources": results, "indiacode": probe_indiacode(con), "at": _now()}


def listing(con, *, status: str | None = None, limit: int = 100) -> list[dict]:
    init(con)
    q = "SELECT id, source, title, detail_url, first_seen, status FROM discovered_regulations WHERE detail_url NOT LIKE 'baseline://%'"
    args: list = []
    if status:
        q += " AND status=?"
        args.append(status)
    q += " ORDER BY first_seen DESC LIMIT ?"
    args.append(limit)
    return [dict(r) for r in con.execute(q, args).fetchall()]
