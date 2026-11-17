#!/usr/bin/env python3
"""
Fill obligations.responsible_entity ONLY where the party is the sentence's
grammatical subject: optional enumerator, optional determiner, the party, a
short aside at most, then the modal verb.

Why so strict
-------------
Measured 2026-09-28 over 121,456 owner-less obligations in regulations the
engine does not rule out:

    any vocabulary word in the sentence   5,070  (~20% correct — unusable:
                                                 it read "submitted to Tie-up
                                                 hospital" as the hospital
                                                 owing the duty, and municipal
                                                 property-tax clauses as
                                                 occupier duties)
    party anywhere before the modal       2,301  (~50%)
    ... within 30 chars of the modal      1,205  (~60%)
    sentence-initial subject (this)         342  (~90%)

A wrong owner is worse than no owner: it manufactures a duty the company does
not owe, and that duty then becomes a requirement and reaches a control. The
remaining ~99% need a parser that knows grammar or a human; a regex cannot
find a subject.
"""
import argparse, re, sys
sys.path.insert(0, "/srv/company-brain/scraper")
from regulatory_ingestion.db import connect
from regulatory_ingestion.parsers import APPLICABILITY_VOCAB, _forms

ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
a = ap.parse_args()

ALT = "|".join(sorted((re.escape(t) for v in APPLICABILITY_VOCAB for t in _forms(v)),
                      key=len, reverse=True))
STRICT = re.compile(
    r"^\W{0,8}(?:\(\w{1,4}\)\s*)?(?:the|a|an|any|every|each|all|no|such)?\s*"
    r"(" + ALT + r")\b(?:[^.;]{0,40}?)\s(?:shall|must|is required to|are required to)\b",
    re.I)

con = connect()
rows = con.execute("""
    SELECT o.id, o.description, o.regulation_id FROM obligations o
     WHERE coalesce(o.responsible_entity,'') = ''
       AND o.regulation_id IN (SELECT regulation_id FROM applicability_results
                               WHERE verdict <> 'NOT_APPLICABLE')
""").fetchall()

updates, regs = [], set()
for r in rows:
    m = STRICT.match((r["description"] or "").strip())
    if not m:
        continue
    owner = m.group(1).strip()
    if len(owner) < 4:
        continue
    updates.append((owner, r["id"]))
    regs.add(r["regulation_id"])

print(f"[owners] {len(rows):,} owner-less obligations in applicable regulations")
print(f"[owners] {len(updates):,} have a sentence-initial subject, "
      f"across {len(regs):,} regulations")
if not a.apply:
    print("\n(report only — pass --apply to write)")
    raise SystemExit(0)

con.executemany("UPDATE obligations SET responsible_entity = ? WHERE id = ?", updates)
con.commit()
print(f"\nwritten: {len(updates):,} owners across {len(regs):,} regulations")
with open("/tmp/owner_regs.txt", "w") as fh:
    fh.write("\n".join(sorted(regs)))
print("regulation ids -> /tmp/owner_regs.txt")
