"""
Filter metadata for the regulatory library — the model behind the filter bar.

WHY THIS EXISTS
---------------
The filter vocabulary a compliance officer thinks in (NBFC, Telangana, Master
Direction, Active) is not the vocabulary the scrapers produced. What is actually
stored is one sector string per regulation drawn from a 14-value scraper
taxonomy, `jurisdiction` set to 'India' on every single row, and `status` set to
'Active' on every single row. Filtering directly on those columns gives a
dropdown where 'India' returns everything and every other option returns nothing.

So the filter values are DERIVED here, once, into proper many-to-many tables —
and every derived row records the evidence that produced it. A filter value with
no evidence is not written. That is the whole design: a dropdown option exists
because a record justifies it, never because the option list said so.

THE SEMANTIC RULE THIS ENFORCES
-------------------------------
Where a regulation APPLIES is not who ISSUED it. An RBI Master Direction is
issued centrally and applies in every state, so selecting Telangana must return
it. That is not an inference — an all-India instrument applying India-wide is
what "all-India" means. It is modelled as coverage, not as a row per state:

    coverage = ALL_INDIA        applies everywhere; matches any state selected
    coverage = STATE_SPECIFIC   applies in the named state(s) only

and "applies in X" is `coverage = 'ALL_INDIA' OR state_ut = X`. Storing 1,685
central regulations × 36 states would be 60,660 rows asserting the same fact.

WHAT IS DELIBERATELY NOT DERIVED
--------------------------------
effective_date, version_status and per-regulation applicability verdicts have no
stored data (0 rows each). They are exposed as filters with an explicit
zero-coverage flag rather than being invented, so the UI can tell a user the
filter is unavailable instead of silently returning nothing.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# ---------------------------------------------------------------- vocabularies

STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
    "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
    "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
    "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
    "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
]
UNION_TERRITORIES = [
    "Andaman and Nicobar Islands", "Chandigarh",
    "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
    "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
]
ALL_REGIONS = STATES + UNION_TERRITORIES

# Historical names still used in older instruments. These are RENAMES and
# MERGERS of the same territory, so matching them is evidence about the modern
# region — Orissa is Odisha, and Daman and Diu is part of the merged UT.
#
# Presidency names are deliberately absent. "Bombay" in a colonial act does not
# mean Maharashtra: the Bombay Presidency also covered modern Gujarat and parts
# of Karnataka, and Madras Presidency covered four present-day states. Resolving
# those to one state would put 20 regulations under a state filter on an
# inference that is simply wrong, which is worse than leaving them unassigned.
REGION_ALIASES = {
    "Orissa": "Odisha", "Pondicherry": "Puducherry", "Uttaranchal": "Uttarakhand",
    "Mysore": "Karnataka",
    "NCT of Delhi": "Delhi", "National Capital Territory": "Delhi",
    "Daman and Diu": "Dadra and Nagar Haveli and Daman and Diu",
    "Dadra and Nagar Haveli": "Dadra and Nagar Haveli and Daman and Diu",
}

SECTORS = [
    "NBFC", "Banking", "Insurance", "Securities / Capital Markets", "Pension",
    "Payments", "FinTech", "Digital / IT", "Data Protection", "Cybersecurity",
    "Telecom", "Healthcare", "Pharmaceuticals", "Food", "Manufacturing",
    "Labour & Employment", "Environment", "Energy", "Real Estate",
    "Consumer Protection", "Competition", "Taxation", "Customs & Trade",
    "Corporate / Companies", "ESG", "Other",
]

# The scraper's own sector strings, mapped to the vocabulary above. A source
# value that covers more than one target sector maps to several — which is
# precisely why sectors are many-to-many.
SECTOR_FROM_SOURCE: dict[str, list[str]] = {
    "Banking & Finance": ["Banking"],
    "Securities Markets": ["Securities / Capital Markets"],
    "Insurance": ["Insurance"],
    "Pensions": ["Pension"],
    "Telecom": ["Telecom"],
    "Food Safety": ["Food"],
    "Cyber Security": ["Cybersecurity"],
    "IT & Data Protection": ["Digital / IT", "Data Protection"],
    "Competition Law": ["Competition"],
    "Taxation (GST)": ["Taxation"],
    "Foreign Trade": ["Customs & Trade"],
    "Foreign Exchange (FEMA)": ["Banking"],
    "Environment": ["Environment"],
    # "Central Legislation (all sectors)" is deliberately absent: it asserts
    # nothing about sector, so it is resolved from the title instead.
}

# Title keywords -> sector. Used only where the source sector says nothing.
# Word-boundary matched, because "act" inside "Transaction" is not evidence.
SECTOR_KEYWORDS: list[tuple[str, list[str]]] = [
    (r"non-?banking financial|nbfc", ["NBFC"]),
    (r"\bbank(s|ing)?\b|reserve bank", ["Banking"]),
    (r"insurance|insurer", ["Insurance"]),
    (r"securities|stock exchange|capital market|mutual fund", ["Securities / Capital Markets"]),
    (r"pension|provident fund|gratuity", ["Pension"]),
    (r"payment|prepaid instrument|settlement system", ["Payments"]),
    (r"information technology|electronics|software", ["Digital / IT"]),
    (r"personal data|data protection|privacy", ["Data Protection"]),
    (r"cyber ?security|cert-?in", ["Cybersecurity"]),
    (r"telecom|telegraph|broadcast|spectrum", ["Telecom"]),
    (r"hospital|medical|clinical|public health", ["Healthcare"]),
    (r"drugs?|pharmaceutic|cosmetic", ["Pharmaceuticals"]),
    (r"food safety|food standard", ["Food"]),
    (r"factor(y|ies)|industrial|manufactur", ["Manufacturing"]),
    (r"labour|employment|workmen|wages|trade union|industrial dispute",
     ["Labour & Employment"]),
    (r"environment|pollution|forest|wildlife|biological diversity", ["Environment"]),
    (r"electricity|petroleum|coal|energy|renewable", ["Energy"]),
    (r"real estate|land acquisition|tenanc|rent control", ["Real Estate"]),
    (r"consumer protection|weights and measures", ["Consumer Protection"]),
    (r"competition|monopol", ["Competition"]),
    (r"income[- ]tax|goods and services tax|\bgst\b|stamp duty|excise",
     ["Taxation"]),
    (r"customs|foreign trade|import|export", ["Customs & Trade"]),
    (r"compan(y|ies)|partnership|limited liability", ["Corporate / Companies"]),
]

# Instrument type, from the scraper's own strings.
TYPE_FROM_SOURCE: dict[str, str] = {
    "Central Act": "Act",
    "Act": "Act",
    "Regulation": "Regulation",
    "Master Direction": "Master Direction",
    "FEMA Notification": "Notification",
    "Foreign Trade Policy": "Policy",
    "Direction / Guideline": "Direction",
    "Compendium / Rules": "Rule",
    "Draft Rule": "Rule",
}

SCHEMA = """
-- Many-to-many by design: a regulation covers several sectors, and a filter
-- that stored them as one comma-separated string could not be indexed or
-- counted. Every row carries the evidence that produced it.
CREATE TABLE IF NOT EXISTS regulation_sectors (
  regulation_id TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  sector        TEXT NOT NULL,
  derived_from  TEXT NOT NULL,   -- SOURCE_SECTOR | TITLE_KEYWORD
  evidence      TEXT,            -- the exact string that justified this row
  PRIMARY KEY (regulation_id, sector)
);
CREATE INDEX IF NOT EXISTS idx_rsec_sector ON regulation_sectors(sector);

