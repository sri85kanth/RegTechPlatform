#!/usr/bin/env python3
"""
Run the matcher against the company entities currently in the database and
write proposals into company_mappings.

    python run_matcher.py --regulation reg-mdkyc
    python run_matcher.py --all --min-confidence 0.8

Every proposal lands as status='Proposed' — nothing is auto-approved. A human
still has to accept it, which is the whole point of the human gate.
"""
import argparse
import json
import sqlite3
from datetime import datetime, timezone

from regulatory_ingestion.db import connect
from regulatory_ingestion.company_db import init, log
from regulatory_ingestion.matcher import match_obligation
from regulatory_ingestion.precision import document_frequency, generic_names, accept

now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_brain(con) -> dict:
    """The Company Brain as the matcher expects it — read from the database."""
    ents = []
    for r in con.execute("SELECT id, name, domain, type, description, criticality FROM company_entities"):
        ents.append({
            "id": r["id"], "name": r["name"], "domain": r["domain"],
            "type": r["type"], "description": r["description"] or "",
            "criticality": r["criticality"],
        })
    return {"entities": ents, "by_id": {e["id"]: e for e in ents}, "mappings": []}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--regulation")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--min-confidence", type=float, default=0.75)
    ap.add_argument("--replace", action="store_true", help="clear existing proposals first")
    args = ap.parse_args()

    con = connect(); con.row_factory = sqlite3.Row
    init(con)
    brain = load_brain(con)
    if not brain["entities"]:
        raise SystemExit("no company entities in the database — onboard a company first")
    print(f"company entities: {len(brain['entities'])}")

    if args.regulation:
        reg_ids = [args.regulation]
    elif args.all:
        reg_ids = [r[0] for r in con.execute("SELECT id FROM regulations WHERE ingestion_status='MAPPED'")]
    else:
        raise SystemExit("pass --regulation <id> or --all")

    # precision gate — measured against this corpus, not guessed
    corpus = con.execute("SELECT COUNT(DISTINCT regulation_id) FROM obligations").fetchone()[0]
    df = document_frequency(con, [e["name"] for e in brain["entities"]])
    generic = generic_names(df, corpus)
    print(f"generic names excluded from name-only matching: {', '.join(sorted(generic)) or 'none'}")

    if args.replace:
        n = con.execute("DELETE FROM company_mappings").rowcount
        print(f"cleared {n} existing proposals")

    total = kept = 0
    dropped: dict[str, int] = {}
    for rid in reg_ids:
        obls = [dict(r) for r in con.execute("SELECT * FROM obligations WHERE regulation_id=?", (rid,))]
        if not obls:
            continue
        for o in obls:
            otext = f"{o.get('title') or ''} {o.get('description') or ''}"
            for m in match_obligation(o, brain):
                total += 1
                if m["confidence"] < args.min_confidence:
                    continue
                ok, why = accept({"signals": m.get("match_signals")}, m["entity_name"], otext, generic)
                if not ok:
                    dropped.setdefault(why.split("—")[0].strip()[:60], 0)
                    dropped[why.split("—")[0].strip()[:60]] += 1
                    continue
                mid = f"map-{o['id']}-{m['company_brain_entity_id']}"
                con.execute(
                    """INSERT OR REPLACE INTO company_mappings
                       (id,obligation_id,target_id,target_domain,status,confidence,reason,source,created_by,created_at)
                       VALUES (?,?,?,?,'Proposed',?,?,?,?,?)""",
                    (mid, o["id"], m["company_brain_entity_id"], m["entity_domain"],
                     int(m["confidence"] * 100), m["match_reason"], "matching-engine", "matcher", now()))
                kept += 1
        print(f"  {rid:16} {len(obls):>4} obligations")

    log(con, "-", "matcher run", f"{kept} proposals from {total} candidates", "matcher")
    con.commit()

    print(f"\n{total} candidates → {kept} proposals above {args.min_confidence:.2f} confidence")
    if dropped:
        print("\ndropped by the precision gate:")
        for why, n in sorted(dropped.items(), key=lambda x: -x[1]):
            print(f"  {n:>5}  {why}")
    print("\nby domain:")
    for r in con.execute("""SELECT target_domain, COUNT(*) n, AVG(confidence) c
                            FROM company_mappings GROUP BY 1 ORDER BY n DESC"""):
        print(f"  {r['target_domain']:12} {r['n']:>4}   avg confidence {r['c']:.0f}%")


if __name__ == "__main__":
    main()
