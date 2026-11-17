#!/usr/bin/env python3
"""
Assign every proposed control to a department and an owning designation.

Both come from the hospital's own records: the department is one of the 49 in
the org structure, the designation is one of the 54 on the payroll, and the
pairing is checked against who actually works in that department — the employee
register says Information Technology holds a Manager and an Engineer, so IT
controls are owned by a Manager and not by a title nobody holds.

A designation, never a person: the assignment says which role answers for the
control, and the hospital decides who fills it. Everything stays UNREVIEWED —
assigning an owner is not the same as that owner accepting the duty.
"""
import argparse, collections, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
_slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")

# area -> (department, preferred designation). Fallback is the senior-most
# designation actually recorded in that department.
PLAN = {
    "Clinical establishment":   ("Medical", "Medical Director"),
    "Workforce":                ("Human Resources", "Director"),
    "Pharmacy and drugs":       ("Pharmacy", "Pharmacist"),
    "Biomedical waste":         ("Nursing", "Infection Control Nurse"),
    "Food safety":              ("Food & Beverages", "Dietician"),
    "Personal data":            ("Information Technology", "Manager"),
    "Building and fire safety": ("Maintenance", "Engineer"),
    "PCPNDT and imaging":       ("Radiology", "Consultant"),
    "Contract labour":          ("Human Resources", "Director"),
    "MTP services":             ("Medical", "Medical Director"),
    "Laboratory":               ("Laboratory", "Senior Technician"),
    "Blood centre":             ("Blood Bank", "Nursing Superintendent"),
    "Clinical practitioners":   ("Medical", "Medical Director"),
    "Radiation safety":         ("Radiology", "Consultant"),
    "Premises":                 ("Facilities", "Senior Executive"),
    "Licensed activity":        ("Administration", "Floor Manager"),
}
BY_TYPE = {"AUDIT": ("Internal Audit", "Assistant General Manager"),
           "TRAINING": ("Human Resources", "Director")}
# most accountable first, used only when the preferred designation is absent
SENIORITY = ["Executive Director", "Director", "Medical Director", "Chief Operating Officer",
             "General Manager", "Assistant General Manager", "Senior Manager", "Manager",
             "Deputy Manager", "Assistant Manager", "Head of Department", "Head",
             "Nursing Superintendent", "Incharge Nurse", "Incharge", "Senior Executive",
             "Consultant", "Duty Medical Officer", "Pharmacist", "Dietician",
             "Senior Technician", "Engineer", "Supervisor", "Executive", "Technician"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    in_dept = collections.defaultdict(collections.Counter)
    heads = collections.Counter()
    for (attrs,) in con.execute("SELECT attrs FROM company_entities WHERE type='Employee'").fetchall():
        d = json.loads(attrs) if isinstance(attrs, str) else (attrs or {})
        dept, title = str(d.get("department") or "").strip(), str(d.get("jobTitle") or "").strip()
        if title:
            heads[title] += 1
            if dept:
                in_dept[dept][title] += 1
    real_depts = {r[0] for r in con.execute("SELECT DISTINCT name FROM org_nodes WHERE kind='Department'").fetchall()}

    def pick(dept: str, preferred: str) -> tuple[str, str]:
        if preferred in heads:
            return preferred, ("works in " + dept if preferred in in_dept.get(dept, {})
                               else "designation held elsewhere in the hospital")
        for role in SENIORITY:
            if role in in_dept.get(dept, {}):
                return role, "senior-most designation recorded in " + dept
        return "", ""

    rows = con.execute("SELECT id, name, control_type FROM controls WHERE id LIKE 'ctl-%' ORDER BY name").fetchall()
    plan, roles_needed, depts_needed = [], set(), set()
    for r in rows:
        d = dict(r)
        area = d["name"].split(" — ")[0]
        dept, preferred = BY_TYPE.get(d["control_type"]) or PLAN.get(area, ("Administration", "Manager"))
        role, why = pick(dept, preferred)
        if dept not in real_depts:
            dept = "Administration"
        plan.append((d["id"], d["name"], dept, role, why))
        roles_needed.add(role); depts_needed.add(dept)
    roles_needed.discard("")

    by_pair = collections.Counter((p[2], p[3]) for p in plan)
    print("every control assigned to a department and an owning designation:\n")
    print("   %-26s %-26s %s" % ("department", "designation", "controls"))
    for (dept, role), n in by_pair.most_common():
        print("   %-26s %-26s %4d   (%d hold it)" % (dept[:26], role or "— none —", n, heads.get(role, 0)))

    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return

    ids = {}
    for name in sorted(depts_needed):
        rid = f"peo-dept-{_slug(name)}"
        ids[("dept", name)] = rid
        con.execute("""INSERT INTO company_entities (id, domain, name, type, description,
                 verification, attrs, source, source_reference, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE
              SET description = EXCLUDED.description, updated_at = EXCLUDED.updated_at""",
            (rid, "people", name, "Department",
             f"{sum(in_dept.get(name, {}).values())} people record this department.",
             "Pending", json.dumps({"headcount": sum(in_dept.get(name, {}).values()),
                                    "derivedFrom": "the employee register and the org structure"}),
             "derived from the employee register", "department", _now(), _now()))
    for name in sorted(roles_needed):
        rid = f"peo-role-{_slug(name)}"
        ids[("role", name)] = rid
        con.execute("""INSERT INTO company_entities (id, domain, name, type, description,
                 verification, attrs, source, source_reference, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE
              SET description = EXCLUDED.description, updated_at = EXCLUDED.updated_at""",
            (rid, "people", name, "Role", f"{heads.get(name, 0)} people hold this designation.",
             "Pending", json.dumps({"headcount": heads.get(name, 0),
                                    "derivedFrom": "the employee register"}),
             "derived from the employee register", "jobTitle", _now(), _now()))

    con.executemany("UPDATE controls SET owner_id = ?, entity_id = ?, updated_at = ? WHERE id = ?",
                    [(ids.get(("role", role)), ids[("dept", dept)], _now(), cid)
                     for cid, _, dept, role, _ in plan])
    con.commit()
    print(f"\nwritten: {len(plan)} controls assigned, "
          f"{len(depts_needed)} departments and {len(roles_needed)} roles recorded")


if __name__ == "__main__":
    main()
