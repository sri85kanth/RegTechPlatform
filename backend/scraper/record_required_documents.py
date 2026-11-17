#!/usr/bin/env python3
"""
Record the SOPs and policies a working multi-speciality hospital is expected to
hold — as REQUIRED documents that are not on file.

WHAT THESE ROWS CLAIM, AND WHAT THEY DO NOT
-------------------------------------------
They do NOT claim Premier Hospital has these documents. Every row carries
status "Not documented", verification "Pending", and a source that says so in
words: standard practice, not a document on file. The moment a real SOP is
uploaded it replaces the placeholder and the status changes.

WHERE EACH PART COMES FROM
--------------------------
The NAMES are the standard document set for a multi-speciality hospital under
the Clinical Establishments Act and NABH practice — that is domain knowledge,
and it is what the hospital asked for.

The REQUIREMENT behind each one is this company's own: the area it belongs to
comes from a licence or fact the engine matched, and the duty count is the
number of documentation, record-keeping, policy or training duties already
mapped to that area's control. So each row can answer "why do we need this?"
with a number from the corpus rather than an assertion.
"""
import argparse, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
_slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")[:56]

# (name, domain, area the duties come from, criticality)
DOCS = [
    # ---- policies
    ("Infection Prevention and Control Policy",      "policies", "Clinical establishment", "High"),
    ("Biomedical Waste Management Plan",             "policies", "Biomedical waste", "High"),
    ("Patient Data Privacy and Consent Policy",      "policies", "Personal data", "High"),
    ("Medical Records Retention Policy",             "policies", "Clinical establishment", "High"),
    ("Drug Storage and Dispensing Policy",           "policies", "Pharmacy and drugs", "High"),
    ("Food Safety and Hygiene Policy",               "policies", "Food safety", "High"),
    ("Fire Safety and Emergency Evacuation Policy",  "policies", "Building and fire safety", "High"),
    ("Employee Health and Safety Policy",            "policies", "Workforce", "High"),
    ("Prevention of Sexual Harassment (POSH) Policy", "policies", "Workforce", "High"),
    ("PCPNDT Compliance Policy",                     "policies", "PCPNDT and imaging", "High"),
    ("Patient Grievance Redressal Policy",           "policies", "Clinical establishment", "Medium"),
    ("Antimicrobial Stewardship Policy",             "policies", "Clinical establishment", "Medium"),
    # ---- processes
    ("Biomedical waste segregation and handover SOP", "processes", "Biomedical waste", "High"),
    ("Hand hygiene and PPE SOP",                      "processes", "Clinical establishment", "High"),
    ("Sterilisation and CSSD SOP",                    "processes", "Clinical establishment", "High"),
    ("Patient registration and consent SOP",          "processes", "Personal data", "High"),
    ("Drug procurement, storage and expiry check SOP", "processes", "Pharmacy and drugs", "High"),
    ("Radiology safety and PCPNDT Form F SOP",        "processes", "PCPNDT and imaging", "High"),
    ("Equipment preventive maintenance SOP",          "processes", "Clinical establishment", "Medium"),
    ("Incident and sentinel event reporting SOP",      "processes", "Clinical establishment", "High"),
    ("Fire drill and evacuation SOP",                 "processes", "Building and fire safety", "High"),
    ("Staff induction and annual training SOP",       "processes", "Workforce", "Medium"),
    ("Licence and certificate renewal tracking SOP",  "processes", "Clinical establishment", "High"),
    ("Kitchen hygiene and food handler health check SOP", "processes", "Food safety", "Medium"),
    ("Linen and laundry handling SOP",                "processes", "Clinical establishment", "Medium"),
    ("Ambulance and patient transport readiness SOP", "processes", "Clinical establishment", "Medium"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    # duties that demand documentation, per area, plus who would own it
    # The owner is the one that owns MOST of the area's controls, not the first
    # one alphabetically: picking by name gave every clinical document to the HR
    # Director because one training control sits with HR.
    areas: dict[str, dict] = {}
    for r in con.execute("""
        SELECT SPLIT_PART(c.name, ' — ', 1) AS area, e.name AS owner, d.name AS dept,
               COUNT(cr.id) AS duties
          FROM controls c
          JOIN control_requirements cr ON cr.control_id = c.id
          LEFT JOIN company_entities e ON e.id = c.owner_id
          LEFT JOIN company_entities d ON d.id = c.entity_id
         WHERE c.control_type IN ('DOCUMENTATION','POLICY','RECORD_KEEPING','TRAINING','MONITORING')
         GROUP BY 1,2,3 ORDER BY 4 DESC""").fetchall():
        d = dict(r)
        a_ = areas.setdefault(d["area"], {"duties": 0, "owner": d["owner"], "dept": d["dept"]})
        a_["duties"] += d["duties"] or 0          # every control in the area
        # rows arrive heaviest-first, so the first owner seen carries the most

    rows, unbacked = [], []
    for name, domain, area, crit in DOCS:
        info = areas.get(area)
        n = info["duties"] if info else 0
        if not info:
            unbacked.append((name, area))
        rows.append((
            f"{'pol' if domain == 'policies' else 'prc'}-{_slug(name)}", domain, name,
            "Policy" if domain == "policies" else "Process",
            (f"Expected of a multi-speciality hospital and required here: {n:,} documentation, "
             f"record-keeping, policy or training duties reach this hospital in the {area} area, "
             f"which is what this document exists to answer. No document is on file — this row "
             f"records the requirement, not a document."
             if n else
             f"Expected of a multi-speciality hospital ({area}). No duties are mapped to this "
             f"area yet and no document is on file."),
            crit, "Not documented", "Pending",
            json.dumps({"area": area, "dutiesInThisArea": n,
                        "wouldOwn": (info or {}).get("owner"),
                        "department": (info or {}).get("dept"),
                        "basis": "standard document set for a multi-speciality hospital"}),
            "standard practice for a multi-speciality hospital — not a document on file",
            area, _now(), _now()))

    print("%d documents would be recorded as REQUIRED and NOT ON FILE:\n" % len(rows))
    for r in rows:
        at = json.loads(r[8])
        print("   %-10s %-46s %-24s %5s duties in %s"
              % (r[1], r[2][:46], at["wouldOwn"] or "no owner yet",
                 at["dutiesInThisArea"] or "-", at["area"]))
    if unbacked:
        print("\n   no duties mapped to these areas yet: %s"
              % ", ".join(f"{n} ({a})" for n, a in unbacked))
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    for r in rows:
        con.execute("""INSERT INTO company_entities (id, domain, name, type, description,
              criticality, status, verification, attrs, source, source_reference, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description,
              attrs = EXCLUDED.attrs, updated_at = EXCLUDED.updated_at""", r)
    con.commit()
    print(f"\nwritten: {len(rows)} required documents, every one 'Not documented'")


if __name__ == "__main__":
    main()
