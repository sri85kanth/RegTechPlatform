#!/usr/bin/env python3
"""
Fill obligations.responsible_entity for obligations that have none, by running
the (now vocabulary-derived) SUBJECT_RE over the obligation's own sentence.

This rewrites no text and invents nothing: the owner is a verbatim span of the
sentence already stored in obligations.description. It exists because until
2026-09-28 SUBJECT_RE was finance-only and recorded no owner for 96% of
health/labour/environment obligations, and extract_clauses.promotable() rejects
an obligation whose owner is under 4 characters — so those regulations could
never produce a requirement.

  --apply    write (default is report only)
  --scope    all | applicable   (default applicable: regulations the engine
             does not rule out)
"""
import argparse, sys, pathlib
sys.path.insert(0, "/srv/company-brain/scraper")
from regulatory_ingestion.db import connect
from regulatory_ingestion.parsers import SUBJECT_RE

ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
ap.add_argument("--scope", choices=["all", "applicable"], default="applicable")
a = ap.parse_args()

con = connect()
where_scope = ""
if a.scope == "applicable":
    where_scope = ("AND o.regulation_id IN (SELECT regulation_id FROM applicability_results "
                   "WHERE verdict <> 'NOT_APPLICABLE') ")

rows = con.execute(
    "SELECT o.id, o.description FROM obligations o "
    "WHERE coalesce(o.responsible_entity,'') = '' " + where_scope
).fetchall()
print(f"[owners] {len(rows):,} owner-less obligations in scope '{a.scope}'", flush=True)

updates, samples = [], []
for r in rows:
    m = SUBJECT_RE.search(r["description"] or "")
    if not m:
        continue
    owner = m.group(0).strip()
    if len(owner) < 4:
        continue
    updates.append((owner, r["id"]))
    if len(samples) < 20:
        samples.append((owner, (r["description"] or "")[:96]))

print(f"[owners] {len(updates):,} would gain an owner "
      f"({100.0*len(updates)/len(rows) if rows else 0:.1f}%)\n")
print("  sample — owner  <-  sentence")
for o, d in samples:
    print(f"   {o[:30]:32s} <- {d}")

if not a.apply:
    print("\n(report only — pass --apply to write)")
    raise SystemExit(0)

con.executemany("UPDATE obligations SET responsible_entity = ? WHERE id = ?", updates)
con.commit()
print(f"\nwritten: {len(updates):,} owners")
