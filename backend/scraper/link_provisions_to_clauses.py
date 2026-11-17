#!/usr/bin/env python3
"""
Attach each legal provision to the clause whose text expresses it.

WHY THIS IS A BACKFILL AND NOT A SCHEMA CHANGE
----------------------------------------------
`legal_provisions.clause_id` already existed. It was NULL on all 35,377 rows for
one reason only: there were no clauses to point at until the clause parser ran.
The column encodes the right relationship — a provision is a semantic reading
OF some text, and that text lives in a clause — so nothing needs redesigning,
only filling.

The provision is not a CHILD of the clause in the tree sense. The clause is the
structural container the drafter wrote; the provision is what we read out of it,
and several provisions can come from one clause. That is why this is a foreign
key on the provision, not a nesting of one inside the other, and why
conditions, exceptions, thresholds and timing rules hang off the PROVISION as
siblings rather than forming a chain beneath it.

MATCHING RULE
-------------
A provision belongs to the DEEPEST clause in its own section whose text contains
the provision's source sentence. Deepest matters: in

    (b) These directions shall also apply to branches abroad, provided that:
        i.  where local law prohibits implementation, the matter shall be
            brought to the notice of the Reserve Bank.

the sentence sits inside both (b) and (b)(i), and (b)(i) is the citation an
auditor asks for.

A provision whose sentence cannot be located in any clause keeps clause_id NULL.
That is the honest outcome for text sitting in a section's lead-in before the
first enumeration marker — it belongs to the section, not to a clause, and
inventing a parent for it would put a citation on a provision that the document
does not support.
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect  # noqa: E402

# Alphanumerics only, no whitespace at all.
#
# The provision text and the clause text were produced by two different passes
# over the same PDF, and pypdf inserts stray spaces mid-word — one provision
# reads "upon rec eipt of the annual fee" where the clause reads "upon receipt".
# An exact substring match placed 2% of provisions because of artifacts like
# that. Collapsing to [a-z0-9] makes the comparison immune to them without
# altering a single word: no stemming, no fuzzy distance, no threshold to tune.
_KEEP = re.compile(r"[^a-z0-9]+")


def norm(t: str | None) -> str:
    return _KEEP.sub("", (t or "").lower())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    con = connect()

    clauses_by_section: dict[str, list[dict]] = {}
    for r in con.execute(
        "SELECT id, section_id, clause_path, clause_text, depth FROM clauses"
    ).fetchall():
        d = dict(r)
        d["norm"] = norm(d["clause_text"])
        clauses_by_section.setdefault(d["section_id"], []).append(d)
    # Deepest first, so the first containing clause found is the most specific.
    for v in clauses_by_section.values():
        v.sort(key=lambda c: -(c["depth"] or 0))
    print(f"[link] {sum(len(v) for v in clauses_by_section.values()):,} clauses "
          f"across {len(clauses_by_section):,} sections")

    provs = [dict(r) for r in con.execute(
        "SELECT id, section_id, source_text FROM legal_provisions").fetchall()]
    print(f"[link] {len(provs):,} provisions to place")

    tally = Counter()
    updates: list[tuple] = []
    for p in provs:
        cands = clauses_by_section.get(p["section_id"] or "", [])
        if not cands:
            tally["no clauses in that section"] += 1
            continue
        # 90 alphanumeric characters is long enough that a coincidental match is
        # not credible, and short enough to survive a truncated source sentence.
        needle = norm(p["source_text"])[:90]
        if len(needle) < 30:
            tally["provision text too short to place"] += 1
            continue
        hit = next((c for c in cands if needle in c["norm"]), None)
        if hit is None:
            tally["sentence not inside any clause (section lead-in)"] += 1
            continue
        updates.append((hit["id"], p["id"]))
        tally[f"placed at depth {hit['depth']}"] += 1

    for k, v in tally.most_common():
        print(f"    {k:52} {v:,}")
    print(f"\n  placeable: {len(updates):,} / {len(provs):,} "
          f"({100 * len(updates) // max(1, len(provs))}%)")

    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return

    con.executemany(
        "UPDATE legal_provisions SET clause_id=? WHERE id=?", updates)
    con.commit()
    print(f"\nwritten: {len(updates):,} provisions attached to a clause")


if __name__ == "__main__":
    main()
