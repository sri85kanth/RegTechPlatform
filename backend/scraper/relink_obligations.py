"""
Re-link obligations to the section that actually contains their text.

The measured state (obligation_audit.py): 100% of obligation text exists
verbatim in its regulation, but ~10% is linked to a NEIGHBOURING section —
boundary drift from extraction, not fabrication. The fix is mechanical and
verifiable: find the section whose text contains the obligation's sentence,
update section_id, count before and after. Nothing is rewritten; only the
pointer moves, and only when exactly one better home exists.

    python relink_obligations.py            # dry run with counts
    python relink_obligations.py --apply
"""
from __future__ import annotations

import argparse
import re
from collections import defaultdict

from regulatory_ingestion.db import connect

_norm = lambda t: re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def run(apply: bool = False, regs: list[str] | None = None) -> dict:
    """`regs` limits the pass to those regulations. A whole-corpus pass holds
    every section's text in memory at once, so scoping is what makes a run on a
    loaded box safe as well as fast."""
    con = connect()
    where = " WHERE regulation_id = ANY(?::text[])" if regs is not None else ""
    args = (regs,) if regs is not None else ()
    secs_by_reg: dict[str, list] = defaultdict(list)
    for s in con.execute("SELECT id, regulation_id, section_number, section_text FROM sections"
                         + where, args):
        secs_by_reg[s["regulation_id"]].append((s["id"], _norm(s["section_text"])))

    tally = {"checked": 0, "already_correct": 0, "relinked": 0,
             "ambiguous_left": 0, "not_found_left": 0}
    for o in con.execute(
            "SELECT id, regulation_id, section_id, description FROM obligations"
            + where, args).fetchall():
        tally["checked"] += 1
        probe = _norm(o["description"])[:180]
        if not probe:
            tally["not_found_left"] += 1
            continue
        secs = secs_by_reg.get(o["regulation_id"], [])
        current = next((t for sid, t in secs if sid == o["section_id"]), None)
        if current is not None and probe in current:
            tally["already_correct"] += 1
            continue
        homes = [sid for sid, t in secs if probe in t]
        if len(homes) == 1:
            tally["relinked"] += 1
            if apply:
                con.execute("UPDATE obligations SET section_id=? WHERE id=?", (homes[0], o["id"]))
        elif len(homes) > 1:
            # the same sentence appears in several sections (repeated boilerplate);
            # moving the pointer would be a guess — leave it and say so
            tally["ambiguous_left"] += 1
        else:
            tally["not_found_left"] += 1
    if apply:
        con.commit()
    return tally


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--register", action="store_true",
                    help="only the instruments in the hospital source register")
    ap.add_argument("--ids", help="comma-separated regulation ids")
    a = ap.parse_args()
    scope: list[str] | None = None
    if a.register:
        rows = connect().execute("SELECT DISTINCT regulation_id FROM source_register "
                                 "WHERE regulation_id IS NOT NULL").fetchall()
        scope = [(r["regulation_id"] if hasattr(r, "keys") else r[0]) for r in rows]
    if a.ids:
        scope = sorted({*(scope or []), *(i.strip() for i in a.ids.split(",") if i.strip())})
    if scope is not None:
        print(f"[relink] scoped to {len(scope):,} regulations")
    print(run(a.apply, scope))
