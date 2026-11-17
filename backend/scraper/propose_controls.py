#!/usr/bin/env python3
"""
Propose controls for the duties that reach this company.

WHAT A PROPOSAL IS AND IS NOT
-----------------------------
A control is a measure the COMPANY runs — an SOP, a register, a renewal
calendar, a training programme. This database has none, which is why all 10,730
duties read NOT_ASSESSED: compliance derives from approved control → evidence →
test, and the chain had no first link.

Nothing here asserts that a control EXISTS. Every control is written with no
owner, no effectiveness and no test date, and every link lands UNREVIEWED with
fact_class SYSTEM_DERIVATION. They are a starting shape for a compliance
officer to accept, rename or throw away — a proposal, not a finding.

HOW THEY ARE GROUPED
--------------------
One control per (what this company IS, what kind of duty it is): the family the
engine matched — hospital, pharmacy, waste generator, employer, data fiduciary —
crossed with the obligation type the extractor classified — DOCUMENTATION,
REPORTING, TRAINING. That mirrors how a compliance function is actually
organised: a biomedical-waste records SOP, a staff training programme, a licence
renewal calendar. Grouping per requirement would give 10,730 "controls" and
group per regulation would give 251, neither of which anyone can operate.
"""
import argparse, json, pathlib, sys, collections
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect        # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

AREA = {
    "hospital": "Clinical establishment", "pharmacy": "Pharmacy and drugs",
    "genetic clinic": "PCPNDT and imaging", "waste generator": "Biomedical waste",
    "employer": "Workforce", "food business operator": "Food safety",
    "data fiduciary": "Personal data", "building occupier": "Building and fire safety",
    "approved place": "MTP services", "principal employer": "Contract labour",
    "laboratory": "Laboratory", "blood centre": "Blood centre",
    "practitioner": "Clinical practitioners", "licensee": "Licensed activity",
    "radiation": "Radiation safety", "occupier": "Premises",
}
ACTIVITY = {
    "DOCUMENTATION": "documentation", "GOVERNANCE": "governance",
    "REPORTING": "periodic reporting", "APPROVAL": "approvals",
    "REGISTRATION": "registration and renewals", "TRAINING": "training",
    "POLICY": "policy", "MONITORING": "monitoring", "LICENSING": "licences",
    "RECORD_KEEPING": "record keeping", "NOTIFICATION": "notifications",
    "DISCLOSURE": "disclosures", "AUDIT": "audit", "DATA_RETENTION": "data retention",
    "KYC": "identity checks", "RISK_MANAGEMENT": "risk management",
    "CYBERSECURITY": "information security", "AML": "anti-money-laundering",
}
_slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    origin_of = {}
    for r in con.execute("""SELECT regulation_id, checks FROM applicability_results
                             WHERE verdict IN ('APPLICABLE','CONDITIONAL')""").fetchall():
        for c in json.loads(r["checks"] or "[]"):
            if c.get("name") == "Entity type" and c.get("result") == "MATCH" and c.get("family"):
                origin_of[r["regulation_id"]] = (c["family"], c.get("origin") or "the company profile")
                break

    rows = con.execute("""
        SELECT cri.id AS cri_id, q.id AS req_id, q.regulation_id, q.frequency,
               COALESCE(o.obligation_type, 'DOCUMENTATION') AS otype
          FROM company_requirement_instances cri
          JOIN applicability_results ar ON ar.id = cri.applicability_result_id
          JOIN requirements q ON q.id = cri.requirement_id
          LEFT JOIN obligations o ON o.id = q.obligation_id
         WHERE ar.verdict IN ('APPLICABLE','CONDITIONAL')""").fetchall()
    print(f"[controls] {len(rows):,} duties reach this company", flush=True)

    groups = collections.defaultdict(list)
    skipped = 0
    for r in rows:
        d = dict(r)
        fam = origin_of.get(d["regulation_id"])
        if not fam:
            skipped += 1          # reached us as "Regulated Entities" — names no fact of ours
            continue
        groups[(fam[0], d["otype"], fam[1])].append(d)

    controls, links = [], []
    for (family, otype, origin), duties in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        area = AREA.get(family, family.title())
        activity = ACTIVITY.get(otype, otype.replace("_", " ").lower())
        cid = f"ctl-{_slug(family)}-{_slug(otype)}"
        regs = len({d["regulation_id"] for d in duties})
        freqs = collections.Counter(d["frequency"] for d in duties if d["frequency"])
        controls.append((
            cid, f"{area} — {activity}",
            (f"Proposed control covering {len(duties):,} {activity} duties from {regs} "
             f"regulation(s) that reach this company because of its {origin}. Grouped from "
             f"the duties themselves — no owner, no evidence and no test yet, and nothing "
             f"here asserts the control exists."),
            otype, (freqs.most_common(1)[0][0] if freqs else None),
            None, None, None, None, None, None, _now(), _now()))
        for d in duties:
            links.append((cid, d["req_id"],
                          f"A {activity} duty arising from this company's {origin}.",
                          "SYSTEM_DERIVATION", "UNREVIEWED", _now(), d["cri_id"],
                          None, "SYSTEM_DERIVATION", "COVERS",
                          "obligation-type grouping/1", 0.5))

    print(f"[controls] {len(controls)} controls proposed, {len(links):,} duty links")
    if skipped:
        print(f"[controls] {skipped:,} duties reach us as 'Regulated Entities' and name no "
              f"fact of ours, so they are left unmapped rather than filed under a guess")
    print()
    for c in controls[:18]:
        print("   %-46s %s" % (c[1], c[2][:1].lower() + c[2][1:46]))
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return

    con.execute("DELETE FROM control_requirements WHERE mapped_by = ?", ("SYSTEM_DERIVATION",))
    con.execute("DELETE FROM controls WHERE id LIKE ?", ("ctl-%",))
    con.executemany(
        "INSERT INTO controls (id, name, description, control_type, frequency, automated, "
        "entity_id, owner_id, effectiveness, last_tested, next_test_due, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", controls)
    con.executemany(
        "INSERT INTO control_requirements (control_id, requirement_id, rationale, mapped_by, "
        "review_status, created_at, cri_id, derived_from, fact_class, relationship_type, "
        "mapping_method, confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", links)
    con.commit()
    print(f"\nwritten: {len(controls)} proposed controls, {len(links):,} links, all UNREVIEWED")


if __name__ == "__main__":
    main()
