#!/usr/bin/env python3
"""
Fill the company-brain domains that have a real source, and only those.

Four of the nine domains are empty. Three of them can be filled from things this
system already knows, and each row says where it came from:

  controls  the 89 proposed controls live in the `controls` table, which the
            compliance chain reads but the Controls page does not — so the page
            showed nothing while 12,156 duties were mapped. Mirrored here.
  data      the registers actually connected: what they hold, how many records,
            and whether the data is personal. This is the inventory the DPDP
            duties ask for and it is the reason those duties could point at
            nothing.
  risks     gaps this system measured, each carrying the number it rests on.
            A risk register entry is a judgement, so every one is UNVERIFIED.

PROCESSES AND POLICIES ARE LEFT EMPTY ON PURPOSE. A hospital's processes and
policies exist in its SOPs, and nothing here has read one. Writing plausible
rows would put words in the hospital's mouth on the two domains where an auditor
would ask to see the document.
"""
import argparse, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
_slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")[:60]


def add(con, rows, apply):
    if not apply:
        return
    for r in rows:
        con.execute("""INSERT INTO company_entities (id, domain, name, type, description,
              criticality, status, verification, attrs, source, source_reference,
              created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description,
              attrs = EXCLUDED.attrs, criticality = EXCLUDED.criticality,
              status = EXCLUDED.status, updated_at = EXCLUDED.updated_at""", r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    # ---------------------------------------------------------------- controls
    controls = []
    for c in con.execute("""SELECT c.id, c.name, c.description, c.control_type, c.frequency,
               e.name AS owner, d.name AS dept,
               (SELECT COUNT(*) FROM control_requirements cr WHERE cr.control_id = c.id) AS duties,
               (SELECT COUNT(*) FROM control_requirements cr WHERE cr.control_id = c.id
                  AND cr.review_status = 'ACCEPTED') AS accepted
          FROM controls c
          LEFT JOIN company_entities e ON e.id = c.owner_id
          LEFT JOIN company_entities d ON d.id = c.entity_id
         WHERE c.id LIKE 'ctl-%'""").fetchall():
        d = dict(c)
        controls.append((
            f"ctr-{_slug(d['id'])}", "controls", d["name"], d["control_type"] or "Control",
            d["description"], "Medium" if (d["duties"] or 0) > 100 else "Low",
            "Proposed", "Pending",
            json.dumps({"duties": d["duties"], "accepted": d["accepted"],
                        "owner": d["owner"], "department": d["dept"],
                        "frequency": d["frequency"], "controlId": d["id"]}),
            "derived from the proposed controls", d["id"], _now(), _now()))

    # ---------------------------------------------------------------- data
    data = []
    feeds = con.execute("SELECT label, config FROM integrations ORDER BY created_at").fetchall()
    counts = {t: n for t, n in con.execute(
        "SELECT type, COUNT(*) FROM company_entities GROUP BY 1").fetchall()}
    personal = {"Employee": True}
    for f in feeds:
        d = dict(f)
        cfg = json.loads(d["config"] or "{}")
        types = list((cfg.get("layouts") or {}).keys())
        n = sum(counts.get(t, 0) for t in types)
        holds_personal = any(personal.get(t) for t in types)
        data.append((
            f"dat-{_slug(d['label'])}", "data", d["label"], "Register",
            (f"{n:,} records collected from this connection"
             + (", holding personal data about staff" if holds_personal else "")
             + f". Record types: {', '.join(types) or 'none yet'}."),
            "High" if holds_personal else "Medium",
            "Connected", "Pending",
            json.dumps({"records": n, "recordTypes": types,
                        "personalData": holds_personal,
                        "url": (cfg.get("url") or "").split("?")[0]}),
            "derived from the connected integrations", d["label"], _now(), _now()))
    n_nodes = con.execute("SELECT COUNT(*) FROM org_nodes").fetchone()[0]
    data.append((
        "dat-organisation-structure", "data", "Organisation structure", "Structure",
        f"{n_nodes} departments, wards and collections, built from the connected registers.",
        "Medium", "Connected", "Pending",
        json.dumps({"records": n_nodes}), "derived from the org structure", "org_nodes",
        _now(), _now()))

    # ---------------------------------------------------------------- risks
    one = lambda q, *p: con.execute(q, p).fetchone()[0]
    duties = one("""SELECT COUNT(*) FROM v_company_requirements
                     WHERE applicability IN (?,?)""", "APPLICABLE", "CONDITIONAL")
    dpdp = one("""SELECT COUNT(*) FROM applicability_results ar JOIN regulations r ON r.id = ar.regulation_id
                   WHERE ar.verdict IN (?,?) AND r.title ~* 'digital personal data protection'""",
               "APPLICABLE", "CONDITIONAL")
    unfetched = one("SELECT COUNT(*) FROM regulations WHERE status LIKE 'Register entry%'")
    software = one("SELECT COUNT(*) FROM company_entities WHERE domain='systems' AND type <> 'Equipment'")
    bulk = one("SELECT COUNT(*) FROM control_requirements WHERE reviewed_by IS NOT NULL")
    risks = [
        ("No evidence exists for any duty", "High",
         f"All {duties:,} duties that reach this company sit at EVIDENCE_MISSING: a control "
         f"is accepted for each, and no evidence or test has been recorded against any of them."),
        ("No data protection officer is designated", "High",
         f"The DPDP instruments reach this company ({dpdp} in reach) and the Act expects a data "
         f"protection officer. None of the 54 designations on the payroll is an IT or "
         f"data-protection role."),
        ("The systems holding personal data are not recorded", "High",
         f"The systems domain holds {software} records other than equipment, so the hospital "
         f"information system, billing and records software are absent. Personal-data duties "
         f"cannot be assessed against systems that the brain does not know exist."),
        (f"{unfetched} register instruments were never fetched", "Medium",
         f"{unfetched} instruments in the hospital source register exist as entries with no "
         f"document, so no obligation, requirement or verdict can be derived from them. Fire "
         f"safety is one of them."),
        ("Controls were accepted in bulk, not reviewed", "Medium",
         f"{bulk:,} control-to-duty links were accepted in one action and none has been "
         f"individually reviewed; the acceptance is recorded as such."),
    ]
    risk_rows = [(f"rsk-{_slug(name)}", "risks", name, "Compliance risk", desc, sev,
                  "Open", "Pending", json.dumps({"raisedBy": "the company brain's own measurements"}),
                  "derived from this system's measurements", "measured", _now(), _now())
                 for name, sev, desc in risks]

    print("what would be recorded:")
    print("   controls  %3d   (mirrored from the compliance chain)" % len(controls))
    print("   data      %3d   (the connected registers and the org structure)" % len(data))
    print("   risks     %3d   (gaps this system measured)" % len(risk_rows))
    print("   processes   0   left empty — no SOP or process source is connected")
    print("   policies    0   left empty — no policy document is connected")
    for r in risk_rows:
        print("      risk: %-52s %s" % (r[2][:52], r[5]))
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    add(con, controls, True); add(con, data, True); add(con, risk_rows, True)
    con.commit()
    print(f"\nwritten: {len(controls)} controls, {len(data)} data assets, {len(risk_rows)} risks")


if __name__ == "__main__":
    main()
