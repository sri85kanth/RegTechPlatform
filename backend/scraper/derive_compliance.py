#!/usr/bin/env python3
"""
Derive compliance status from the chain, instead of asserting it.

THE RULES, IN PRECEDENCE ORDER
------------------------------
Compliance is read off the deepest link that exists in

    CRI → approved CONTROL → EVIDENCE → TEST → FINDING → VALIDATION

and the status names the first link that is missing. Every status carries a
reason that says exactly which link that was, so "NOT_ASSESSED" on screen is
never a shrug — it is "no control has been approved for this requirement".

    NOT_APPLICABLE     the applicability verdict excludes this company
    NOT_ASSESSED       no APPROVED control is mapped to the requirement
    EVIDENCE_MISSING   a control is approved, but no evidence is linked to it
    NOT_TESTED         evidence exists, but no test has been performed
    NON_COMPLIANT      the latest test FAILED, or an OPEN finding of severity
                       CRITICAL/HIGH exists without an EFFECTIVE validation
    PARTIALLY_COMPLIANT  the latest test was PARTIAL, or an open MEDIUM/LOW finding
    COMPLIANT          the latest test PASSED and no finding is open
    REVIEW_REQUIRED    the latest test was INCONCLUSIVE

WHY EVERY ROW WILL SAY NOT_ASSESSED TODAY
-----------------------------------------
Zero controls are approved and zero evidence exists. So the function returns
NOT_ASSESSED for all 19,446 instances — the same word that was hardcoded
before. The difference is that it is now COMPUTED, with a reason, from a rule
that can be read and tested, and the moment one control is approved the status
of every requirement it covers moves to EVIDENCE_MISSING on the next run without
anyone touching this file.

A derived compliance status is a COMPANY_ASSESSMENT / SYSTEM_DERIVATION. It is
never written anywhere near the regulatory record.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect  # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

APPROVED = {"Approved", "APPROVED", "ACCEPTED"}
BLOCKING_SEVERITY = {"CRITICAL", "HIGH"}


def derive(applicability: str | None,
           approved_controls: int,
           evidence_count: int,
           latest_test: str | None,
           open_findings: list[dict],
           effective_validations: int) -> tuple[str, str]:
    """→ (status, reason). Pure; no I/O; the single place the rules live."""
    if applicability == "NOT_APPLICABLE":
        return "NOT_APPLICABLE", "The applicability verdict excludes this company."
    if approved_controls == 0:
        return "NOT_ASSESSED", "No approved control is mapped to this requirement."
    if evidence_count == 0:
        return "EVIDENCE_MISSING", (f"{approved_controls} approved control(s), "
                                    "but no evidence is linked.")
    if latest_test is None or latest_test == "NOT_TESTED":
        return "NOT_TESTED", f"{evidence_count} evidence item(s) linked; no test performed."

    blocking = [f for f in open_findings if f["severity"] in BLOCKING_SEVERITY]
    if blocking and effective_validations == 0:
        return "NON_COMPLIANT", (f"{len(blocking)} open {'/'.join(sorted({f['severity'] for f in blocking}))} "
                                 "finding(s) without an effective validation.")
    if latest_test == "FAIL":
        return "NON_COMPLIANT", "Latest test failed."
    if latest_test == "INCONCLUSIVE":
        return "REVIEW_REQUIRED", "Latest test was inconclusive."
    if latest_test == "PARTIAL" or open_findings:
        sev = "/".join(sorted({f["severity"] for f in open_findings})) or "—"
        return "PARTIALLY_COMPLIANT", (
            "Latest test partial." if latest_test == "PARTIAL"
            else f"{len(open_findings)} open {sev} finding(s) not yet closed.")
    return "COMPLIANT", "Latest test passed; no open findings."


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    # One query per link so the derivation is legible, then a single pass.
    verdict = {r["cri_id"]: r["applicability"] for r in
               con.execute("SELECT cri_id, applicability FROM v_company_requirements")}

    approved = Counter()
    for r in con.execute(
        "SELECT cri_id, count(*) AS n FROM control_requirements "
        "WHERE review_status IN ('ACCEPTED','APPROVED') AND cri_id IS NOT NULL GROUP BY cri_id"):
        approved[r["cri_id"]] = r["n"]

    evidence = Counter()
    for r in con.execute(
        "SELECT cr.cri_id, count(DISTINCT el.evidence_id) AS n "
        "  FROM evidence_links el JOIN control_requirements cr "
        "    ON cr.requirement_id = el.requirement_id OR cr.control_id = el.control_id "
        " WHERE cr.cri_id IS NOT NULL GROUP BY cr.cri_id"):
        evidence[r["cri_id"]] = r["n"]

    latest_test: dict[str, str] = {}
    for r in con.execute(
        "SELECT DISTINCT ON (cri_id) cri_id, result FROM compliance_tests "
        "ORDER BY cri_id, performed_at DESC NULLS LAST"):
        latest_test[r["cri_id"]] = r["result"]

    open_findings: dict[str, list[dict]] = {}
    for r in con.execute(
        "SELECT cri_id, id, severity FROM findings "
        "WHERE status IN ('OPEN','IN_REMEDIATION','REMEDIATED')"):
        open_findings.setdefault(r["cri_id"], []).append(dict(r))

    validated = Counter()
    for r in con.execute(
        "SELECT f.cri_id, count(*) AS n FROM validations v JOIN findings f ON f.id=v.finding_id "
        "WHERE v.outcome='EFFECTIVE' GROUP BY f.cri_id"):
        validated[r["cri_id"]] = r["n"]

    tally = Counter()
    updates = []
    for cri_id, app in verdict.items():
        status, reason = derive(app, approved[cri_id], evidence[cri_id],
                                latest_test.get(cri_id), open_findings.get(cri_id, []),
                                validated[cri_id])
        tally[status] += 1
        updates.append((status, reason, _now(), cri_id))

    print(f"[compliance] {len(updates):,} instances")
    for k, n in tally.most_common():
        print(f"    {k:22} {n:,}")

    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.executemany(
        "UPDATE company_requirement_instances SET compliance_status=?, compliance_reason=?, "
        "compliance_computed_at=?, updated_at=? WHERE id=?",
        [(s, r, t, t, c) for s, r, t, c in updates])
    con.commit()
    print(f"\nwritten: {len(updates):,}")


if __name__ == "__main__":
    main()
