#!/usr/bin/env python3
"""
Record a derived "check by" date for certificates whose expiry the register does
not hold, but whose issue date it does.

WHAT THIS IS
------------
issue date + the statutory validity for that kind of licence = the date by which
the certificate must have been renewed, ON THE ASSUMPTION that it was granted
for the standard term. It is a renewal watch date, nothing more.

WHAT IT IS NOT
--------------
It is not the certificate's expiry. Licences of the same kind are granted for
different terms — an FSSAI licence runs one to five years depending on what was
applied for — so only the document itself settles the date. That is why:

  * it is written to `period_end`, never to `valid_until`
  * the certificate test is NOT re-run and stays INCONCLUSIVE
  * the description says it is derived and names the assumption

So a derived date can prompt a renewal, and can never make a duty look compliant.
"""
import argparse, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# Standard term for each kind of licence, with the instrument that sets it.
VALIDITY_YEARS = {
    "drug licence": (5, "Drugs and Cosmetics Rules, 1945 — licences in Form 20/21 have been "
                        "granted for five years since the 2017 amendment"),
    "fire noc": (1, "fire safety certificates for a high-risk occupancy are renewed annually "
                    "in Telangana"),
    "food licence (fssai)": (1, "an FSSAI licence is granted for one to five years; one year "
                                "is the shortest and therefore the safest watch date"),
    "biomedical waste authorisation": (5, "authorisation under the Bio-Medical Waste Management "
                                          "Rules, 2016 is granted for up to five years"),
    "clinical establishment registration": (5, "registration under the Clinical Establishments "
                                               "Act is granted for five years"),
    "pcpndt registration": (5, "registration under the PCPNDT Act is granted for five years"),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()
    today = datetime.now(timezone.utc).date()

    rows = con.execute("""SELECT e.id, e.name, e.valid_until, e.description, c.attrs
          FROM evidence e JOIN company_entities c ON c.id = e.source_entity_id
         WHERE e.evidence_type = 'Certificate'""").fetchall()
    updates, no_issue = [], []
    for r in rows:
        d = dict(r)
        at = json.loads(d["attrs"]) if isinstance(d["attrs"], str) else (d["attrs"] or {})
        if d["valid_until"]:
            continue                                  # a real expiry is on file
        rule = VALIDITY_YEARS.get(d["name"].strip().lower())
        issued = at.get("issueDate")
        if not rule or not issued:
            no_issue.append(d["name"])
            continue
        years, basis = rule
        try:
            start = datetime.fromisoformat(str(issued)[:10]).date()
        except ValueError:
            no_issue.append(d["name"]); continue
        check_by = start.replace(year=start.year + years)
        left = (check_by - today).days
        note = (f" Derived check-by date {check_by.isoformat()} ({'overdue by ' + str(-left) if left < 0 else str(left)} "
                f"days{'' if left < 0 else ' away'}): issued {start.isoformat()} plus {years} year"
                f"{'s' if years > 1 else ''}, because {basis}. Derived, not read from the "
                f"certificate — the register holds no expiry date, so this is a renewal watch "
                f"date and the validity test stays inconclusive until the real date is entered.")
        updates.append((check_by.isoformat(), (d["description"] or "") + note, _now(), d["id"]))
        print("   %-34s issued %-12s -> check by %-12s (%s days)"
              % (d["name"][:34], start.isoformat(), check_by.isoformat(), left))

    print("\n%d derived, %d left alone (no issue date recorded): %s"
          % (len(updates), len(no_issue), ", ".join(sorted(set(no_issue))) or "—"))
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.executemany("UPDATE evidence SET period_end = ?, description = ?, updated_at = ? "
                    "WHERE id = ?", updates)
    con.commit()
    print(f"\nwritten: {len(updates)} check-by dates. No test result changed.")


if __name__ == "__main__":
    main()
