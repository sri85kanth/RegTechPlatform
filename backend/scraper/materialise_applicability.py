#!/usr/bin/env python3
"""
Store the applicability verdict for every regulation that can be evaluated.

WHY MATERIALISE
---------------
`regulations.applicability` is empty on all 1,759 rows, so filtering by it
returns nothing. The verdict is not missing, though — applicability.evaluate()
computes it deterministically from applicability_rules and the company profile,
and the detail page already shows it. It simply was never written back, so the
library could not filter on what the detail page displays.

Nothing here decides anything new: the same function, the same inputs, the same
five verdicts. Regulations with no applicability_rules are left NULL rather than
defaulted, because "we have no rules to evaluate" is not "does not apply".
"""
import argparse, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from regulatory_ingestion.db import connect                  # noqa: E402
from regulatory_ingestion import applicability as A          # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
a = ap.parse_args()

con = connect()
facts = A.company_facts(con)
if not facts:
    raise SystemExit("no company profile — applicability cannot be evaluated")

rules_by_reg: dict[str, list[dict]] = {}
for r in con.execute("SELECT * FROM applicability_rules"):
    rules_by_reg.setdefault(r["regulation_id"], []).append(dict(r))

regs = [dict(r) for r in con.execute("SELECT * FROM regulations")]
tally: dict[str, int] = {}
updates = []
for r in regs:
    rules = rules_by_reg.get(r["id"])
    if not rules:
        tally["(no rules — left unset)"] = tally.get("(no rules — left unset)", 0) + 1
        continue
    v = A.evaluate(con, r, rules, facts)
    tally[v["verdict"]] = tally.get(v["verdict"], 0) + 1
    updates.append((v["verdict"], _now(), r["id"]))

print(f"{len(regs)} regulations")
for k, n in sorted(tally.items(), key=lambda x: -x[1]):
    print(f"  {k:<28} {n:>5}")

if a.apply:
    con.executemany(
        "UPDATE regulations SET applicability=?, updated_at=? WHERE id=?", updates)
    con.commit()
    print(f"\nwritten: {len(updates)} verdicts")
else:
    print("\n(report only — pass --apply to write)")
