"""
Point register entries at regulations we already hold, instead of stubs.

THE PROBLEM
-----------
Importing the hospital register created one regulation row per instrument. But
41 of those instruments are Acts this system already ingested from India Code —
with the document fetched, the text extracted, sections and obligations built.
The import therefore produced a second, empty row for the same law: a stub with
a portal URL and nothing behind it.

WHAT THIS DOES
--------------
For each register entry, look for an existing MAPPED regulation that is the
same instrument. When one is found:

  * the register entry is re-pointed at the real regulation, so the register
    now references the ingested text rather than a placeholder, and
  * the empty stub is deleted — but only after confirming it is empty.

A stub that has acquired anything of its own (a document, sections, an
obligation) is never deleted; it is reported instead. Deleting data because a
title looked similar is not a trade this makes.

MATCHING
--------
Two-way token overlap (Jaccard). One-way overlap was tried and produced a
confident false positive — "Consumer Protection Act, 2019" scored 1.0 against a
TRAI telecom regulation, because every one of its significant tokens appeared
somewhere in that much longer title. Requiring both directions to agree removes
that whole class of error.

    python dedupe_register_regulations.py            # dry run
    python dedupe_register_regulations.py --apply
"""
from __future__ import annotations

import argparse
import re

from regulatory_ingestion.db import connect

STOP = {"the", "of", "and", "a", "an", "for", "in", "on", "to", "act", "rules",
        "regulations", "regulation", "rule", "amendment", "india", "indian", "state"}
MIN_JACCARD = 0.60


def tok(s: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (s or "").lower())
            if len(t) > 2 and t not in STOP}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    corpus = [(r["id"], r["title"], tok(r["title"])) for r in con.execute(
        """SELECT id, title FROM regulations
            WHERE ingestion_status = 'MAPPED' AND title IS NOT NULL
              AND id NOT LIKE 'hosp-%'""").fetchall()]

    entries = [dict(r) for r in con.execute(
        """SELECT id, seq, instrument, regulation_id FROM source_register
            ORDER BY seq""").fetchall()]

    relinked, kept, not_empty = [], [], []
    for e in entries:
        want = tok(e["instrument"])
        if len(want) < 2:
            kept.append((e, "name too short to match safely"))
            continue
        best = (0.0, None, None)
        for rid, title, have in corpus:
            if not have:
                continue
            j = len(want & have) / len(want | have)
            if j > best[0]:
                best = (j, rid, title)
        if best[0] < MIN_JACCARD:
            kept.append((e, "no existing regulation matches"))
            continue

        stub = e["regulation_id"]
        counts = con.execute(
            """SELECT (SELECT COUNT(*) FROM sections     WHERE regulation_id = ?) AS s,
                      (SELECT COUNT(*) FROM obligations  WHERE regulation_id = ?) AS o,
                      (SELECT COUNT(*) FROM documents    WHERE regulation_id = ?) AS d""",
            (stub, stub, stub)).fetchone()
        if counts and (counts["s"] or counts["o"] or counts["d"]):
            not_empty.append((e, stub, dict(counts)))
            continue

        relinked.append((e, stub, best))
        if a.apply:
            con.execute("UPDATE source_register SET regulation_id = ? WHERE id = ?",
                        (best[1], e["id"]))
            for t in ("regulation_sectors", "regulation_regions", "regulation_types"):
                con.execute(f"DELETE FROM {t} WHERE regulation_id = ?", (stub,))
            con.execute("DELETE FROM regulations WHERE id = ?", (stub,))
    if a.apply:
        con.commit()

    print(f"register entries        : {len(entries)}")
    print(f"already in the corpus   : {len(relinked)}   (stub {'removed' if a.apply else 'would be removed'})")
    print(f"genuinely new           : {len(kept)}")
    print(f"stub had its own data   : {len(not_empty)}   (kept, never deleted)")
    print()
    for e, stub, (j, rid, title) in relinked[:12]:
        print(f"  {j:.2f}  {e['instrument'][:40]:<42} -> {rid[:24]:<26} {title[:36]}")
    if not_empty:
        print("\nnot deleted — the stub holds data of its own:")
        for e, stub, c in not_empty[:6]:
            print(f"  {e['instrument'][:44]:<46} {c}")
    if not a.apply:
        print("\n(dry run — pass --apply to relink and remove the empty stubs)")


if __name__ == "__main__":
    main()
