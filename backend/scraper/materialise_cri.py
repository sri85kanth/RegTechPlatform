#!/usr/bin/env python3
"""
Materialise applicability results, company requirement instances and their
scopes for the configured company.

WHAT THIS DOES NOT DO
---------------------
It does not decide anything new. The verdict comes from
`applicability.evaluate()` — the same function the badge, the filter and the
regulation page use — so a CRI can never disagree with the screen it was
derived from. This script only writes that verdict where the compliance layer
can reach it, and instantiates one row per (requirement, company).

REGULATORY TRUTH IS NOT TOUCHED
-------------------------------
`requirements` rows are read and never written. Everything company-specific —
owner, deadline, compliance status, interpretation — lands on the instance. The
regulatory record stays company-agnostic and shareable.

SCOPES ARE HONEST ABOUT WHAT IS NOT KNOWN
-----------------------------------------
A COMPANY-level scope carries the engine's verdict. Product, activity and
geography scopes are written as UNASSESSED, because the applicability engine
does not yet evaluate scope-level rules: a regulation's text has not been read
for "applies to gold loans" or "applies to digital channels". Writing them as
APPLICABLE by inheritance would answer "does this apply to Bajaj's gold loan
business?" with a guess dressed as a finding. The rows exist so the question is
askable and the gap is visible; the verdict waits for a scope-aware rule engine.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect              # noqa: E402
from regulatory_ingestion import applicability as A      # noqa: E402
from regulatory_ingestion import requirement_applicability as R  # noqa: E402

ENGINE = "applicability/addressee-2"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# company_entities types that become scopes. Channels and customer types are
# absent from the company brain, so no scope rows are invented for them.
SCOPE_OF_TYPE = {
    "Product": "PRODUCT",
    "Business Activity": "BUSINESS_ACTIVITY",
    "Legal Entity": "LEGAL_ENTITY",
    "Location": "GEOGRAPHY",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    con = connect()
    prof = con.execute("SELECT * FROM company_profile ORDER BY id LIMIT 1").fetchone()
    if not prof:
        raise SystemExit("no company profile — nothing to instantiate")
    company_id = prof["id"]
    facts = A.company_facts(con)
    company_fams, origins = A.company_entity_families(facts)
    print(f"[cri] company {company_id}: {prof['legal_name']}")

    rules_by_reg: dict[str, list[dict]] = {}
    for r in con.execute("SELECT * FROM applicability_rules").fetchall():
        rules_by_reg.setdefault(r["regulation_id"], []).append(dict(r))

    # Only regulations that carry requirements are worth instantiating.
    regs = [dict(r) for r in con.execute(
        "SELECT * FROM regulations WHERE id IN (SELECT DISTINCT regulation_id FROM requirements)"
    ).fetchall()]
    print(f"[cri] {len(regs)} regulations carry requirements")

    scope_entities = [dict(r) for r in con.execute(
        "SELECT id, name, type FROM company_entities WHERE type IN "
        "('Product','Business Activity','Legal Entity','Location')").fetchall()]
    print(f"[cri] {len(scope_entities)} scope entities in the company brain")

    tally = Counter()
    ar_rows, cri_rows, scope_rows = [], [], []

    for reg in regs:
        rules = rules_by_reg.get(reg["id"], [])
        v = A.evaluate(con, reg, rules, facts) if rules else None
        verdict = (v or {}).get("verdict") or "UNASSESSED"
        tally[f"verdict {verdict}"] += 1

        ar_id = f"ar-{reg['id']}-{company_id}"
        ar_rows.append((
            ar_id, reg["id"], company_id, "COMPANY", None, verdict,
            (v or {}).get("confidence"), (v or {}).get("why"),
            json.dumps((v or {}).get("checks", []))[:60000],
            # What would settle a CONDITIONAL — taken from the checks the engine
            # could not evaluate, not invented here.
            json.dumps([c["name"] for c in (v or {}).get("checks", [])
                        if c.get("result") == "UNKNOWN"]),
            ENGINE, "UNREVIEWED", _now()))

        reqs = [dict(r) for r in con.execute(
            "SELECT id, deadline, statement FROM requirements WHERE regulation_id=?",
            (reg["id"],)).fetchall()]

        for rq in reqs:
            cri_id = f"cri-{rq['id']}-{company_id}"
            cri_rows.append((
                cri_id, rq["id"], company_id, ar_id,
                reg.get("effective_from") or None, None, None,
                # Compliance is derived from evidence and testing, neither of
                # which exists yet. NOT_ASSESSED is the truthful start state.
                "NOT_ASSESSED",
                "No control has been approved and no evidence exists, so "
                "compliance cannot be determined.",
                _now(), None, (v or {}).get("why"), None,
                "COMPANY_ASSESSMENT", "UNREVIEWED", None, None, _now(), _now()))
            tally["instances"] += 1

            # The requirement's own verdict, read from its words and never more
            # applicable than the regulation (requirement_applicability.py).
            rd = R.decide(rq["statement"], verdict, company_fams, origins)
            scope_rows.append((
                f"{cri_id}-s0", cri_id, "COMPANY", None, prof["legal_name"],
                rd["status"], rd["reason"], f"{R.ENGINE}:{rd['kind']}", rd["confidence"],
                "SYSTEM_DERIVATION", _now()))
            # Entity scopes only where the regulation reaches the company at
            # all. If a check positively excluded this company, it cannot then
            # apply to one of its products, and 10 UNASSESSED rows per instance
            # would bury the real gaps under a quarter of a million placeholders.
            for e in (scope_entities if verdict in ("APPLICABLE", "CONDITIONAL") else []):
                scope_rows.append((
                    f"{cri_id}-s-{e['id']}", cri_id, SCOPE_OF_TYPE[e["type"]],
                    e["id"], e["name"], "UNASSESSED",
                    "The applicability engine does not yet evaluate scope-level "
                    "rules; this scope has not been assessed.",
                    None, None, "SYSTEM_DERIVATION", _now()))
            tally["scope rows"] += len(scope_entities) + 1

    print(f"\n  applicability_results {len(ar_rows):,}")
    print(f"  instances             {len(cri_rows):,}")
    print(f"  scope rows            {len(scope_rows):,}")
    for k, n in sorted(tally.items()):
        print(f"    {k:26} {n:,}")

    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return

    # Derived tables, rebuilt for this company only. Targeted DELETE, never
    # CASCADE — obligations were once lost to a CASCADE that reached backwards
    # through a foreign key nobody expected.
    con.execute("DELETE FROM company_requirement_scopes WHERE cri_id IN "
                "(SELECT id FROM company_requirement_instances WHERE company_id=?)",
                (company_id,))
    con.execute("DELETE FROM company_requirement_instances WHERE company_id=?", (company_id,))
    con.execute("DELETE FROM applicability_results WHERE company_id=?", (company_id,))

    con.executemany(
        "INSERT INTO applicability_results (id, regulation_id, company_id, scope_type, "
        "scope_entity_id, verdict, confidence, reason, checks, missing_facts, "
        "engine_version, review_status, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ar_rows)
    con.executemany(
        "INSERT INTO company_requirement_instances (id, requirement_id, company_id, "
        "applicability_result_id, effective_from, effective_to, compliance_deadline, "
        "compliance_status, compliance_reason, compliance_computed_at, owner_id, "
        "applicability_reason, company_interpretation, fact_class, review_status, "
        "reviewed_by, reviewed_at, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", cri_rows)
    con.executemany(
        "INSERT INTO company_requirement_scopes (id, cri_id, scope_type, scope_entity_id, "
        "scope_label, applicability_status, reason, source_rule_id, confidence, "
        "fact_class, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", scope_rows)
    con.commit()
    print(f"\nwritten: {len(ar_rows):,} results, {len(cri_rows):,} instances, "
          f"{len(scope_rows):,} scopes")


if __name__ == "__main__":
    main()
