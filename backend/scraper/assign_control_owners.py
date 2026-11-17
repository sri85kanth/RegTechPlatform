#!/usr/bin/env python3
"""
Propose an owner for each proposed control, from designations that exist.

A control nobody owns is not a control. But an owner cannot be invented either:
the name on it has to be a designation this hospital actually employs, or the
first person who reads it will know the screen is decoration.

So every owner here is a designation drawn from the payroll, with the number of
people holding it, and where no designation fits, the control is left UNOWNED
and says so. The DPDP Act expects a data protection officer; this payroll has
no IT or data-protection designation among its 54, and pretending otherwise
would hide exactly the gap a compliance officer needs to see.

Proposed, like the controls themselves: owner_id records a ROLE, never a person
(the org chart must not name staff), and nothing is approved by being written.
"""
import argparse, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# area -> (designation, department). Every designation below is on the payroll.
BY_AREA = {
    "Clinical establishment":   ("Medical Director", "Medical"),
    "Workforce":                ("General Manager", "Operations"),
    "Pharmacy and drugs":       ("Pharmacist", "Pharmacy"),
    "Biomedical waste":         ("Infection Control Nurse", "Nursing"),
    "Food safety":              ("Dietician", "Food & Beverages"),
    "PCPNDT and imaging":       ("Medical Director", "Medical"),
    "Building and fire safety": ("Engineer", "Maintenance"),
    "Contract labour":          ("General Manager", "Operations"),
    "MTP services":             ("Medical Director", "Medical"),
    "Laboratory":               ("Senior Technician", "Laboratory"),
    "Blood centre":             ("Nursing Superintendent", "Nursing"),
    "Clinical practitioners":   ("Medical Director", "Medical"),
    "Radiation safety":         ("Engineer", "Maintenance"),
}
# a duty type that has its own natural owner, whatever the area
BY_TYPE = {"AUDIT": ("Internal Auditor", "Operations"),
           "TRAINING": ("Nursing Superintendent", "Nursing")}
# areas with no designation on this payroll — left unowned ON PURPOSE
UNOWNED = {"Personal data": "no IT or data-protection designation exists on the payroll; "
                            "the DPDP Act expects a data protection officer"}
_slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


def ensure_roles(con, heads, wanted, apply: bool) -> dict:
    """
    A role has to exist as a record before a control can be owned by it —
    controls.owner_id is a foreign key into company_entities, and rightly so: an
    owner the rest of the system cannot see is not an owner.

    Each role is built from the employee register itself: the designation, how
    many people hold it, and the departments they sit in. A designation, never a
    person — the org chart does not name staff.
    """
    made = {}
    for role in sorted(wanted):
        rid = f"peo-role-{_slug(role)}"
        made[role] = rid
        if not apply:
            continue
        con.execute("""INSERT INTO company_entities
              (id, domain, name, type, description, verification, attrs, source,
               source_reference, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (id) DO UPDATE SET attrs = EXCLUDED.attrs, updated_at = EXCLUDED.updated_at""",
            (rid, "people", role, "Role",
             f"{heads.get(role, 0)} people hold this designation.", "Pending",
             json.dumps({"headcount": heads.get(role, 0),
                         "derivedFrom": "the employee register"}),
             "derived from the employee register", "jobTitle", _now(), _now()))
    return made


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    import collections
    heads = collections.Counter()
    for (attrs,) in con.execute("SELECT attrs FROM company_entities WHERE type='Employee'").fetchall():
        d = json.loads(attrs) if isinstance(attrs, str) else (attrs or {})
        if d.get("jobTitle"):
            heads[str(d["jobTitle"]).strip()] += 1

    wanted = {r for r, _ in BY_AREA.values()} | {r for r, _ in BY_TYPE.values()}
    wanted = {r for r in wanted if r in heads}

    rows = con.execute("SELECT id, name, description, control_type FROM controls "
                       "WHERE id LIKE 'ctl-%' ORDER BY name").fetchall()
    role_ids = ensure_roles(con, heads, wanted, a.apply)
    updates, unowned = [], []
    for r in rows:
        d = dict(r)
        area = d["name"].split(" — ")[0]
        if area in UNOWNED:
            unowned.append((d["name"], UNOWNED[area]))
            updates.append((None, d["description"] + f" No owner proposed: {UNOWNED[area]}.",
                            _now(), d["id"]))
            continue
        role, dept = BY_TYPE.get(d["control_type"]) or BY_AREA.get(area, (None, None))
        if not role or role not in heads:
            unowned.append((d["name"], f"designation '{role}' is not on the payroll"))
            updates.append((None, d["description"], _now(), d["id"]))
            continue
        updates.append((role_ids[role],
                        d["description"] + f" Proposed owner: {role} "
                        f"({heads[role]} on the payroll, {dept}) — not yet accepted.",
                        _now(), d["id"]))

    owned = [u for u in updates if u[0]]
    print(f"[owners] {len(owned)} of {len(rows)} controls given a proposed owner\n")
    seen = {}
    for u in updates:
        if u[0]:
            seen[u[0]] = seen.get(u[0], 0) + 1
    name_of = {rid: role for role, rid in role_ids.items()}
    for rid, n in sorted(seen.items(), key=lambda kv: -kv[1]):
        role = name_of.get(rid, rid)
        print("   %-26s %2d controls  (%d on the payroll)" % (role, n, heads.get(role, 0)))
    print("\n   left unowned on purpose:")
    for name, why in unowned:
        print("      %-44s %s" % (name[:44], why[:70]))
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.executemany("UPDATE controls SET owner_id = ?, description = ?, updated_at = ? WHERE id = ?",
                    updates)
    con.commit()
    print(f"\nwritten: {len(owned)} proposed owners, {len(unowned)} left unowned")


if __name__ == "__main__":
    main()
