#!/usr/bin/env python3
"""
Write each requirement's own applicability verdict onto its COMPANY scope row.

    python apply_requirement_applicability.py OUT.csv             report only
    python apply_requirement_applicability.py OUT.csv --apply     write
    python apply_requirement_applicability.py OUT.csv --restore   put the saved values back

company_requirement_scopes was built for this: until now its COMPANY row only
copied the regulation's verdict. Only four columns are written —
applicability_status, reason, confidence, source_rule_id (the rule that decided)
— and only on rows whose values change. Every changed row's previous values go
to OUT.csv first. Rows inside regulations that do not apply are left alone when
they already say NOT_APPLICABLE: rewording them would change nothing a person sees.
"""
from __future__ import annotations

import csv
import json
import pathlib
import sys
import time
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from regulatory_ingestion import applicability as A                      # noqa: E402
from regulatory_ingestion import requirement_applicability as R          # noqa: E402
from regulatory_ingestion.db import connect                              # noqa: E402

csv.field_size_limit(10_000_000)
OUT = sys.argv[1]
con = connect()

if "--restore" in sys.argv:
    with open(OUT) as f:
        rows = [(r["old_status"], r["old_reason"] or None, float(r["old_confidence"]) if r["old_confidence"] else None,
                 r["old_rule"] or None, r["scope_id"]) for r in csv.DictReader(f)]
    for i in range(0, len(rows), 2000):
        con.executemany("UPDATE company_requirement_scopes SET applicability_status=?, reason=?, confidence=?, "
                        "source_rule_id=? WHERE id=?", rows[i:i + 2000])
    con.commit()
    print(f"restored {len(rows)} rows")
    sys.exit()

t0 = time.time()
facts = A.company_facts(con)
company, origins = A.company_entity_families(facts)
rows = [dict(r) for r in con.execute("""
    SELECT s.id AS scope_id, s.applicability_status AS status, s.reason, s.confidence, s.source_rule_id AS rule,
           q.statement, r.applicability AS reg, g.status AS assessed
      FROM company_requirement_scopes s
      JOIN company_requirement_instances i ON i.id = s.cri_id
      JOIN requirements q ON q.id = i.requirement_id
      JOIN regulations r ON r.id = q.regulation_id
      LEFT JOIN gap_assessments g ON g.requirement_id = q.id
     WHERE s.scope_type = 'COMPANY'""").fetchall()]
con.commit()

changes, kinds, blanket = [], Counter(), Counter()
for r in rows:
    if r["reg"] == "NOT_APPLICABLE" and r["status"] == "NOT_APPLICABLE":
        continue
    d = R.decide(r["statement"], r["reg"], company, origins)
    rule = f"{R.ENGINE}:{d['kind']}"
    if r["reg"] in ("APPLICABLE", "CONDITIONAL"):
        kinds[(d["kind"], d["status"])] += 1
    if r["assessed"] == "NOT_APPLICABLE":
        # what becomes of the blanket "not applicable" when read through the views
        blanket["stays not applicable (with a reason)" if d["status"] == "NOT_APPLICABLE"
                else "becomes not yet assessed"] += 1
    new = (d["status"], d["reason"], d["confidence"], rule)
    if new != (r["status"], r["reason"], r["confidence"], r["rule"]):
        changes.append((r, new))

moves = Counter((r["status"], new[0]) for r, new in changes)
applying = sum(n for (k, s), n in kinds.items())
ruled_out = sum(n for (k, s), n in kinds.items() if s == "NOT_APPLICABLE")

with open(OUT, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["scope_id", "old_status", "old_reason", "old_confidence", "old_rule", "new_status", "new_rule"])
    for r, new in changes:
        w.writerow([r["scope_id"], r["status"], r["reason"], r["confidence"], r["rule"], new[0], new[3]])

report = {
    "seconds": int(time.time() - t0),
    "scope_rows": len(rows),
    "changed": len(changes),
    "moves": {f"{a} -> {b}": n for (a, b), n in moves.most_common()},
    "in_applying_regulations": {f"{k} -> {s}": n for (k, s), n in kinds.most_common()},
    "the_15k_blanket_not_applicable": dict(blanket),
    "previous_values_saved_to": OUT,
}
# Guard: inside regulations that apply, at most a quarter may be ruled out.
if "--apply" in sys.argv and applying and ruled_out > applying // 4:
    report["stopped_unwritten"] = f"{ruled_out} of {applying} ruled out — more than expected"
    print(json.dumps(report, indent=1))
    sys.exit(2)

if "--apply" in sys.argv:
    batch = [(*new, r["scope_id"]) for r, new in changes]
    for i in range(0, len(batch), 2000):
        con.executemany("UPDATE company_requirement_scopes SET applicability_status=?, reason=?, confidence=?, "
                        "source_rule_id=? WHERE id=?", batch[i:i + 2000])
    con.commit()
report["written"] = "--apply" in sys.argv
print(json.dumps(report, indent=1))
