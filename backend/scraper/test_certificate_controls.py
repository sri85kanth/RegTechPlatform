#!/usr/bin/env python3
"""
Test the controls that CAN be tested from what this system holds.

WHAT IS TESTABLE, AND WHAT IS NOT
---------------------------------
For a LICENSING or REGISTRATION duty, holding the certificate IS the
compliance: the register records that a copy is on file and when it expires, so
the test is a real check with a reproducible result.

For a documentation, training or governance duty it is NOT. Passing those means
reading an SOP that does not exist, watching a training happen, sampling a
register. No row here pretends otherwise — they stay NOT_TESTED, which is what
they are.

THE RESULT IS COMPUTED, NEVER ASSUMED
-------------------------------------
  PASS          a copy is on file and the recorded expiry has not passed
  FAIL          the expiry has passed, or no copy is on file — and a finding is raised
  INCONCLUSIVE  a copy is on file but the register records no expiry date, so
                validity cannot be confirmed from what we hold

performed_by says a machine did it, against the register, on this date.
"""
import argparse, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
TESTABLE = ("LICENSING", "REGISTRATION")
ACTOR = "company-brain/certificate-check"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()
    today = datetime.now(timezone.utc).date()

    rows = con.execute("""
        SELECT cri.id AS cri_id, c.id AS control_id, c.name AS control, c.control_type,
               e.id AS evidence_id, e.name AS certificate, e.valid_until,
               e.description, e.verification_status
          FROM control_requirements cr
          JOIN controls c ON c.id = cr.control_id
          JOIN company_requirement_instances cri ON cri.id = cr.cri_id
          JOIN evidence_links el ON el.control_id = c.id
          JOIN evidence e ON e.id = el.evidence_id
         WHERE c.control_type = ANY(?::text[])""", (list(TESTABLE),)).fetchall()

    # A control can carry more than one certificate — two clinical establishment
    # registrations, for instance — so a duty would otherwise be tested twice.
    # One test per duty, against the strongest certificate available: a valid one
    # beats an undated one, and the later expiry wins between two valid ones.
    RANK = {"PASS": 3, "INCONCLUSIVE": 2, "FAIL": 1}
    best: dict[str, tuple] = {}

    tests, findings, tally = [], [], {}
    for r in rows:
        d = dict(r)
        copies = "0 copy" not in (d["description"] or "")
        expiry = d["valid_until"]
        if not copies:
            result, note = "FAIL", "No copy of the certificate is on file."
        elif not expiry:
            result, note = ("INCONCLUSIVE",
                            "A copy is on file, but the register records no expiry date, "
                            "so validity cannot be confirmed from what we hold.")
        else:
            try:
                exp = datetime.fromisoformat(str(expiry)[:10]).date()
            except ValueError:
                exp = None
            if exp is None:
                result, note = "INCONCLUSIVE", f"The recorded expiry '{expiry}' could not be read."
            elif exp < today:
                result, note = "FAIL", f"The certificate expired on {exp.isoformat()}."
            else:
                result, note = ("PASS",
                                f"A copy is on file and the certificate is valid until "
                                f"{exp.isoformat()} ({(exp - today).days} days).")
        key = (RANK[result], str(expiry or ""))
        if d["cri_id"] not in best or key > best[d["cri_id"]][0]:
            best[d["cri_id"]] = (key, d, result, note)

    for cri_id, (_, d, result, note) in best.items():
        tally[result] = tally.get(result, 0) + 1
        tid = f"tst-{cri_id}"
        tests.append((tid, cri_id, d["control_id"],
                      "Check the certificate register: a copy of the certificate is on file and "
                      "the recorded expiry date has not passed.",
                      "On change", 1, ACTOR, _now(), None, None, result, note,
                      json.dumps([d["evidence_id"]]), "SYSTEM_DERIVATION", _now()))
        if result == "FAIL":
            findings.append((f"fnd-{cri_id}", cri_id, tid, d["control_id"], "HIGH",
                             f"{d['certificate']}: {note}", note, None, ACTOR, _now(), "OPEN",
                             None, "SYSTEM_DERIVATION"))

    print("controls that can be tested from the register: %s" % ", ".join(TESTABLE))
    print("duties tested: %d" % len(tests))
    for k, v in sorted(tally.items(), key=lambda kv: -kv[1]):
        print("   %-14s %5d" % (k, v))
    print("findings raised: %d" % len(findings))
    print("\nnot tested, and left that way: every documentation, training, governance,")
    print("monitoring and reporting duty — passing those needs an SOP, a trained")
    print("person or a sampled register, none of which this system can observe.")
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.execute("DELETE FROM findings WHERE raised_by = ?", (ACTOR,))
    con.execute("DELETE FROM compliance_tests WHERE performed_by = ?", (ACTOR,))
    con.executemany("""INSERT INTO compliance_tests (id, cri_id, control_id, procedure, frequency,
          sample_size, performed_by, performed_at, period_from, period_to, result, result_notes,
          evidence_ids, fact_class, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", tests)
    if findings:
        con.executemany("""INSERT INTO findings (id, cri_id, test_id, control_id, severity, title,
              description, root_cause, raised_by, raised_at, status, closed_at, fact_class)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", findings)
    con.commit()
    print(f"\nwritten: {len(tests)} tests, {len(findings)} findings")


if __name__ == "__main__":
    main()
