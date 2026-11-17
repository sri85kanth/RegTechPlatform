"""
India Code ministry enrichment — one-off (re-runnable) pass that tags every
central act with its owning ministry, so the app can answer "which ministry
regulates this?" (labour vs corporate vs finance …).

Crawls the India Code ministry facet, then each ministry's act list, and writes
output/ministry_map.json  →  { "ic-<handle>": "Ministry of …", ... }
The main scraper merges this map into ic-* items when present.
"""
import asyncio
import json
import re
from pathlib import Path
from urllib.parse import unquote

from bs4 import BeautifulSoup
from crawl4ai import AsyncWebCrawler

HERE = Path(__file__).parent
MAP_OUT = HERE / "output" / "ministry_map.json"
BASE = "https://www.indiacode.nic.in"
BROWSE = f"{BASE}/handle/123456789/1362/browse"


async def facet_values(crawler) -> list[str]:
    """All ministry facet values (the facet list itself paginates via offset)."""
    values, offset = [], 0
    while offset < 200:
        r = await crawler.arun(url=f"{BROWSE}?type=ministry&offset={offset}")
        soup = BeautifulSoup(r.html or "", "html.parser")
        page_vals = []
        for a in soup.find_all("a"):
            href = a.get("href") or ""
            m = re.search(r"type=ministry.*?value=([^&]+)", href)
            if m:
                v = unquote(m.group(1).replace("+", " "))
                if v not in values and v not in page_vals:
                    page_vals.append(v)
        if not page_vals:
            break
        values.extend(page_vals)
        offset += 20
    return values


async def acts_for(crawler, value: str) -> list[str]:
    """Handle-ids of all acts under one ministry (paginated)."""
    ids, page = [], 0
    while page < 5:
        url = f"{BROWSE}?type=ministry&order=ASC&rpp=100&value={value.replace(' ', '+')}&offset={page * 100}"
        r = await crawler.arun(url=url)
        soup = BeautifulSoup(r.html or "", "html.parser")
        fresh = []
        # ONLY handles inside the results table — nav/sidebar links also use /handle/ URLs
        for tr in soup.select("table tr"):
            if len(tr.find_all("td")) < 3:
                continue
            a = tr.find("a", href=re.compile(r"/handle/[\d/]+"))
            if a is None:
                continue
            m = re.search(r"/handle/([\d/]+)", a.get("href") or "")
            if m:
                hid = m.group(1).replace("/", "-")
                if hid != "123456789-1362" and hid not in ids and hid not in fresh:
                    fresh.append(hid)
        if not fresh:
            break
        ids.extend(fresh)
        page += 1
    return ids


async def main():
    mapping: dict[str, str] = {}
    async with AsyncWebCrawler() as crawler:
        ministries = await facet_values(crawler)
        print(f"[facet] {len(ministries)} ministries")
        for i, mv in enumerate(ministries, 1):
            ids = await acts_for(crawler, mv)
            label = f"Ministry of {mv}" if not mv.lower().startswith(("ministry", "niti", "department", "president", "lok", "rajya", "election", "comptroller")) else mv
            for hid in ids:
                mapping[f"ic-{hid}"] = label
            print(f"[{i}/{len(ministries)}] {label}: {len(ids)} acts")
    MAP_OUT.write_text(json.dumps(mapping, indent=1, ensure_ascii=False))
    print(f"[write] {MAP_OUT} ({len(mapping)} act→ministry entries)")


if __name__ == "__main__":
    asyncio.run(main())
