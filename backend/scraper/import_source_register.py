"""
Load a curated regulatory SOURCE REGISTER into the system.

A register is not a scrape. Someone sat down, named each instrument, found the
authority that administers it, and recorded which official portal carries the
text — then marked how far they got verifying each one. That work is the value,
so it is stored as given, with its own status flags intact.

WHY A NEW TABLE AND NOT `discovered_regulations`
------------------------------------------------
`discovered_regulations` holds leads a scraper found on a listing page: id,
source, title, detail_url, note. A register carries a domain taxonomy, the
administering authority, the path *within* the portal, a verification status
with its meaning, and hand-written corrections. Forcing it into the lead table
would drop all of that, so `source_register` exists alongside it. Nothing that
already had a home was duplicated.

WHAT IT WILL NOT DO
-------------------
- No document URL is invented. The register deliberately records ROOT PORTALS,
  because deep links on Indian government portals rot; that decision is kept.
- Rows the compiler flagged 'S' are NOT statutes (accreditation standards,
  scheme conditions, guidance). They are typed as such, because filing them
  beside legislation is the structural error the register itself warns about.
- Rows flagged '?' keep their open question in the record.
- Every regulation row created is DISCOVERED — never MAPPED, never given a
  document it does not have.

    python import_source_register.py --file data/registers/hospital_register.json
    python import_source_register.py --file ... --apply
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
from collections import Counter
from datetime import datetime, timezone

from regulatory_ingestion.db import connect

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

SCHEMA = """
CREATE TABLE IF NOT EXISTS source_register (
  id             TEXT PRIMARY KEY,
  register       TEXT NOT NULL,
  seq            INTEGER,
  domain         TEXT,
  instrument     TEXT NOT NULL,
  authority      TEXT,
  portal         TEXT,
  portal_path    TEXT,
  text_source    TEXT,
  status         TEXT,
  status_meaning TEXT,
  notes          TEXT,
  verified_on    TEXT,
  verified_by    TEXT,
  is_statute     BOOLEAN NOT NULL DEFAULT TRUE,
  regulation_id  TEXT,
  source_file    TEXT,
  source_sha256  TEXT,
  imported_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_srcreg_register ON source_register(register);
CREATE INDEX IF NOT EXISTS idx_srcreg_domain   ON source_register(domain);
CREATE INDEX IF NOT EXISTS idx_srcreg_status   ON source_register(status);

CREATE TABLE IF NOT EXISTS source_register_portals (
  id            TEXT PRIMARY KEY,
  register      TEXT NOT NULL,
  portal        TEXT NOT NULL,
  body          TEXT,
  instrument_count TEXT,
  domains       TEXT,
  imported_at   TEXT NOT NULL
);
"""

# 'S' means the compiler judged the row not to be legislation.
STATUS_LABEL = {
    "V": "Portal fetch verified during compilation",
    "D": "Official domain; path within the portal not verified",
    "?": "Open question about the instrument's live status",
    "S": "Standard, scheme condition or guidance — not legislation",
}


def slug(s: str, n: int = 48) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (s or "").lower())).strip("-")[:n]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="the derived .json extract of the register")
    ap.add_argument("--prefix", default="hosp", help="id prefix for rows from this register")
    ap.add_argument("--sector", default="Healthcare & Hospitals")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    doc = json.loads(pathlib.Path(a.file).read_text())
    register, sha, src_file = doc["register"], doc["sha256"], doc["source_file"]
    items, portals = doc["instruments"], doc["portals"]

    con = connect()
    con.executescript(SCHEMA)
    con.commit()

    made_reg = skipped_reg = 0
    status_tally: Counter[str] = Counter()
    for it in items:
        status = (it.get("status") or "").strip()
        status_tally[status] += 1
        is_statute = status != "S"
        rid = f"{a.prefix}-{it['seq']:03d}-{slug(it['instrument'], 40)}"
        srid = f"srcreg-{a.prefix}-{it['seq']:03d}"

        if a.apply:
            con.execute(
                """INSERT INTO source_register
                     (id, register, seq, domain, instrument, authority, portal, portal_path,
                      text_source, status, status_meaning, notes, verified_on, verified_by,
                      is_statute, regulation_id, source_file, source_sha256, imported_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT (id) DO UPDATE SET
                     instrument=EXCLUDED.instrument, authority=EXCLUDED.authority,
                     portal=EXCLUDED.portal, portal_path=EXCLUDED.portal_path,
                     status=EXCLUDED.status, status_meaning=EXCLUDED.status_meaning,
                     notes=EXCLUDED.notes, is_statute=EXCLUDED.is_statute,
                     source_sha256=EXCLUDED.source_sha256, imported_at=EXCLUDED.imported_at""",
                (srid, register, it["seq"], it.get("domain"), it["instrument"], it.get("authority"),
                 it.get("portal"), it.get("portal_path"), it.get("text_source"), status,
                 it.get("status_meaning") or STATUS_LABEL.get(status), it.get("notes"),
                 it.get("verified_on"), it.get("verified_by"), is_statute, rid,
                 src_file, sha, _now()))

        # A regulation row so the instrument is visible and resolvable — always
        # DISCOVERED, because no document has been fetched for it.
        exists = con.execute("SELECT 1 FROM regulations WHERE id=?", (rid,)).fetchone()
        if exists:
            skipped_reg += 1
        else:
            made_reg += 1
        if a.apply:
            con.execute(
                """INSERT INTO regulations
                     (id, title, regulator, regulator_short, regulation_type, sector,
                      jurisdiction, country, source_url, ingestion_status, status,
                      source_verified, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT (id) DO UPDATE SET
                     title=EXCLUDED.title, regulator=EXCLUDED.regulator,
                     source_url=EXCLUDED.source_url, sector=EXCLUDED.sector,
                     regulation_type=EXCLUDED.regulation_type, updated_at=EXCLUDED.updated_at""",
                (rid, it["instrument"], it.get("authority"), it.get("authority"),
                 "Standard / guidance (not legislation)" if not is_statute else "Instrument (register entry)",
                 a.sector, "India", "India", it.get("portal"), "DISCOVERED",
                 "Register entry — document not yet fetched", 0, _now(), _now()))

    # ---- facets -------------------------------------------------------
    # The library filters and the facet rail are built from three join tables,
    # not from regulations.sector / .jurisdiction. Writing only the columns
    # left the 126 imported instruments invisible to every filter — they were
    # in the corpus and unreachable from the UI. Register entries therefore
    # populate the same joins as any other source.
    for it in items:
        rid = f"{a.prefix}-{it['seq']:03d}-{slug(it['instrument'], 40)}"
        blob = " ".join(str(it.get(k) or "") for k in ("instrument", "authority", "portal")).lower()
        karnataka = "karnataka" in blob
        name = (it.get("instrument") or "").lower()
        if (it.get("status") or "") == "S":
            rtype = "Standard"          # NABH/NABL/ISO/PM-JAY/ICMR are not legislation
        elif "rules" in name:
            rtype = "Rule"
        elif "regulation" in name:
            rtype = "Regulation"
        elif "policy" in name or "guideline" in name:
            rtype = "Policy"
        else:
            rtype = "Act"

        if not a.apply:
            continue
        con.execute(
            """INSERT INTO regulation_sectors (regulation_id, sector, derived_from, evidence)
               VALUES (?,?,?,?) ON CONFLICT DO NOTHING""",
            (rid, a.sector, "SOURCE_REGISTER", register))
        con.execute(
            """INSERT INTO regulation_regions
                 (regulation_id, state_ut, region_kind, coverage, derived_from, evidence)
               VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING""",
            (rid, "Karnataka" if karnataka else "*",
             "STATE" if karnataka else "ALL",
             "STATE_SPECIFIC" if karnataka else "ALL_INDIA",
             "SOURCE_REGISTER", register))
        con.execute(
            """INSERT INTO regulation_types (regulation_id, type, source_type)
               VALUES (?,?,?) ON CONFLICT DO NOTHING""",
            (rid, rtype, "Source register entry"))

    for p in portals:
        if a.apply:
            con.execute(
                """INSERT INTO source_register_portals
                     (id, register, portal, body, instrument_count, domains, imported_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body,
                     instrument_count=EXCLUDED.instrument_count, domains=EXCLUDED.domains""",
                (f"srcport-{a.prefix}-{slug(p['portal'], 40)}", register, p["portal"],
                 p.get("body"), p.get("instrument_count"), p.get("domains"), _now()))
    if a.apply:
        con.commit()

    print(f"register        : {register}")
    print(f"source file     : {src_file}  sha256 {sha[:16]}…")
    print(f"instruments     : {len(items)}   portals: {len(portals)}")
    print(f"by status       : {dict(status_tally)}")
    print(f"  of which NOT legislation (S): {status_tally.get('S', 0)}")
    print(f"regulations new : {made_reg}   already present: {skipped_reg}")
    if a.apply:
        n = con.execute("SELECT COUNT(*) FROM source_register WHERE register=?", (register,)).fetchone()[0]
        print(f"source_register : {n} rows now")
    else:
        print("\n(report only — pass --apply to write)")


if __name__ == "__main__":
    main()
