#!/usr/bin/env python3
"""
Record every department as an entity, not just the nine that own a control.

The impact engine links a regulation's text to records this company HOLDS. Only
9 of 49 departments existed as records, so a rule about medical records, patient
registration or radiology had nothing to land on — the DPDP duties could reach
only "Information Technology" because that was the one data-handling department
that happened to own a control.

Built from the org structure and the employee register: the department name and
how many people record it. Nothing invented.
"""
import argparse, collections, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
_slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    heads = collections.Counter()
    for (attrs,) in con.execute("SELECT attrs FROM company_entities WHERE type='Employee'").fetchall():
        d = json.loads(attrs) if isinstance(attrs, str) else (attrs or {})
        if d.get("department"):
            heads[str(d["department"]).strip()] += 1
    depts = sorted({r[0] for r in con.execute(
        "SELECT DISTINCT name FROM org_nodes WHERE kind='Department'").fetchall()})
    have = {r[0] for r in con.execute(
        "SELECT name FROM company_entities WHERE type='Department'").fetchall()}
    new = [d for d in depts if d not in have]
    print(f"[departments] {len(depts)} in the org structure, {len(have)} already records, "
          f"{len(new)} to add")
    for d in new[:12]:
        print("   + %-34s %d people" % (d[:34], heads.get(d, 0)))
    if len(new) > 12:
        print("   … and %d more" % (len(new) - 12))
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    for d in new:
        con.execute("""INSERT INTO company_entities (id, domain, name, type, description,
                 verification, attrs, source, source_reference, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING""",
            (f"peo-dept-{_slug(d)}", "people", d, "Department",
             f"{heads.get(d, 0)} people record this department.", "Pending",
             json.dumps({"headcount": heads.get(d, 0),
                         "derivedFrom": "the org structure and the employee register"}),
             "derived from the org structure", "department", _now(), _now()))
    con.commit()
    print(f"\nwritten: {len(new)} departments")


if __name__ == "__main__":
    main()
