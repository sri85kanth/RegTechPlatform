#!/usr/bin/env python
"""
Scheduled source watcher.

Run from cron so change detection actually has a second crawl to compare against:

    # every night at 02:15, check the 40 stalest documents
    15 2 * * *  cd /path/to/scraper && ./.venv/bin/python watch_sources.py --limit 40

Deliberately conservative: a small batch with a real delay. Crawling every
document nightly would get this crawler blocked, which is how the last run
lost 378 documents to connection refusals.
"""
import argparse
import json

from regulatory_ingestion.db import connect
from regulatory_ingestion import watcher as W

ap = argparse.ArgumentParser()
ap.add_argument("--limit", type=int, default=25)
ap.add_argument("--delay", type=float, default=3.0)
ap.add_argument("--max-age-hours", type=int, default=24)
a = ap.parse_args()

res = W.run(connect(), limit=a.limit, delay=a.delay, max_age_hours=a.max_age_hours)
print(json.dumps({k: v for k, v in res.items() if k != "changed"}, indent=1))
if res["changed"]:
    print(f"\nCHANGES DETECTED in {len(res['changed'])} document(s):")
    for c in res["changed"]:
        print(f"  {c['regulation_id']}: {c['detail']}")
