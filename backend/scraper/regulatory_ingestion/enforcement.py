"""
Enforcement actions: what regulators ACTUALLY fined, not just what the law
allows. RBI publishes every monetary penalty as a press release; this records
them as ground truth beside the statutory ceilings penalties.py extracts.

HONESTY RULES
-------------
- Rows come only from RBI's own press-release pages; the parsed amount is
  stored with the sentence it came from. Unparseable amount -> row kept with
  amount NULL, never guessed.
- First run is a baseline (no per-item notifications); afterwards each new
  penalty order raises one notification.
- A press release is an enforcement FACT about some entity; it is never
  attached to a regulation unless the title/body names one we hold.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone

import requests

from . import notifications, penalties

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 Chrome/126 Safari/537.36"}
LISTING = "https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx"
RSS = "https://www.rbi.org.in/pressreleases_rss.xml"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

_ANCHOR = re.compile(r"href=(?:\"|')?(BS_PressReleaseDisplay\.aspx\?prid=(\d+))(?:\"|')?[^>]*>([^<]{0,220})", re.I)
_TAG = re.compile(r"<[^>]+>")
_DATE = re.compile(r"\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b")
# a decimal point ("₹2.00 lakh") must not end the sentence early
_PENALTY_SENT = re.compile(r"[^.]*?penalty\s+of\s+(?:[^.]|\.(?=\d))*\.", re.I)


def init(con):
    con.executescript("""
    CREATE TABLE IF NOT EXISTS enforcement_actions (
      id TEXT PRIMARY KEY,
      regulator TEXT NOT NULL,
      title TEXT NOT NULL,
      entity_name TEXT,
      amount REAL,
      amount_fmt TEXT,
      announced_on TEXT,
      url TEXT NOT NULL,
      refs TEXT,
      snippet TEXT,
      first_seen TEXT NOT NULL);
    """)
    return con


def _detail(prid: str, timeout: int = 45) -> dict | None:
    r = requests.get(f"{LISTING}?prid={prid}", headers=HEADERS, timeout=timeout)
    if r.status_code != 200:
        return None
    text = re.sub(r"\s+", " ", _TAG.sub(" ", r.text))
    sent = _PENALTY_SENT.search(text)
    snippet = sent.group(0).strip()[:500] if sent else ""
    amount = None
    if snippet:
        amts = penalties.amounts(snippet)
        if amts:
            amount = max(a for a, _ in amts)
    d = _DATE.search(text)
    refs = "; ".join(dict.fromkeys(
        m.group(0).strip()[:160] for m in re.finditer(
            r"(?:Master Direction|Reserve Bank of India \([^)]{3,80}\) Directions|Section \d+[A-Za-z()]* of the [A-Z][^,;.]{3,80}Act[^,;.]{0,20})",
            text)))[:600]
    return {"amount": amount, "announced_on": d.group(1) if d else None,
            "snippet": snippet, "refs": refs}


def refresh(con, *, limit_new: int = 25, delay: float = 2.0) -> dict:
    init(con)
    out = {"listed": 0, "new": 0, "status": "OK", "via": "rss"}
    found: list[tuple[str, str, str]] = []       # (prid, url, title)
    seen = set()

    def _collect(pairs):
        for prid, title in pairs:
            if prid in seen or "penalty" not in title.lower():
                continue
            seen.add(prid)
            found.append((prid, f"{LISTING}?prid={prid}", title))

    # the feed first — a contract, not a scrape; the HTML listing stays as fallback
    try:
        r = requests.get(RSS, headers=HEADERS, timeout=45)
        if r.status_code == 200:
            from . import discovery as _D
            _collect((re.search(r"prid=(\d+)", u).group(1), t)
                     for t, u in _D.parse_rss(r.text, RSS) if re.search(r"prid=(\d+)", u))
    except requests.RequestException:
        pass
    if not found:
        out["via"] = "html"
        try:
            r = requests.get(LISTING, headers=HEADERS, timeout=45)
        except requests.RequestException as e:
            out["status"] = f"FETCH_FAILED: {type(e).__name__}"
            return out
        if r.status_code != 200:
            out["status"] = f"HTTP {r.status_code}"
            return out
        _collect((m.group(2), re.sub(r"\s+", " ", m.group(3)).strip())
                 for m in _ANCHOR.finditer(r.text))
    out["listed"] = len(found)
    if not found:
        out["status"] = "PARSED_EMPTY"
        return out

    baseline = con.execute("SELECT COUNT(*) FROM enforcement_actions").fetchone()[0] == 0
    known = {r[0] for r in con.execute("SELECT id FROM enforcement_actions").fetchall()}
    fresh = [f for f in found if f"rbi-{f[0]}" not in known][:limit_new]
    for prid, url, title in fresh:
        try:
            d = _detail(prid)
        except requests.RequestException:
            d = None
        entity = None
        em = re.search(r"penalty on (.{3,140})$", title, re.I)
        if em:
            entity = em.group(1).strip().rstrip(".")
        con.execute(
            """INSERT OR IGNORE INTO enforcement_actions
               (id, regulator, title, entity_name, amount, amount_fmt, announced_on, url, refs, snippet, first_seen)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (f"rbi-{prid}", "RBI", title[:300], entity,
             (d or {}).get("amount"), penalties.fmt_inr((d or {}).get("amount")),
             (d or {}).get("announced_on"), url, (d or {}).get("refs"),
             (d or {}).get("snippet"), _now()))
        if not baseline:
            amt = penalties.fmt_inr((d or {}).get("amount")) or "amount not stated"
            notifications.push(
                con, kind="enforcement", severity="action", role="reviewer",
                title=f"RBI penalty: {amt} on {entity or 'unnamed entity'}",
                body=f"{title}. What the regulator actually imposed — statutory ceilings are on the impact screen.",
                link=url, dedupe_key=f"enforcement-rbi-{prid}")
        time.sleep(delay)
    con.commit()
    out["new"] = len(fresh)
    out["baseline"] = baseline
    if baseline and fresh:
        notifications.push(
            con, kind="enforcement", severity="info", role="reviewer",
            title=f"Enforcement watch armed: {len(fresh)} recent RBI penalty orders recorded",
            body="New monetary-penalty press releases will be flagged as they appear.",
            dedupe_key="enforcement-baseline-rbi")
    return out


def listing(con, *, limit: int = 50) -> list[dict]:
    init(con)
    return [dict(r) for r in con.execute(
        """SELECT id, regulator, title, entity_name, amount, amount_fmt,
                  announced_on, url, refs, first_seen
           FROM enforcement_actions ORDER BY first_seen DESC, id DESC LIMIT ?""",
        (limit,)).fetchall()]


def stats(con) -> dict:
    init(con)
    r = con.execute(
        """SELECT COUNT(*) n, COUNT(amount) with_amount, MAX(amount) mx, AVG(amount) avg
           FROM enforcement_actions""").fetchone()
    return {"actions": r["n"], "withAmount": r["with_amount"],
            "maxAmount": r["mx"], "maxAmountFmt": penalties.fmt_inr(r["mx"]),
            "avgAmount": round(r["avg"]) if r["avg"] else None,
            "avgAmountFmt": penalties.fmt_inr(r["avg"])}
