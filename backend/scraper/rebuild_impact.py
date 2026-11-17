#!/usr/bin/env python3
"""
Rebuild impact_relationships and impact_scores from the corrected matcher.

WHY A REBUILD RATHER THAN A PATCH
---------------------------------
The stored graph was produced by an earlier matcher that treated the ontology
keyword as standalone evidence and never applied the precision gate. 53% of its
206,649 relationships rested on no name evidence at all, and a further 35% were
duplicates of each other because 43 entities existed twice under two domains.
Those rows cannot be corrected in place — they were never derived from anything
that survives the current rules. They are recomputed.

Nothing is invented and nothing is approved: relationships are derived facts
about text, and every mapping the engine proposes stays 'Proposed'.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))

from regulatory_ingestion.db import connect                       # noqa: E402
from regulatory_ingestion.matcher import load_brain, match_obligation  # noqa: E402
from regulatory_ingestion import impact as I                      # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write; otherwise report only")
    a = ap.parse_args()

    con = connect()
    brain = load_brain(con)
    by_id = brain["by_id"]
    print(f"entities {len(brain['entities'])} · generic names gated {len(brain['generic'])}")

    before_r = con.execute("SELECT COUNT(*) FROM impact_relationships").fetchone()[0]
    before_s = con.execute("SELECT COUNT(*) FROM impact_scores").fetchone()[0]

    obls_by_reg: dict[str, list[dict]] = {}
    for r in con.execute("""SELECT id, regulation_id, title, description, obligation_type,
                                   source_reference FROM obligations"""):
        obls_by_reg.setdefault(r["regulation_id"], []).append(dict(r))

    # The materialised verdict — the same value the badge, the filter and the
    # regulation page show. Reading raw applicability_rules here is what let the
    # score disagree with the badge on 274 regulations.
    verdict_by_reg = {r["id"]: r["applicability"]
                      for r in con.execute("SELECT id, applicability FROM regulations")}

    rels: list[tuple] = []
    scores: list[tuple] = []
    for rid, obls in obls_by_reg.items():
        found = []
        for o in obls:
            for m in match_obligation(o, brain):
                found.append(m)
                rels.append((
                    f"ir-{o['id']}-{m['company_brain_entity_id']}"[:120], rid, o["id"],
                    m["company_brain_entity_id"], m["entity_name"], m["entity_domain"],
                    m["relationship_type"], m["match_reason"], m["match_signals"],
                    m["confidence"], m["regulation_clause_id"], "matcher-db/2", _now()))
        if found:
            s = I.score(found, obls, verdict_by_reg.get(rid), by_id)
            scores.append((rid, s["score"], s["level"], s["factors"], _now()))

    print(f"\nrelationships  {before_r:>8,}  ->  {len(rels):>8,}")
    print(f"scored regs    {before_s:>8,}  ->  {len(scores):>8,}")
    band: dict[str, int] = {}
    for _, _, lvl, _, _ in scores:
        band[lvl] = band.get(lvl, 0) + 1
    tot = max(len(scores), 1)
    print("\nrisk bands:")
    for lvl in ("Critical", "High", "Medium", "Low"):
        n = band.get(lvl, 0)
        print(f"  {lvl:<9} {n:>5}  {100*n/tot:>5.1f}%")

    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return 0

    con.execute("DELETE FROM impact_relationships")
    con.executemany(
        """INSERT INTO impact_relationships
             (id,regulation_id,obligation_id,company_brain_entity_id,entity_name,entity_domain,
              relationship_type,match_reason,match_signals,confidence,regulation_clause_id,
              source,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", rels)
    con.execute("DELETE FROM impact_scores")
    con.executemany(
        """INSERT INTO impact_scores (regulation_id,score,level,factors,computed_at)
           VALUES (?,?,?,?,?)""", scores)

    # regulations.impact_level mirrors impact_scores and is what the library
    # filter reads. Recomputing one without the other left the filter offering
    # 498 Critical records while the scores said 209 — one number, one source.
    con.execute("""UPDATE regulations r SET impact_level = s.level, impact_score = s.score
                     FROM impact_scores s WHERE s.regulation_id = r.id""")
    con.execute("""UPDATE regulations r SET impact_level = NULL, impact_score = NULL
                    WHERE NOT EXISTS (SELECT 1 FROM impact_scores s
                                       WHERE s.regulation_id = r.id)""")
    con.commit()
    print(f"\nwritten: {len(rels):,} relationships, {len(scores):,} scores")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