-- Where the instrument APPLIES. coverage='ALL_INDIA' means every state and UT,
-- and carries state_ut='*' so a single row answers "applies in Telangana?".
CREATE TABLE IF NOT EXISTS regulation_regions (
  regulation_id TEXT NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
  state_ut      TEXT NOT NULL,   -- a named region, or '*' for all-India
  region_kind   TEXT NOT NULL,   -- STATE | UT | ALL
  coverage      TEXT NOT NULL,   -- ALL_INDIA | STATE_SPECIFIC
  derived_from  TEXT NOT NULL,
  evidence      TEXT,
  PRIMARY KEY (regulation_id, state_ut)
);
CREATE INDEX IF NOT EXISTS idx_rreg_state ON regulation_regions(state_ut);
CREATE INDEX IF NOT EXISTS idx_rreg_cover ON regulation_regions(coverage);

-- The scrapers write their own instrument names ("Central Act", "FEMA
-- Notification"). A filter offering the standard vocabulary would show Act = 0
-- while 845 Central Acts sat in the library, so the two are reconciled here.
CREATE TABLE IF NOT EXISTS regulation_types (
  regulation_id TEXT PRIMARY KEY REFERENCES regulations(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  source_type   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rtype ON regulation_types(type);
"""


def init(con) -> None:
    con.executescript(SCHEMA)
    con.commit()


def _norm_type(raw: str | None) -> str:
    return TYPE_FROM_SOURCE.get((raw or "").strip(), "Other")


def _sectors_for(source_sector: str | None, title: str) -> list[tuple[str, str, str]]:
    """(sector, derived_from, evidence) — never guessed, always attributable."""
    out: dict[str, tuple[str, str]] = {}
    src = (source_sector or "").strip()
    for s in SECTOR_FROM_SOURCE.get(src, []):
        out[s] = ("SOURCE_SECTOR", src)

    # A Master Direction filed under "Banking & Finance" may still be an NBFC
    # instrument; the title is the only place that says so.
    low = (title or "").lower()
    for pattern, sectors in SECTOR_KEYWORDS:
        m = re.search(pattern, low)
        if not m:
            continue
        for s in sectors:
            out.setdefault(s, ("TITLE_KEYWORD", m.group(0)))
    return [(s, d, e) for s, (d, e) in out.items()]


def _regions_for(title: str) -> list[tuple[str, str]]:
    """Regions a title explicitly names. (region, matched_text)."""
    found: dict[str, str] = {}
    for alias, canonical in REGION_ALIASES.items():
        if re.search(rf"(?<![A-Za-z]){re.escape(alias)}(?![A-Za-z])", title or "", re.I):
            found.setdefault(canonical, alias)
    for region in ALL_REGIONS:
        if re.search(rf"(?<![A-Za-z]){re.escape(region)}(?![A-Za-z])", title or "", re.I):
            found[region] = region
    return list(found.items())


def rebuild(con, *, apply: bool = False) -> dict:
    """
    Derive every filter facet from the records themselves.

    Idempotent: the derived tables are rebuilt wholesale, and no column on
    `regulations` is written. Nothing in the source data is modified.
    """
    init(con)
    rows = [dict(r) for r in con.execute(
        "SELECT id, title, sector, jurisdiction, regulation_type FROM regulations")]

    sec_rows: list[tuple] = []
    reg_rows: list[tuple] = []
    type_rows: list[tuple] = []
    stats = {"regulations": len(rows), "sectorRows": 0, "unmappedSector": 0,
             "stateSpecific": 0, "allIndia": 0}

    for r in rows:
        type_rows.append((r["id"], _norm_type(r.get("regulation_type")),
                          r.get("regulation_type")))

        found = _sectors_for(r.get("sector"), r.get("title") or "")
        if not found:
            # No evidence for any sector. Recorded as such rather than dropped
            # into "Other", which would make the filter look complete.
            stats["unmappedSector"] += 1
        for s, d, e in found:
            sec_rows.append((r["id"], s, d, (e or "")[:200]))

        named = _regions_for(r.get("title") or "")
        if named:
            stats["stateSpecific"] += 1
            for region, matched in named:
                reg_rows.append((
                    r["id"], region, "UT" if region in UNION_TERRITORIES else "STATE",
                    "STATE_SPECIFIC", "TITLE_REGION", matched[:200]))
        elif (r.get("jurisdiction") or "").strip().lower() == "india":
            # An all-India instrument applies in every state and UT. That is the
            # definition of the jurisdiction, not a guess about coverage.
            stats["allIndia"] += 1
            reg_rows.append((r["id"], "*", "ALL", "ALL_INDIA", "JURISDICTION_INDIA",
                             r.get("jurisdiction")))

    stats["sectorRows"] = len(sec_rows)
    stats["regionRows"] = len(reg_rows)

    if apply:
        con.execute("DELETE FROM regulation_sectors")
        con.executemany(
            "INSERT INTO regulation_sectors (regulation_id,sector,derived_from,evidence) "
            "VALUES (?,?,?,?) ON CONFLICT DO NOTHING", sec_rows)
        con.execute("DELETE FROM regulation_regions")
        con.executemany(
            "INSERT INTO regulation_regions "
            "(regulation_id,state_ut,region_kind,coverage,derived_from,evidence) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", reg_rows)
        con.execute("DELETE FROM regulation_types")
        con.executemany(
            "INSERT INTO regulation_types (regulation_id,type,source_type) "
            "VALUES (?,?,?) ON CONFLICT DO NOTHING", type_rows)
        con.commit()
    stats["applied"] = apply
    return stats


# ---------------------------------------------------------------- availability

# Filters the UI offers, and whether the database can actually answer them.
# Reported to the client so an unavailable filter can say so instead of
# silently returning an empty result set.
def availability(con) -> dict:
    one = lambda q: con.execute(q).fetchone()[0]
    total = one("SELECT COUNT(*) FROM regulations")
    pct = lambda n: round(100 * n / max(total, 1), 1)

    checks = {
        "sector": one("SELECT COUNT(DISTINCT regulation_id) FROM regulation_sectors"),
        "state_ut": one("SELECT COUNT(DISTINCT regulation_id) FROM regulation_regions"),
        "regulator": one("SELECT COUNT(*) FROM regulations WHERE regulator_short <> ''"),
        "regulation_type": one("SELECT COUNT(*) FROM regulations WHERE regulation_type <> ''"),
        "importance": one("SELECT COUNT(*) FROM regulations WHERE impact_level IS NOT NULL AND impact_level <> ''"),
        "collection_status": one("SELECT COUNT(*) FROM regulations WHERE ingestion_status IS NOT NULL"),
        "source_verification": one("SELECT COUNT(*) FROM regulations WHERE source_verified = 1"),
        "applicability": one("SELECT COUNT(DISTINCT regulation_id) FROM applicability_rules"),
        "effective_date": one("SELECT COUNT(*) FROM regulations WHERE effective_from IS NOT NULL AND effective_from <> ''"),
        "issued_date": one("SELECT COUNT(*) FROM regulations WHERE issued_on IS NOT NULL AND issued_on <> ''"),
        "version_status": one("SELECT COUNT(*) FROM regulation_versions"),
        "status": one("SELECT COUNT(DISTINCT status) FROM regulations"),
        "jurisdiction": one("SELECT COUNT(DISTINCT jurisdiction) FROM regulations"),
    }
    notes = {
        "effective_date": "No regulation carries an effective_from date. Issued date is offered instead.",
        "version_status": "No regulation has more than one captured version yet, so version filtering cannot discriminate.",
        "status": "Every record is 'Active' — the column was defaulted, never set from a source. Filtering on it cannot narrow anything.",
        "jurisdiction": "Every record is 'India'. Central instruments apply in all states, which is what the State/UT filter uses.",
        "applicability": "Computed on demand per regulation from applicability_rules; only records that have rules can be evaluated.",
    }
    out = {}
    for key, n in checks.items():
        # status/jurisdiction report DISTINCT values, not coverage
        discriminating = n > 1 if key in ("status", "jurisdiction") else n > 0
        out[key] = {
            "records": n,
            "coveragePct": pct(n) if key not in ("status", "jurisdiction") else None,
            "distinctValues": n if key in ("status", "jurisdiction") else None,
            "available": discriminating,
            "note": notes.get(key),
        }
    out["_total"] = total
    return out
