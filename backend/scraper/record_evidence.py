#!/usr/bin/env python3
"""
Record the certificates as evidence, and link each to the controls it evidences.

WHAT IS AND IS NOT BEING CLAIMED
--------------------------------
The certificate register says a copy of each certificate is on file in Premier
BME ("copiesOnFile"). That is genuine evidence that the licence is held, and it
is the first real link in a chain whose later steps (a test, a finding) still do
not exist.

The DOCUMENT ITSELF IS NOT HERE. Company Brain holds the register entry, not the
scan: `source_system` names where the copy lives and `verification_status` says
it has not been fetched or checked. When the document endpoint is exposed the
file can be attached and verified; until then the row says exactly what it is.

An evidence link moves a duty from EVIDENCE_MISSING to NOT_TESTED. That is the
truthful next state — nobody has tested anything.
"""
import argparse, json, pathlib, sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from regulatory_ingestion.db import connect   # noqa: E402

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
_slug = lambda s: "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")[:56]


def _verification(expiry: str | None) -> str:
    """EXPIRED / EXPIRING from the register's own date; otherwise PENDING_REVIEW."""
    if not expiry:
        return "PENDING_REVIEW"
    try:
        d = datetime.fromisoformat(str(expiry)[:10]).date()
    except ValueError:
        return "PENDING_REVIEW"
    left = (d - datetime.now(timezone.utc).date()).days
    if left < 0:
        return "EXPIRED"
    return "EXPIRING" if left <= 120 else "PENDING_REVIEW"

# which control area a certificate evidences — the same families the engine matched
AREA = {
    "clinical establishment registration": "Clinical establishment",
    "drug licence": "Pharmacy and drugs",
    "pcpndt registration": "PCPNDT and imaging",
    "biomedical waste authorisation": "Biomedical waste",
    "food licence (fssai)": "Food safety",
    "mtp licence": "MTP services",
    "labour licence": "Contract labour",
    "fire noc": "Building and fire safety",
}
# a certificate evidences that a licence is held: registration, licensing and
# the documentation duties that ask for it
EVIDENCES = ("LICENSING", "REGISTRATION", "DOCUMENTATION", "APPROVAL")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    con = connect()

    certs = con.execute("SELECT id, name, attrs, source FROM company_entities "
                        "WHERE type='License' ORDER BY name").fetchall()
    controls = {}
    for c in con.execute("SELECT id, name, control_type FROM controls WHERE id LIKE 'ctl-%'").fetchall():
        d = dict(c)
        controls.setdefault(d["name"].split(" — ")[0], []).append(d)

    ev, links, skipped = [], [], []
    for c in certs:
        d = dict(c)
        at = json.loads(d["attrs"]) if isinstance(d["attrs"], str) else (d["attrs"] or {})
        area = AREA.get(d["name"].strip().lower())
        eid = f"evd-{_slug(d['name'])}"
        ev.append((
            eid, d["name"], "Certificate", None,
            "Premier BME certificate register",
            (at.get("certificateType") or d["name"]),
            None, None, None, at.get("expiryDate"),
            None, None,
            # The register says a copy exists and gives its expiry, so the state
            # is read from the date where there is one. Nobody here has opened
            # the document, so anything not expiring is PENDING_REVIEW rather
            # than VALID — valid would be a claim about a file we have not seen.
            _verification(at.get("expiryDate")), None, None, _now(),
            (f"Issued by {at.get('issuedBy') or 'an authority not recorded'}. "
             f"{at.get('copiesOnFile') or 0} copy on file in the source system; the document "
             f"itself has not been fetched into Company Brain, so it is recorded, not verified."),
            "Held", None, d["id"], None, _now()))
        if not area:
            skipped.append(d["name"])
            continue
        for ctl in controls.get(area, []):
            if ctl["control_type"] in EVIDENCES:
                links.append((eid, ctl["id"], _now()))

    print(f"[evidence] {len(ev)} certificates recorded as evidence")
    print(f"[evidence] {len(links)} links to controls they evidence")
    if skipped:
        print(f"[evidence] not linked (no regulated area): {', '.join(skipped)}")
    for e in ev[:6]:
        print("   %-38s expires %-12s %s" % (e[1][:38], e[9] or "—", (e[16] or "")[:44]))
    if not a.apply:
        print("\n(report only — pass --apply to write)")
        return
    con.executemany("""INSERT INTO evidence (id, name, evidence_type, owner_id, source_system,
          source_location, period_start, period_end, valid_from, valid_until, uploaded_at,
          content_hash, verification_status, reviewer, review_date, created_at, description,
          status, last_verified_at, source_entity_id, source_document_id, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description,
          valid_until = EXCLUDED.valid_until, updated_at = EXCLUDED.updated_at""", ev)
    con.executemany("INSERT INTO evidence_links (evidence_id, control_id, created_at) "
                    "VALUES (?,?,?)", links)
    con.commit()
    print(f"\nwritten: {len(ev)} evidence items, {len(links)} links")


if __name__ == "__main__":
    main()
