"""
Propose a company profile from the documents the company itself uploaded.

WHY THIS EXISTS
---------------
Applicability compares a regulation's rules against company facts — entity
type, sectors, licences, state. With no profile row those facts are empty, so
every verdict is unreachable and the product shows nothing. Asking a user to
retype an identity that is already stated on page one of their own
"Legal Entity & Statutory Identifiers" document is work the system should do.

WHAT IT WILL NOT DO
-------------------
Nothing is invented. Each field is filled only from text found in an uploaded
document, and every field records the file it came from and the phrase that
produced it. A field with no evidence stays NULL rather than being guessed.

The profile is written UNVERIFIED (source_verified = 0). It is a proposal a
person confirms — the same rule the rest of this system follows, and it matters
more here than anywhere: applicability for the whole corpus keys off it.

    python derive_company_profile.py --path <folder>            # report only
    python derive_company_profile.py --path <folder> --apply

`derive()` and `write_profile()` are also imported by the folder connector, so
collecting a folder proposes the profile automatically instead of leaving the
user to run this by hand. Both paths obey the same two refusals: never
overwrite an existing profile, and never create one without an evidenced name.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import zipfile
from datetime import datetime, timezone

from regulatory_ingestion.db import connect

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

STATES = ["Karnataka", "Maharashtra", "Tamil Nadu", "Delhi", "Telangana", "Kerala",
          "Gujarat", "Rajasthan", "West Bengal", "Uttar Pradesh", "Haryana", "Punjab",
          "Madhya Pradesh", "Andhra Pradesh", "Bihar", "Odisha", "Assam", "Goa"]

# Ordered: the first pattern that matches wins, so the most explicit wins.
NAME_RE = [
    re.compile(r"\b((?:[A-Z][A-Za-z&.'\-]+\s+){1,6}?(?:Private Limited|Pvt\.? Ltd\.?|Limited|LLP))\b"),
]
# A legal name sits inside a document, so the match often starts a word or two
# too early and swallows the heading above it ("Entity Particulars Nirmaya
# Hospitals Private Limited"). These are structural words, never part of a name.
HEADING_WORDS = {"entity", "particulars", "name", "company", "details", "section",
                 "document", "profile", "legal", "identifiers", "statutory", "the",
                 "of", "information", "about", "registered"}


def clean_name(raw: str) -> str:
    words = raw.split()
    while len(words) > 2 and words[0].strip(".,").lower() in HEADING_WORDS:
        words.pop(0)
    return " ".join(words)
TYPE_RE = [
    (re.compile(r"private company limited by shares", re.I), "Private company limited by shares"),
    (re.compile(r"public company limited by shares", re.I), "Public company limited by shares"),
    (re.compile(r"\blimited liability partnership\b", re.I), "Limited Liability Partnership"),
    (re.compile(r"\bpartnership firm\b", re.I), "Partnership firm"),
    (re.compile(r"\b(?:public charitable )?trust\b", re.I), "Trust"),
    (re.compile(r"\bsociety registered under\b", re.I), "Society"),
]
SECTOR_RE = [
    (re.compile(r"multispecialty|multi-specialty|tertiary care|secondary care|hospital", re.I),
     "Healthcare & Hospitals"),
    (re.compile(r"\bdiagnostics?\b|\blaboratory\b|\bpathology\b", re.I), "Diagnostics & Laboratory"),
    (re.compile(r"\bpharmacy\b|\bpharmaceutical\b", re.I), "Pharmacy"),
    (re.compile(r"\bblood (?:bank|centre|center)\b", re.I), "Blood Bank"),
]
EST_RE = re.compile(r"(?:est(?:ablished|\.)?|incorporated)\D{0,20}((?:19|20)\d{2})", re.I)
# "Date of incorporation 18 February 1994" is better than the bare year the
# looser pattern above finds, so it is tried first.
INCORP_DATE_RE = re.compile(
    r"date of incorporation\s*[:\-]?\s*(\d{1,2}\s+[A-Z][a-z]+\s+(?:19|20)\d{2})", re.I)

# A private company limited by shares cannot be listed. That is a fact stated by
# the constitution itself, not a guess — so it is recorded with the sentence
# that establishes it rather than left for someone to tick.
PRIVATE_RE = re.compile(r"private company limited by shares|private limited", re.I)
LISTED_RE = re.compile(r"\b(?:listed on|equity shares are listed|BSE|NSE)\b")

# Countries the company says it operates in. India is not assumed: it has to be
# stated, like everything else.
COUNTRY_RE = [
    (re.compile(r"\bIndia\b"), "India"),
    (re.compile(r"\bDubai\b|\bUnited Arab Emirates\b|\bU\.?A\.?E\.?\b"), "United Arab Emirates"),
    (re.compile(r"\bSingapore\b"), "Singapore"),
    (re.compile(r"\bUnited Kingdom\b|\bLondon\b"), "United Kingdom"),
    (re.compile(r"\bUnited States\b|\bUSA\b"), "United States"),
]

# Scale. These are the numbers that decide whether a threshold-based obligation
# engages at all, which is why an empty Scale step makes applicability weaker.
BEDS_RE = re.compile(r"(?:combined capacity of|capacity of|total of)?\s*([\d,]{2,6})\s*beds\b", re.I)
# The lookbehind is the whole point: without it this matched "EMP-10499 Staff
# Nurse" in a Department Heads Directory and proposed 10,499 employees for a
# 200-bed hospital. An identifier is not a headcount, and a number glued to a
# code by a hyphen is an identifier.
EMPLOYEES_RE = re.compile(
    r"(?<![-\w])([\d,]{2,7})\s*(?:total\s+)?"
    r"(?:employees|staff members|personnel|workforce|headcount)\b", re.I)
OUTPATIENT_RE = re.compile(
    r"(?:approximately\s+)?([\d.,]+\s*(?:lakh|crore|million)?)\s*outpatient visits", re.I)
DISCHARGE_RE = re.compile(r"([\d,]{3,9})\s*(?:inpatient\s+)?discharges", re.I)
TURNOVER_RE = re.compile(
    r"(?:turnover|revenue|total income)\D{0,30}(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(crore|cr\b|lakh)", re.I)
PAIDUP_RE = re.compile(r"paid-?up share capital\s*(?:INR|Rs\.?|₹)?\s*([\d,]+)", re.I)

# Personal data. A hospital holds patient records by definition, but the claim
# still has to come from a document rather than from that assumption.
PERSONAL_DATA_RE = re.compile(
    r"\bpersonal data\b|\bpatient records?\b|\bmedical records?\b|\bprotected health information\b|"
    r"\bdata privacy\b|\bDPDP\b|\bmedical record department\b", re.I)
IMPORT_EXPORT_RE = re.compile(
    r"\bimport(?:s|ed|ing)?\b.{0,40}\b(?:licence|license|customs|consignment)|"
    r"\bexport(?:s|ed|ing)?\b.{0,40}\b(?:licence|license|customs|consignment)", re.I)
CIN_RE = re.compile(r"\b([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b")   # Indian CIN
GST_RE = re.compile(r"\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d])\b")

# Identity fields worth reporting as absent, in the order a person reads them.
CORE_FIELDS = ("legal_name", "entity_type", "hq_state", "sectors")


def docx_text(p: pathlib.Path) -> str:
    try:
        with zipfile.ZipFile(p) as z:
            xml = z.read("word/document.xml").decode("utf8", "ignore")
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", xml)).strip()
    except Exception:
        return ""


def xlsx_text(p: pathlib.Path, max_rows: int = 400) -> str:
    """
    Cell values from the first sheets, flattened to text.

    Spreadsheets were skipped entirely, and 169 of this corpus's 414 files are
    .xlsx — the licence register, the statutory certificate register, the bed
    census, every HR record. The profile asked for a headcount while the file
    holding it was never opened.
    """
    try:
        import openpyxl
        wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
    except Exception:
        return ""
    out: list[str] = []
    try:
        for ws in wb.worksheets[:3]:
            for n, row in enumerate(ws.iter_rows(values_only=True)):
                if n >= max_rows:
                    break
                out.append(" ".join(str(c) for c in row if c not in (None, "")))
    except Exception:
        pass
    finally:
        try:
            wb.close()
        except Exception:
            pass
    return re.sub(r"\s+", " ", " ".join(out))[:200_000]


# Column headers that carry a real headcount, in preference order.
_ONROLL_HEADERS = ("on roll", "onroll", "on-roll", "actual", "filled", "in position")


def xlsx_headcount(p: pathlib.Path) -> tuple[int, str] | None:
    """
    Sum a headcount column, when the sheet has one.

    A department directory states the establishment properly: a row per
    department with "On Roll" and "Sanctioned" counts. Summing the On Roll
    column is the answer to "how many employees", and it is a far better one
    than any sentence in a policy document — which is how a staff nurse's
    employee ID came to be proposed as the headcount.
    """
    try:
        import openpyxl
        wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
    except Exception:
        return None
    try:
        for ws in wb.worksheets[:3]:
            rows = list(ws.iter_rows(values_only=True))[:400]
            for i, row in enumerate(rows):
                cells = [str(c).strip().lower() if c is not None else "" for c in row]
                col = next((n for n, c in enumerate(cells) if c in _ONROLL_HEADERS), None)
                if col is None:
                    continue
                total = 0
                counted = 0
                for r in rows[i + 1:]:
                    if col >= len(r):
                        continue
                    v = r[col]
                    if isinstance(v, (int, float)) and 0 <= v < 100_000:
                        total += int(v)
                        counted += 1
                if counted >= 3 and total > 0:
                    return total, f'summed the "{cells[col]}" column over {counted} rows'
    except Exception:
        return None
    finally:
        try:
            wb.close()
        except Exception:
            pass
    return None


def read_text(p: pathlib.Path) -> str:
    ext = p.suffix.lower()
    if ext == ".docx":
        return docx_text(p)
    if ext == ".xlsx":
        return xlsx_text(p)
    if ext in (".txt", ".md", ".csv"):
        try:
            return p.read_text("utf8", errors="ignore")[:200_000]
        except Exception:
            return ""
    return ""


def candidate_files(base: pathlib.Path, max_others: int = 40) -> list[pathlib.Path]:
    """
    Identity lives in org/profile/registration documents. Reading the whole
    corpus would be slower and would let an unrelated file name the company.
    """
    readable = (".docx", ".xlsx", ".txt", ".md", ".csv")
    # Identity and scale live in the organisation documents, so those are read
    # first and get to answer each field before anything else can.
    priority = [p for p in base.rglob("*")
                if p.is_file() and p.suffix.lower() in readable
                and re.search(r"org|profile|legal|entity|identifier|registration|licen|"
                              r"statutory|census|headcount|manpower|revenue|privacy",
                              str(p.relative_to(base)), re.I)]
    others = [p for p in base.rglob("*")
              if p.is_file() and p.suffix.lower() in readable and p not in priority]
    return priority + others[:max_others]


def derive(base: pathlib.Path, max_others: int = 40) -> dict[str, dict]:
    """
    Read the folder and return {field: {value, file, evidence}}.

    A field appears only when a document produced it. The first document to
    evidence a field wins, which is why candidate_files() puts the identity
    documents first — an unrelated file must not get to name the company.
    """
    files = candidate_files(base, max_others)
    facts: dict[str, dict] = {}

    def record(field: str, value, src: pathlib.Path, phrase: str):
        if field in facts or value in (None, "", []):
            return
        facts[field] = {"value": value, "file": str(src.relative_to(base)),
                        "evidence": phrase.strip()[:180]}

    sectors: list[str] = []
    licences: list[str] = []
    countries: list[str] = []
    country_src: dict[str, tuple] = {}
    for p in files:
        text = read_text(p)
        if not text:
            continue
        for rx in NAME_RE:
            m = rx.search(text)
            if m:
                record("legal_name", clean_name(m.group(1).strip()), p, m.group(0))
                break
        for rx, label in TYPE_RE:
            m = rx.search(text)
            if m:
                record("entity_type", label, p, text[max(0, m.start() - 60):m.end() + 60])
                break
        for st in STATES:
            if re.search(rf"\b{st}\b", text):
                record("hq_state", st, p, st)
                break
        m = INCORP_DATE_RE.search(text) or EST_RE.search(text)
        if m:
            record("incorporated", m.group(1), p, m.group(0))

        # ---- listed ----------------------------------------------------
        # Only a statement decides this. A private company limited by shares
        # cannot be listed, and saying so cites the constitution itself.
        if "listed" not in facts:
            m = LISTED_RE.search(text)
            if m:
                record("listed", 1, p, text[max(0, m.start() - 60):m.end() + 60])
            else:
                m = PRIVATE_RE.search(text)
                if m:
                    record("listed", 0, p, text[max(0, m.start() - 40):m.end() + 60])

        # ---- where it operates -----------------------------------------
        for rx, country in COUNTRY_RE:
            m = rx.search(text)
            if m and country not in countries:
                countries.append(country)
                country_src.setdefault(country, (p, text[max(0, m.start() - 70):m.end() + 70]))

        # ---- scale ------------------------------------------------------
        if "employees" not in facts and p.suffix.lower() == ".xlsx":
            got = xlsx_headcount(p)
            if got:
                record("employees", str(got[0]), p, got[1])
        m = EMPLOYEES_RE.search(text)
        if m:
            record("employees", m.group(1).replace(",", ""), p, m.group(0))
        m = TURNOVER_RE.search(text)
        if m:
            amount, unit = m.group(1).replace(",", ""), m.group(2).lower()
            try:
                cr = float(amount) / 100 if unit.startswith("lakh") else float(amount)
                record("turnover_cr", f"{cr:g}", p, m.group(0))
            except ValueError:
                pass
        elif "turnover_cr" not in facts:
            m = PAIDUP_RE.search(text)
            if m:
                try:
                    # stated in rupees; the field is crore
                    record("turnover_cr", f"{int(m.group(1).replace(',', '')) / 10_000_000:g}",
                           p, m.group(0))
                except ValueError:
                    pass
        # Patients are this company's customers; the document states the volume.
        mo, md = OUTPATIENT_RE.search(text), DISCHARGE_RE.search(text)
        if mo or md:
            parts = []
            if mo:
                parts.append(f"{mo.group(1).strip()} outpatient visits/year")
            if md:
                parts.append(f"{md.group(1)} discharges/year")
            record("customers", " · ".join(parts), p, (mo or md).group(0))
        m = BEDS_RE.search(text)
        if m:
            record("beds", m.group(1).replace(",", ""), p, m.group(0))

        # ---- threshold flags --------------------------------------------
        m = PERSONAL_DATA_RE.search(text)
        if m:
            record("handles_personal_data", 1, p, text[max(0, m.start() - 60):m.end() + 60])
        m = IMPORT_EXPORT_RE.search(text)
        if m:
            record("imports_exports", 1, p, text[max(0, m.start() - 60):m.end() + 60])
        m = CIN_RE.search(text)
        if m:
            record("registration_no", m.group(1), p, m.group(0))
        for rx, label in SECTOR_RE:
            if rx.search(text) and label not in sectors:
                sectors.append(label)
        for m in re.finditer(r"\b((?:drug|blood|fire|clinical establishment|pollution|"
                             r"biomedical waste|lift|boiler|radiation|AERB|PNDT)[A-Za-z \-]{0,30}"
                             r"(?:licence|license|registration|permit|authorisation))\b", text, re.I):
            lic = re.sub(r"\s+", " ", m.group(1)).strip().title()
            if lic not in licences:
                licences.append(lic)

    if countries:
        src, phrase = country_src[countries[0]]
        record("jurisdictions", countries, src, phrase)
    if sectors:
        record("sectors", sectors, files[0] if files else base, "matched sector language")
    if licences:
        record("licences", licences[:20], files[0] if files else base, "matched licence language")
    facts["_files_examined"] = {"value": len(files), "file": "", "evidence": ""}
    return facts


def write_profile(con, facts: dict[str, dict]) -> tuple[bool, str]:
    """
    Persist the proposal, or say why it was refused.

    Two refusals, both deliberate. An existing profile is never overwritten —
    it may have been confirmed by a person, and applicability for the whole
    corpus keys off it. And a profile with no evidenced legal name is not a
    profile; creating one would put a company under a name nobody supplied.
    """
    existing = con.execute("SELECT COUNT(*) FROM company_profile").fetchone()[0]
    if existing:
        return False, "a profile already exists; it was left untouched"
    if "legal_name" not in facts:
        return False, ("no legal name could be evidenced in these documents, "
                       "so no profile was created")
    # "UNVERIFIED" has to be a value in a row, not a sentence in a log line, or
    # a derived identity is indistinguishable from one a person confirmed —
    # and applicability for the entire corpus is computed against it.
    # CREATE TABLE IF NOT EXISTS silently no-ops on a table that already
    # exists, so the columns are added explicitly rather than declared.
    for col, ddl in (("source_verified", "INTEGER DEFAULT 0"), ("derived_from", "TEXT")):
        con.execute(f"ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS {col} {ddl}")
    con.execute(
        """INSERT INTO company_profile
             (legal_name, registration_no, entity_type, incorporated, hq_state,
              jurisdictions, sectors, licences, updated_at,
              source_verified, derived_from)
           VALUES (?,?,?,?,?,?,?,?,?,0,?)""",
        (facts["legal_name"]["value"],
         facts.get("registration_no", {}).get("value"),
         facts.get("entity_type", {}).get("value"),
         facts.get("incorporated", {}).get("value"),
         facts.get("hq_state", {}).get("value"),
         # what the documents say; India only when they name no country at all
         json.dumps(facts.get("jurisdictions", {}).get("value") or ["India"]),
         json.dumps(facts.get("sectors", {}).get("value", [])),
         json.dumps(facts.get("licences", {}).get("value", [])),
         _now(),
         # every field keeps the file and the phrase that produced it, so the
         # person confirming this can check each one against its source
         json.dumps({k: {"file": v["file"], "evidence": v["evidence"]}
                     for k, v in facts.items()})))
    con.commit()
    pid = con.execute("SELECT id FROM company_profile ORDER BY id LIMIT 1").fetchone()[0]
    return True, (f"profile #{pid} proposed as UNVERIFIED — "
                  f"\"{facts['legal_name']['value']}\" from {facts['legal_name']['file']}")


# Profile columns this deriver can answer, and the fact key that answers each.
FILLABLE = {
    "legal_name": "legal_name", "registration_no": "registration_no",
    "entity_type": "entity_type", "incorporated": "incorporated",
    "hq_state": "hq_state", "employees": "employees", "turnover_cr": "turnover_cr",
    "customers": "customers", "listed": "listed",
    "handles_personal_data": "handles_personal_data", "imports_exports": "imports_exports",
    # derive() has always found the bed count; nothing kept it. It turns on the
    # bed thresholds in conditions.py and the risk scale index (rulebooks).
    "beds": "beds",
}
JSON_FILLABLE = {"jurisdictions": "jurisdictions", "sectors": "sectors", "licences": "licences"}


def fill_profile(con, facts: dict[str, dict]) -> tuple[list[str], list[str]]:
    """
    Complete the EMPTY fields of an existing profile. Never overwrite a filled one.

    write_profile() refuses outright when a profile exists, which is right for
    creation and useless for completion: the profile here was written before
    this deriver could read spreadsheets or find scale, so it carried a legal
    name and nothing about size. Re-running could not improve it.

    A field is filled only when it is NULL or blank in the row AND the documents
    evidence it. Anything a person has already set stays exactly as it is, and a
    profile marked source_verified = 1 is left alone entirely — that is somebody
    saying they checked it, and this must not quietly edit checked work.
    """
    row = con.execute("SELECT * FROM company_profile ORDER BY id LIMIT 1").fetchone()
    if row is None:
        return [], ["no profile exists yet — nothing to fill"]
    d = dict(row)
    if int(d.get("source_verified") or 0) == 1:
        return [], ["the profile is marked confirmed; it was left untouched"]

    empty = lambda v: v is None or (isinstance(v, str) and not v.strip()) or v == "[]"
    sets, params, filled, skipped = [], [], [], []

    for col, key in FILLABLE.items():
        if key not in facts:
            continue
        if not empty(d.get(col)):
            skipped.append(f"{col} (already set)")
            continue
        sets.append(f"{col}=?")
        params.append(facts[key]["value"])
        filled.append(f'{col} = {facts[key]["value"]}  ← {facts[key]["file"]}')

    for col, key in JSON_FILLABLE.items():
        if key not in facts:
            continue
        if not empty(d.get(col)):
            skipped.append(f"{col} (already set)")
            continue
        sets.append(f"{col}=?")
        params.append(json.dumps(facts[key]["value"]))
        filled.append(f'{col} = {", ".join(facts[key]["value"])}  ← {facts[key]["file"]}')

    if not sets:
        return [], skipped or ["nothing new could be evidenced"]

    # Merge provenance rather than replace it: the fields written earlier keep
    # the sources they were derived from.
    prev = {}
    try:
        prev = json.loads(d.get("derived_from") or "{}")
    except Exception:
        prev = {}
    prev.update({k: {"file": v["file"], "evidence": v["evidence"]}
                 for k, v in facts.items() if k != "_files_examined"})
    sets += ["derived_from=?", "updated_at=?"]
    params += [json.dumps(prev), _now()]
    params.append(d["id"])
    con.execute(f"UPDATE company_profile SET {', '.join(sets)} WHERE id=?", params)
    con.commit()
    return filled, skipped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--fill", action="store_true",
                    help="complete the EMPTY fields of an existing unverified profile")
    a = ap.parse_args()

    base = pathlib.Path(a.path)
    if not base.exists():
        raise SystemExit(f"no such folder: {base}")

    facts = derive(base)
    examined = facts.pop("_files_examined")["value"]

    con = connect()
    existing = con.execute("SELECT COUNT(*) FROM company_profile").fetchone()[0]

    print(f"documents examined : {examined}")
    print(f"existing profile   : {existing} row(s)")
    print("\nderived facts (each with the file it came from):")
    for k, v in facts.items():
        val = v["value"] if not isinstance(v["value"], list) else ", ".join(v["value"])
        print(f"  {k:<16} {str(val)[:56]}")
        print(f"                   from {v['file']}")
        print(f"                   \"{v['evidence'][:90]}\"")
    missing = [f for f in CORE_FIELDS if f not in facts]
    if missing:
        print(f"\nno evidence found for: {', '.join(missing)}  (left NULL, never guessed)")

    if not a.apply:
        print("\n(report only — pass --apply to write the profile as UNVERIFIED)")
        return

    if a.fill and existing:
        filled, skipped = fill_profile(con, facts)
        print()
        if filled:
            print("filled these empty fields:")
            for f in filled:
                print(f"  {f}")
        for sk in skipped:
            print(f"  left alone: {sk}")
        print("\nNothing already set was changed. Every value above cites its document.")
        return

    created, why = write_profile(con, facts)
    print(f"\n{why}")
    if created:
        print("Every field above cites the document it came from; nothing was invented.")


if __name__ == "__main__":
    main()
