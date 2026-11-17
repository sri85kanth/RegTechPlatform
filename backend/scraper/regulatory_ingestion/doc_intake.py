"""
Document intake — a folder of the hospital's documents, sorted into the company
structure.

A hospital's documents never arrive the way this system names things. One
manual holds forty policies and SOPs; another hospital keeps one SOP per PDF,
numbers them "SOP/NUR/012" or not at all, scans half of them, and files them in
folders named after whoever saved them. Intake does not ask the hospital to
match our structure. It reads what arrived and files it:

  1. READ      every file — Word, PDF (OCR when the PDF is a scan), images,
               Excel, text, and the files inside a .zip — into ordered blocks.
  2. SPLIT     a file that holds several documents (a manual, a forms pack)
               into one item per document, by the document headers inside it.
  3. SORT      each item: Policy, SOP, Form, Register, Plan, Manual, Job
               description, Licence, Minutes, Contract, Training record, Report.
               Rules first — its own code and title, then its layout, then its
               file and folder names; the local AI only when the rules are unsure.
  4. PLACE     each item in a department: what the document says, the code
               prefix (NUR → Nursing), the folder, then the text. Matched to the
               departments that exist; one that does not is PROPOSED, never made.
  5. PEOPLE    "Prepared / Approved by", owners and custodians, matched to the
               employee directory. A role without a name stays a role.
  6. LINK      an SOP to the policy it names, a form to the SOP that uses it.
  7. SAVE      confident items straight into the company structure (verification
               Pending, as everything collected is); the rest wait on the review
               screen with the reason. A code already on record is not saved twice.

Every item keeps the evidence for each decision ("code NUR-SOP-11", "folder
Nursing", "Approved by: …"), so a person can see why and correct it. A
correction can be REMEMBERED (code prefix → department, type token → type,
folder → department) and is applied to the next upload. A whole upload can be
undone while its records are still unverified.
"""
from __future__ import annotations

import difflib
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import httpx

from .db import connect

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")   # noqa: E731

LLM_BASE = os.environ.get("LOCAL_LLM_BASE_URL", "http://172.22.64.1:8081/v1")
LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "gpt-oss-120b")

READ_EXT = {".docx", ".pdf", ".txt", ".md", ".xlsx", ".xlsm", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".zip"}
UNREADABLE_EXT = {".doc", ".ppt", ".pptx", ".xls", ".rtf", ".odt"}     # no converter on this server: sorted by name only
INTAKE_EXT = READ_EXT | UNREADABLE_EXT
MAX_TEXT = 300_000
OCR_MAX_PAGES = 25
AUTO_TYPE = 75                    # type confidence needed to save without review
NEEDS_DEPARTMENT = {"Policy", "SOP", "Form", "Register", "Plan", "Job description", "Training record"}

# ------------------------------------------------------------------ vocabulary
# type → (company domain, record type) — the same homes the app already uses
HOME = {
    "Policy": ("policies", "Policy"),
    "SOP": ("processes", "SOP"),
    "Form": ("evidence", "Form"),
    "Register": ("evidence", "Register"),
    "Plan": ("policies", "Plan"),
    "Manual": ("evidence", "Manual"),
    "Job description": ("people", "Job description"),
    "Licence": ("overview", "License"),
    "Minutes": ("evidence", "Minutes"),
    "Contract": ("systems", "Agreement"),
    "Training record": ("evidence", "Training record"),
    "Report": ("evidence", "Report"),
    "Other": ("evidence", "Document"),
}
TYPES = list(HOME)

# the type token inside a document code
TYPE_TOKENS = {
    "POL": "Policy", "POLICY": "Policy", "SOP": "SOP", "PROC": "SOP", "PR": "SOP", "WI": "SOP",
    "F": "Form", "FM": "Form", "FRM": "Form", "FORM": "Form", "FMT": "Form", "REG": "Register", "R": "Register",
    "JD": "Job description", "PLAN": "Plan", "PL": "Plan", "MAN": "Manual",
}
TOKEN_CANON = {"POL": "POL", "POLICY": "POL", "SOP": "SOP", "PROC": "SOP", "PR": "SOP", "WI": "WI", "F": "F", "FM": "F",
               "FRM": "F", "FORM": "F", "FMT": "F", "REG": "REG", "R": "R", "JD": "JD", "PLAN": "PLAN", "PL": "PLAN",
               "MAN": "MAN"}
_TOK = "|".join(sorted(TYPE_TOKENS, key=len, reverse=True))
CODE_A = re.compile(rf"\b([A-Z]{{2,6}})[-/_.]({_TOK})[-/_.]?(\d{{1,4}}[A-Z]?)\b")       # NUR-SOP-11, HR/P/03
CODE_B = re.compile(rf"\b({_TOK})[-/_.]([A-Z]{{2,6}})[-/_.](\d{{1,4}}[A-Z]?)\b")        # SOP/NUR/012

# words in a title (or a file / folder name) that say what a document is; earliest wins
TITLE_WORDS: list[tuple[str, str]] = [
    (r"standard operating procedures?|\bsops?\b|work instructions?|\bprocedures?\b|\bprotocols?\b|\bguidelines?\b", "SOP"),
    (r"\bpolic(?:y|ies)\b", "Policy"),
    (r"\bforms?\b|\bformats?\b|\bchecklists?\b|\bproformas?\b|\btemplates?\b|\brequisitions?\b|\bconsent\b", "Form"),
    (r"\bregisters?\b|\blog ?books?\b|\blog ?sheets?\b|\btrackers?\b|\brecord books?\b|\binventory\b", "Register"),
    (r"\bjob descriptions?\b|\bjds?\b|\brole descriptions?\b", "Job description"),
    (r"\bcertificates?\b|\blicen[cs]es?\b|\bnoc\b|no objection|\bauthori[sz]ations?\b|consent to operate|\bpermits?\b", "Licence"),
    (r"\bminutes\b|\bmom\b|minutes of (?:the )?meeting", "Minutes"),
    (r"\bagreements?\b|\bcontracts?\b|\bamc\b|\bcmc\b|\bmou\b|memorandum of understanding|\bwork orders?\b", "Contract"),
    (r"training (?:records?|attendance|calendar|register)|attendance sheets?", "Training record"),
    (r"\bmanuals?\b|\bhandbooks?\b", "Manual"),
    (r"\bplans?\b|\bprogramme\b|\bprogram\b", "Plan"),
    (r"\breports?\b|\banalysis\b|\baudit findings\b", "Report"),
]

# code prefix → department, as hospitals commonly abbreviate them (learned rules come first)
PREFIX_DEPARTMENT = {
    "NUR": "Nursing", "NS": "Nursing", "NSG": "Nursing", "HR": "Human Resources", "HRD": "Human Resources",
    "BME": "Biomedical Engineering", "BIO": "Biomedical Engineering", "BMED": "Biomedical Engineering",
    "LAB": "Laboratory", "PATH": "Laboratory", "PHA": "Pharmacy", "PHAR": "Pharmacy", "PHR": "Pharmacy", "RX": "Pharmacy",
    "RAD": "Radiology", "ANS": "Anaesthesiology", "ANE": "Anaesthesiology", "ANA": "Anaesthesiology",
    "OT": "Operation Theatre", "MICU": "MICU", "SICU": "SICU", "ER": "Emergency Department", "ED": "Emergency Department",
    "EMD": "Emergency Department", "MRD": "Medical Records", "IT": "Information Technology", "FIN": "Finance & Accounts",
    "ACC": "Finance & Accounts", "ADM": "Administration", "ADMIN": "Administration", "HK": "Housekeeping",
    "HSK": "Housekeeping", "FMS": "Maintenance", "MNT": "Maintenance", "ENG": "Maintenance", "FAC": "Facilities",
    "DIET": "Dietetics & Clinical Nutrition", "FNB": "Food & Beverages", "CSSD": "CSSD", "BB": "Blood Bank",
    "QA": "Quality", "QM": "Quality", "QMS": "Quality", "QLT": "Quality", "QI": "Quality", "IC": "Infection Control",
    "IPC": "Infection Control", "ICN": "Infection Control", "SEC": "Security", "TRN": "Transport", "PHY": "Physiotherapy",
    "CARD": "Cardiology", "NEU": "Neurology", "ORTHO": "Orthopaedics", "PED": "Pediatrics", "PAED": "Pediatrics",
    "DIAL": "Dialysis", "ENDO": "Endoscopy", "FO": "Front Office & Registration", "BIL": "Billing",
    "STR": "General Stores", "PUR": "General Stores", "LDY": "Laundry", "MED": "Medical", "GEN": "Hospital-wide",
}
DEPT_ALIASES = {
    "hr": "human resources", "human resource": "human resources", "personnel": "human resources",
    "bme": "biomedical engineering", "biomedical": "biomedical engineering", "nursing services": "nursing",
    "lab": "laboratory", "pathology": "laboratory", "operation theatres": "operation theatre", "ot": "operation theatre",
    "emergency": "emergency department", "casualty": "emergency department", "er": "emergency department",
    "mrd": "medical records", "it": "information technology", "finance": "finance and accounts",
    "accounts": "finance and accounts", "stores": "general stores", "purchase": "general stores",
    "hospital wide": "hospital-wide", "all departments": "hospital-wide", "organisation wide": "hospital-wide",
    "quality assurance": "quality", "quality and patient safety": "quality", "infection prevention and control": "infection control",
}
_DEPT_STOP = {"department", "dept", "services", "service", "unit", "division", "section", "the", "of", "wing"}

PEOPLE_LABELS = r"document owner|process owner|policy owner|owner|custodian|prepared by|drafted by|author|reviewed by|checked by|approved by|authori[sz]ed by|issued by|responsible person|head of department|hod"
_LABEL_LINE = re.compile(rf"^\s*({PEOPLE_LABELS})\s*[:\-–]\s*(.+?)\s*$", re.I)
_DEPT_LINE = re.compile(r"^\s*(department|dept\.?|department\s*/\s*unit|unit|section|function|applicable to|area)\s*[:\-–]\s*(.+?)\s*$", re.I)
_TITLE_LINE = re.compile(r"^\s*(?:document title|policy title|sop title|title|subject|name of (?:the )?(?:policy|sop|document|form))\s*[:\-–]\s*(.+?)\s*$", re.I)
_VERSION = re.compile(r"\b(?:version|ver\.?|rev(?:ision)?|issue)\s*(?:no\.?|number)?\s*[:\-–|]?\s*(\d+(?:\.\d+)?)\b", re.I)
_DATE_LABELS = {
    "effective": r"effective (?:date|from)|date of (?:issue|implementation)|issue date|implementation date|w\.e\.f",
    "review": r"(?:next )?review date|date of (?:next )?review|review due|valid (?:till|until|upto)|expiry date|valid up ?to",
}
_ROLE_WORDS = re.compile(r"\b(manager|head|superintendent|director|officer|nurse|in-?charge|coordinator|hod|ceo|cmo|coo|md|consultant|administrator|executive|supervisor|committee|engineer|pharmacist|technician|sister|matron|chairman|chairperson|physician|surgeon|anaesthetist|anaesthesiologist|team)\b", re.I)
_TITLES = re.compile(r"^(dr|mr|mrs|ms|miss|madam|prof|smt|sri|shri|capt|col)(?:\.\s*|\s+)", re.I)


# ------------------------------------------------------------------ tables
SCHEMA = """
CREATE TABLE IF NOT EXISTS intake_batches (
  id TEXT PRIMARY KEY, integration_id TEXT, root TEXT, label TEXT, status TEXT, stage TEXT, message TEXT,
  files_total INTEGER DEFAULT 0, files_done INTEGER DEFAULT 0, items INTEGER DEFAULT 0,
  saved INTEGER DEFAULT 0, review INTEGER DEFAULT 0, on_record INTEGER DEFAULT 0,
  created_by TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT, options TEXT
);
CREATE TABLE IF NOT EXISTS intake_items (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, file TEXT, file_hash TEXT, part INTEGER, parts INTEGER,
  doc_type TEXT, type_confidence INTEGER, type_evidence TEXT, type_method TEXT,
  code TEXT, code_written TEXT, title TEXT, version TEXT, effective_date TEXT, review_date TEXT,
  department TEXT, department_node_id TEXT, department_status TEXT, department_evidence TEXT,
  owner_text TEXT, owner_id TEXT, approver_text TEXT, approver_id TEXT, people TEXT, refs TEXT,
  excerpt TEXT, text TEXT, chars INTEGER, ocr INTEGER DEFAULT 0,
  status TEXT, reasons TEXT, saved_how TEXT, entity_id TEXT, existing_entity_id TEXT, duplicate_of TEXT,
  decided_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_intake_items_batch ON intake_items(batch_id);
ALTER TABLE intake_items ADD COLUMN IF NOT EXISTS bytes INTEGER;
CREATE TABLE IF NOT EXISTS intake_rules (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  created_by TEXT, created_at TEXT, uses INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_rules_key ON intake_rules(kind, key);
"""
_READY = False


def init(con=None):
    global _READY
    con = con or connect()
    if not _READY:
        con.executescript(SCHEMA)
        con.commit()
        _READY = True
    return con


# ------------------------------------------------------------------ reading
@dataclass
class Block:
    kind: str          # 'h' heading · 'p' paragraph · 't' table row
    text: str
    level: int = 0     # heading level (1 = top)
    cells: list[str] = field(default_factory=list)


@dataclass
class Read:
    blocks: list[Block]
    header: str = ""   # page header / first-page text that often holds code, title, department
    ocr: bool = False
    note: str = ""


qn_sect = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}sectPr"
_KEEP_CAPS = {"AERB", "NABH", "NABL", "MVPI", "HIV", "CSSD", "OPD", "IPD", "ICU", "NICU", "MICU", "SICU", "RCA", "IEC",
              "UHID", "ISBAR", "SBAR", "PPE", "BMW", "SOP", "AMC", "CMC", "HTA", "FSN", "QA", "QC", "MR", "OT", "ER", "IT", "HR", "ECG"}
_SMALL = {"and", "of", "the", "for", "to", "in", "on", "by", "at", "or", "an", "a", "with", "per"}


def _title_case(t: str) -> str:
    """'HTA, TECHNICAL SPECIFICATION & BID EVALUATION' → 'HTA, Technical Specification & Bid Evaluation'."""
    if not t.isupper():
        return t
    out = []
    for i, w in enumerate(t.split()):
        core = re.sub(r"[^A-Za-z]", "", w)
        if core in _KEEP_CAPS:
            out.append(w)
        elif i and core.lower() in _SMALL:
            out.append(w.lower())
        else:
            out.append(w[:1] + w[1:].lower())
    return " ".join(out)


def _section_headers(d) -> list[list[str]]:
    """Each section's page-header lines. A forms pack puts every form's number and title there."""
    out = []
    for s in d.sections:
        lines: list[str] = []
        try:
            for p in s.header.paragraphs:
                lines += [x.strip() for x in p.text.splitlines() if x.strip()]
            for tb in s.header.tables:
                for row in tb.rows:
                    seen = set()
                    for c in row.cells:
                        if id(c._tc) in seen:
                            continue
                        seen.add(id(c._tc))
                        lines += [x.strip() for x in c.text.splitlines() if x.strip()]
        except Exception:                                           # noqa: BLE001
            pass
        out.append(lines)
    return out


def _header_blocks(lines: list[str]) -> list[Block]:
    """A section header that carries a document code → a heading that starts that document, plus its fields."""
    lines = [x.strip() for ln in lines for x in ln.split("|") if x.strip()]
    text = "\n".join(lines)
    codes = find_codes(text)
    if not codes:
        return []
    names = [x for x in lines if ":" not in x and not x.startswith("[") and not find_codes(x) and len(x) > 6]
    title = max([x for x in names if x.isupper()] or names or [""], key=len)
    return [Block("h", f"{codes[0][1]} {_title_case(title)}".strip(), 1)] + \
           [Block("p", x) for x in lines if ":" in x]


def _docx(data: bytes) -> Read:
    import docx                                                     # python-docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    d = docx.Document(io.BytesIO(data))
    blocks: list[Block] = []
    heads = _section_headers(d)
    sec, shown, last = 0, -1, None
    for child in d.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if sec != shown and sec < len(heads):                       # the first content of a new section
            shown = sec
            if heads[sec] and heads[sec] != last:
                blocks += _header_blocks(heads[sec])
                last = heads[sec]
        if tag == "p" and child.find(".//" + qn_sect) is not None:
            sec += 1                                                # this paragraph closes its section
        if tag == "p":
            p = Paragraph(child, d)
            t = (p.text or "").strip()
            if not t:
                continue
            style = (p.style.name if p.style is not None else "") or ""
            m = re.match(r"heading\s*(\d)", style, re.I)
            if m or style.lower() == "title":
                blocks.append(Block("h", t, int(m.group(1)) if m else 1))
            else:
                blocks.append(Block("p", t))
        elif tag == "tbl":
            for row in Table(child, d).rows:
                cells, seen = [], set()
                for c in row.cells:                                 # merged cells repeat; keep each once
                    ct = (c.text or "").strip()
                    if id(c._tc) in seen:
                        continue
                    seen.add(id(c._tc))
                    cells.append(ct)
                if any(cells):
                    blocks.append(Block("t", " | ".join(x for x in cells if x), cells=cells))
    header = []
    try:
        for s in d.sections[:1]:
            for p in s.header.paragraphs:
                if p.text.strip():
                    header.append(p.text.strip())
            for tb in s.header.tables:
                for row in tb.rows:
                    header.append(" | ".join(c.text.strip() for c in row.cells if c.text.strip()))
    except Exception:                                               # noqa: BLE001
        pass
    return Read(blocks, "\n".join(header))


def _lines_to_blocks(text: str) -> list[Block]:
    out = []
    for line in text.splitlines():
        t = re.sub(r"\s{3,}", "  ", line).strip()
        if t:
            out.append(Block("p", t))
    return out


def _ocr_images(paths: list[Path]) -> str:
    texts = []
    for p in paths:
        try:
            r = subprocess.run(["tesseract", str(p), "-", "--psm", "3"], capture_output=True, text=True, timeout=120)
            texts.append(r.stdout)
        except Exception:                                           # noqa: BLE001
            continue
    return "\n".join(texts)


def _pdf(data: bytes) -> Read:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.pdf"
        src.write_bytes(data)
        text = ""
        try:
            r = subprocess.run(["pdftotext", "-layout", str(src), "-"], capture_output=True, text=True, timeout=120)
            text = r.stdout
        except Exception:                                           # noqa: BLE001
            pass
        pages = max(1, text.count("\f") + 1)
        if len(re.sub(r"\s", "", text)) / pages >= 80:
            return Read(_lines_to_blocks(text[:MAX_TEXT]))
        # a scan: render the pages and read them with OCR
        try:
            subprocess.run(["pdftoppm", "-r", "200", "-png", "-l", str(OCR_MAX_PAGES), str(src), str(Path(tmp) / "pg")],
                           capture_output=True, timeout=600)
        except Exception:                                           # noqa: BLE001
            return Read([], note="the PDF could not be rendered for OCR")
        imgs = sorted(Path(tmp).glob("pg*.png"))
        ocr = _ocr_images(imgs)
        note = "" if ocr.strip() else "a scanned PDF with no readable text"
        if len(imgs) >= OCR_MAX_PAGES:
            note = f"OCR read the first {OCR_MAX_PAGES} pages only"
        return Read(_lines_to_blocks(ocr[:MAX_TEXT]), ocr=True, note=note)


def _image(data: bytes, ext: str) -> Read:
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / f"img{ext}"
        p.write_bytes(data)
        t = _ocr_images([p])
    return Read(_lines_to_blocks(t[:MAX_TEXT]), ocr=True, note="" if t.strip() else "an image with no readable text")


def _xlsx(data: bytes) -> Read:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    blocks: list[Block] = []
    for ws in wb.worksheets[:12]:
        blocks.append(Block("h", f"Sheet: {ws.title}", 2))
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= 60:
                break
            cells = ["" if v is None else str(v).strip() for v in row]
            if any(cells):
                blocks.append(Block("t", " | ".join(c for c in cells if c), cells=cells))
    return Read(blocks)


def read_bytes(data: bytes, name: str) -> Read:
    ext = Path(name).suffix.lower()
    try:
        if ext == ".docx":
            return _docx(data)
        if ext == ".pdf":
            return _pdf(data)
        if ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff"):
            return _image(data, ext)
        if ext in (".xlsx", ".xlsm"):
            return _xlsx(data)
        if ext in (".txt", ".md"):
            return Read(_lines_to_blocks(data.decode("utf-8", errors="replace")[:MAX_TEXT]))
    except Exception as ex:                                         # noqa: BLE001 — one bad file is not a failed upload
        return Read([], note=f"could not be read ({type(ex).__name__})")
    return Read([], note=f"{ext or 'this'} files cannot be opened on this server; sorted by its name only")


# ------------------------------------------------------------------ codes
def find_codes(text: str) -> list[tuple[str, str, str, str]]:
    """Every document code in the text: (canonical, as written, dept prefix, type token), in order."""
    out, seen = [], set()
    for m in sorted(list(CODE_A.finditer(text)) + list(CODE_B.finditer(text)), key=lambda m: m.start()):
        if m.re is CODE_A:
            dept, tok, num = m.group(1), m.group(2), m.group(3)
        else:
            tok, dept, num = m.group(1), m.group(2), m.group(3)
        if dept in TYPE_TOKENS or dept in ("NABH", "JCI", "ISO", "NABL", "WHO", "IEC", "AERB", "BIS"):
            continue
        canon = f"{dept}-{TOKEN_CANON.get(tok, tok)}-{num.zfill(2) if num.isdigit() else num}"
        if canon not in seen:
            seen.add(canon)
            out.append((canon, m.group(0), dept, tok))
    return out


def _slug(s: str, n: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n] or "doc"


# ------------------------------------------------------------------ splitting
@dataclass
class Part:
    head: str
    blocks: list[Block]
    code: tuple | None = None


def _is_header(b: Block) -> tuple | None:
    """A line that starts a document inside a file: '3.1 NUR-POL-01 – Title', 'NUR-F-12', 'SOP/HR/004 Title'."""
    if b.kind == "t" or len(b.text) > 140:
        return None
    t = re.sub(r"^\s*(?:\d+(?:\.\d+)*\.?|[A-Z]\.|[ivx]+\.)\s+", "", b.text)
    codes = find_codes(t[:40])
    if not codes:
        return None
    canon, written, *_ = codes[0]
    if not t.upper().startswith(written.upper()[:3]):
        return None
    return codes[0]


def split(r: Read) -> list[Part]:
    heads = [(i, c) for i, b in enumerate(r.blocks) if (c := _is_header(b))]
    if len(heads) < 2:
        return [Part("", r.blocks, None)]
    parts: list[Part] = []
    for n, (i, c) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(r.blocks)
        body = r.blocks[i:end]
        parts.append(Part(r.blocks[i].text, body, c))
    # table-of-contents entries are headers with almost nothing under them: keep the fullest copy of each code
    best: dict[str, Part] = {}
    for p in parts:
        size = sum(len(b.text) for b in p.blocks[1:])
        if size < 25 and len(p.blocks) <= 2:
            continue
        k = p.code[0]
        if k not in best or size > sum(len(b.text) for b in best[k].blocks[1:]):
            best[k] = p
    kept = [p for p in parts if p.code and best.get(p.code[0]) is p]
    if len(kept) < 2:
        return [Part("", r.blocks, None)]
    first = heads[0][0]
    intro = r.blocks[:first]
    if sum(len(b.text) for b in intro) > 600:                       # the manual's own front matter
        kept.insert(0, Part("", intro, None))
    return kept


# ------------------------------------------------------------------ the knowledge each run starts from
class Knowledge:
    """Departments, employees, learned rules and the codes already on record — loaded once per run."""

    def __init__(self, con):
        self.con = con
        nodes = [dict(r) for r in con.execute("SELECT id, name, parent_id FROM org_nodes WHERE kind='Department'")]
        used = {r[0]: r[1] for r in con.execute(
            "SELECT org_node_id, count(*) FROM company_entities WHERE org_node_id IS NOT NULL GROUP BY 1")}
        self.depts: dict[str, dict] = {}                            # normalised name → the busiest node of that name
        for n in nodes:
            k = norm_dept(n["name"])
            if k not in self.depts or used.get(n["id"], 0) > used.get(self.depts[k]["id"], 0):
                self.depts[k] = n
        parents = [n["parent_id"] for n in nodes if n["parent_id"]]
        self.dept_parent = max(set(parents), key=parents.count) if parents else None
        self.people = []
        for r in con.execute("SELECT id, name, attrs FROM company_entities WHERE type IN ('Employee','Person')"):
            try:
                a = json.loads(r["attrs"] or "{}")
            except ValueError:
                a = {}
            self.people.append({"id": r["id"], "name": a.get("displayName") or r["name"], "alt": r["name"],
                                "job": a.get("jobTitle") or a.get("designation") or "", "dept": a.get("department") or ""})
        self.rules: dict[tuple[str, str], str] = {(r["kind"], r["key"]): r["value"] for r in con.execute(
            "SELECT kind, key, value FROM intake_rules")}
        self.on_record: dict[str, str] = {}
        for r in con.execute("""SELECT id, source_reference, attrs FROM company_entities
                                 WHERE domain IN ('policies','processes','evidence','people','overview','systems','controls')"""):
            ref = (r["source_reference"] or "").strip().upper()
            for c in find_codes(ref):
                self.on_record.setdefault(c[0], r["id"])
        # files collected before intake existed: the same name and size is the same file
        # (older rows carry no size: it is read from the file where the folder still has it)
        self.files: dict[tuple[str, int], str] = {}
        bases = []
        for r in con.execute("SELECT config FROM integrations WHERE connector='folder'"):
            try:
                p = json.loads(r["config"] or "{}").get("path")
                if p:
                    bases.append(Path(p))
            except (TypeError, ValueError):
                pass
        for r in con.execute("""SELECT source_reference, storage_path, size, linked_entity_id FROM company_documents
                                 WHERE linked_entity_id IS NOT NULL"""):
            base = PurePosixPath((r["source_reference"] or "").replace("\\", "/")).name.lower()
            size = r["size"]
            if size is None and r["storage_path"]:
                for b in bases:
                    f = b / r["storage_path"]
                    if f.is_file():
                        size = f.stat().st_size
                        break
            if base and size is not None:
                self.files.setdefault((base, int(size)), r["linked_entity_id"])

    def department(self, name: str) -> dict | None:
        k = norm_dept(name)
        if not k:
            return None
        k = DEPT_ALIASES.get(k, k)
        if k in self.depts:
            return self.depts[k]
        for dk, node in self.depts.items():                          # "Nursing Services Dept" ⊇ "Nursing"
            a, b = set(k.split()), set(dk.split())
            if a and b and (a <= b or b <= a) and min(len(a), len(b)) >= 1 and len(" ".join(a & b)) >= 4:
                return node
        close = difflib.get_close_matches(k, list(self.depts), n=1, cutoff=0.86)
        return self.depts[close[0]] if close else None


def norm_dept(s: str) -> str:
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9\- ]+", " ", s)
    words = [w for w in s.split() if w not in _DEPT_STOP]
    return " ".join(words).strip()


# ------------------------------------------------------------------ sorting one document
@dataclass
class Sorted:
    doc_type: str = "Other"
    confidence: int = 30
    evidence: str = ""
    method: str = "rules"
    code: str = ""
    code_written: str = ""
    title: str = ""
    version: str = ""
    effective: str = ""
    review: str = ""
    department: str = ""
    dept_node: str | None = None
    dept_status: str = "unknown"
    dept_evidence: str = ""
    owner_text: str = ""
    owner_id: str | None = None
    approver_text: str = ""
    approver_id: str | None = None
    people: list = field(default_factory=list)
    refs: list = field(default_factory=list)
    text: str = ""


def _type_from_words(s: str, weight: int, where: str) -> tuple[str, int, str] | None:
    low = (s or "").lower()
    best = None
    for pat, typ in TITLE_WORDS:
        m = re.search(pat, low)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), typ, m.group(0))
    if best:
        return best[1], weight, f'{where} says "{best[2]}"'
    return None


def _structure_type(blocks: list[Block], text: str) -> tuple[str, int, str] | None:
    heads = " ".join(b.text.lower() for b in blocks if b.kind == "h" or (b.kind == "p" and len(b.text) < 60))
    rows = [b for b in blocks if b.kind == "t"]
    blanks = len(re.findall(r"_{4,}|\.{6,}|:\s*$", text, re.M)) + len(re.findall(r"\b(signature|sign|date|name)\s*[:\-]", text, re.I))
    prose = sum(len(b.text) for b in blocks if b.kind == "p" and len(b.text) > 80)
    if re.search(r"policy statement|policy provisions", heads):
        return "Policy", 70, "has a policy statement section"
    if re.search(r"\bprocedure\b|\bsteps?\b|step\s*\|\s*activity", heads) or any(
            re.match(r"step\b", (b.cells[0] if b.cells else "").lower()) for b in rows[:3]):
        return "SOP", 68, "has numbered procedure steps"
    if blanks >= 6 and prose < 600:
        return "Form", 66, f"{blanks} fields to fill in, little prose"
    dated = sum(1 for b in rows if re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", b.text))
    if len(rows) >= 8 and dated >= 5:
        return "Register", 66, f"a table of {len(rows)} dated rows"
    return None


def _dates(text: str, out: Sorted) -> None:
    for key, pat in _DATE_LABELS.items():
        m = re.search(rf"(?:{pat})\s*[:\-–|]?\s*([0-9]{{1,2}}[/.\-][0-9]{{1,2}}[/.\-][0-9]{{2,4}}|[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}|[0-9]{{1,2}}\s+[A-Za-z]{{3,9}},?\s+[0-9]{{4}}|[A-Za-z]{{3,9}}\s+[0-9]{{4}})", text, re.I)
        if m:
            setattr(out, "effective" if key == "effective" else "review", m.group(1).strip())


def _labelled(blocks: list[Block], header: str) -> list[tuple[str, str]]:
    """(label, value) pairs from 'Label: value' lines and two-column label|value table rows."""
    pairs = []
    for line in header.splitlines():
        for part in line.split("|"):
            if ":" in part:
                k, v = part.split(":", 1)
                pairs.append((k.strip(), v.strip()))
    for b in blocks[:80]:
        if b.kind == "t" and len(b.cells) >= 2:
            cells = [c for c in b.cells if c]
            for k, v in zip(cells[0::2], cells[1::2]):
                pairs.append((k.strip().rstrip(":"), v.strip()))
        elif ":" in b.text and len(b.text) < 200:
            k, v = b.text.split(":", 1)
            pairs.append((k.strip(), v.strip()))
    return [(k, v) for k, v in pairs if k and v and len(k) < 40]


def _match_person(k: Knowledge, value: str) -> tuple[str | None, str]:
    """A name (with or without a designation) → an employee, when exactly one fits."""
    v = re.split(r"[,(/]| - | – ", value)[0].strip()
    name = _TITLES.sub("", v).strip()
    if not name or _ROLE_WORDS.search(name) and len(name.split()) <= 4 and not re.search(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+\b", v):
        # a role ("Nursing Superintendent"): one employee with that job title, or none
        hits = [p for p in k.people if p["job"] and p["job"].lower() == v.lower()]
        return (hits[0]["id"], f'the only employee titled "{v}"') if len(hits) == 1 else (None, "role")
    toks = [t for t in re.split(r"[\s.]+", name.lower()) if t]
    if not toks:
        return None, ""
    cands = []
    for p in k.people:
        pt = [t for t in re.split(r"[\s.]+", _TITLES.sub("", p["name"] or "").lower()) if t]
        if not pt:
            continue
        full = [t for t in toks if len(t) > 1]
        initials = [t for t in toks if len(t) == 1]
        if all(t in pt for t in full) and all(any(x.startswith(i) for x in pt) for i in initials) and full:
            cands.append(p)
    if len(cands) == 1:
        return cands[0]["id"], f'matched "{v}" to {cands[0]["name"]}'
    return None, (f"{len(cands)} employees match \"{v}\"" if cands else f'no employee named "{v}"')


_CODE_LABEL = re.compile(r"^\s*(?:document|doc|sop|policy|form|format|procedure|plan|manual|register|ref(?:erence)?)?\s*"
                         r"(?:no\.?|number|code|id|ref\.?)\s*[:\-–|]", re.I)
_GENERIC_NAME = re.compile(r"^(?:scan|scanned|img|image|dsc|pxl|photo|cam|doc|document|untitled|file|page|new"
                           r"(?: microsoft)?(?: word)?(?: document)?|copy(?: of)?|final|draft)?[\s_\-()]*\d*[\s_\-()]*$", re.I)
_GENERIC_LINE = re.compile(r"^(?:standard operating procedures?|policy|procedure|sop|form|format|register|"
                           r"\[?hospital name\]?|contents|table of contents|confidential|controlled copy)$", re.I)


def own_code(blocks: list[Block], header: str, file: str) -> tuple | None:
    """
    The document's OWN code — from a label ("SOP No: HK/SOP/04"), the page header,
    its first lines, or its file name. A code met mid-sentence ("assessed under
    NUR-SOP-41") is a reference to another document, not this one's number.
    """
    for b in blocks[:40]:
        line = b.text if b.kind != "t" else " : ".join(c for c in b.cells if c)
        if _CODE_LABEL.match(line):
            c = find_codes(line)
            if c:
                return c[0]
    c = find_codes(header)
    if c:
        return c[0]
    for b in blocks[:3]:
        if len(b.text) <= 120:
            c = find_codes(b.text[:40])
            if c:
                return c[0]
    c = find_codes(PurePosixPath(file).stem.upper())
    return c[0] if c else None


def _title_like(t: str) -> bool:
    t = t.strip()
    return (4 <= len(t) <= 110 and ":" not in t and len(t.split()) >= 2 and not _GENERIC_LINE.match(t)
            and not _LABEL_LINE.match(t) and not re.fullmatch(r"[\d\s./\-|]+", t))


def sort_part(k: Knowledge, part: Part, *, file: str, header: str, whole_title: str,
              compound: bool = False, ocr: bool = False) -> Sorted:
    blocks = part.blocks
    text = "\n".join(b.text for b in blocks)[:MAX_TEXT]
    s = Sorted(text=text)
    pairs = _labelled(blocks, header if not part.code else "")

    # --- code and title
    code = part.code or own_code(blocks, header if not compound else "", file if not compound else "")
    if code:
        s.code, s.code_written = code[0], code[1]

    def after_code(t: str) -> str:
        if code and code[1].upper() in t.upper():
            t = t[t.upper().find(code[1].upper()) + len(code[1]):]
        return re.sub(r"^\s*[–\-:|.]+\s*", "", t).strip()

    if part.head:
        t = after_code(part.head)
        if not t and len(blocks) > 1:
            t = blocks[1].text
        s.title = t[:200]
    elif compound:                                                  # a manual's own front matter: the manual itself
        s.title = whole_title
    if not s.title:
        stem_ok = not _GENERIC_NAME.match(whole_title)
        candidates = [
            next((m.group(1) for b in blocks[:25] if (m := _TITLE_LINE.match(b.text))), ""),
            next((v for kk, v in pairs if re.fullmatch(r"(document |policy |sop |form )?(title|name)|subject", kk.lower())), ""),
            next((b.text for b in blocks[:15] if b.kind == "h" and 4 <= len(b.text) <= 150 and not _GENERIC_LINE.match(b.text)), ""),
            next((after_code(b.text) for b in blocks[:3] if code and code[1].upper() in b.text.upper()
                  and _title_like(after_code(b.text))), ""),
            "" if ocr else next((b.text for b in blocks[:6] if b.kind == "p" and _title_like(b.text)), ""),
            whole_title if stem_ok else "",
            next((b.text for b in blocks[:8] if _title_like(b.text)), ""),
            whole_title,
        ]
        s.title = next(c for c in candidates if c)[:200]
    s.title = re.sub(r"\s+", " ", s.title).strip(" -–:|")
    m = _VERSION.search(header + "\n" + text[:3000])
    s.version = m.group(1) if m else ""
    _dates(header + "\n" + text[:4000], s)

    # --- type: votes from the code, the title, the layout, the file and folder names
    votes: list[tuple[str, int, str]] = []
    if code:
        tok = code[3]
        learned = k.rules.get(("type_token", tok))
        if learned:
            votes.append((learned, 92, f'remembered: code type "{tok}" means {learned}'))
        elif tok in TYPE_TOKENS:
            votes.append((TYPE_TOKENS[tok], 60 if tok in ("R", "P", "PR") else 93, f'code {code[1]} carries "{tok}"'))
    if s.title:
        v = _type_from_words(s.title, 84, "the title")
        if v:
            votes.append(v)
    st = _structure_type(blocks, text)
    if st:
        votes.append(st)
    fp = PurePosixPath(file)
    v = _type_from_words(fp.stem.replace("_", " ").replace("-", " "), 62, "the file name")
    if v:
        votes.append(v)
    for folder in fp.parent.parts[::-1]:
        learned = k.rules.get(("folder_type", folder.lower()))
        if learned:
            votes.append((learned, 88, f'remembered: folder "{folder}" holds {learned}'))
            break
        v = _type_from_words(folder.replace("_", " ").replace("-", " "), 58, f'the folder "{folder}"')
        if v:
            votes.append(v)
            break
    if votes:
        by: dict[str, list] = {}
        for typ, sc, ev in votes:
            by.setdefault(typ, []).append((sc, ev))
        ranked = sorted(((max(x[0] for x in v) + 6 * (len(v) - 1), typ, v) for typ, v in by.items()), reverse=True)
        top, typ, ev = ranked[0]
        if len(ranked) > 1 and ranked[1][0] >= top - 8:
            top -= 15                                              # two types nearly tied: not sure
        s.doc_type, s.confidence = typ, min(top, 99)
        s.evidence = "; ".join(e for _, e in sorted(ev, reverse=True))
    else:
        s.evidence = "nothing in the document says what it is"

    # --- department
    dept_votes: list[tuple[str, int, str]] = []
    for kk, v in pairs:
        if _DEPT_LINE.match(f"{kk}: {v}"):
            dept_votes.append((v, 90, f'the document says "{kk}: {v}"'))
            break
    if code:
        pre = code[2]
        learned = k.rules.get(("prefix_department", pre))
        if learned:
            dept_votes.append((learned, 92, f'remembered: code prefix "{pre}" is {learned}'))
        elif pre in PREFIX_DEPARTMENT:
            dept_votes.append((PREFIX_DEPARTMENT[pre], 82, f'code prefix "{pre}"'))
    for folder in fp.parent.parts[::-1]:
        learned = k.rules.get(("folder_department", folder.lower()))
        if learned:
            dept_votes.append((learned, 90, f'remembered: folder "{folder}" is {learned}'))
            break
        if k.department(folder):
            dept_votes.append((folder, 74, f'the folder "{folder}"'))
            break
    if re.search(r"hospital[- ]wide|all departments|entire hospital|organi[sz]ation[- ]wide|all (?:staff|employees)",
                 text[:2500], re.I):
        dept_votes.append(("Hospital-wide", 64, "it applies to the whole hospital"))
    for name, sc, ev in sorted(dept_votes, key=lambda x: -x[1]):
        node = k.department(name)
        if node:
            s.department, s.dept_node, s.dept_status, s.dept_evidence = node["name"], node["id"], "matched", ev
            break
    else:
        if dept_votes:
            name, sc, ev = max(dept_votes, key=lambda x: x[1])
            if sc >= 80:
                s.department, s.dept_status = name.strip()[:80], "proposed"
                s.dept_evidence = f"{ev}; no such department yet"

    # --- people
    people = []
    for kk, v in pairs:
        m = _LABEL_LINE.match(f"{kk}: {v}")
        if not m:
            continue
        role_label = m.group(1).lower()
        pid, note = _match_person(k, v)
        people.append({"label": m.group(1), "value": v[:120], "entity_id": pid, "note": note})
        if any(w in role_label for w in ("owner", "custodian", "head", "hod", "responsible")) and not s.owner_text:
            s.owner_text, s.owner_id = v[:120], pid
        if "approved" in role_label or "authori" in role_label:
            s.approver_text, s.approver_id = v[:120], pid
    if not s.owner_text:
        prep = next((p for p in people if "prepared" in p["label"].lower() or "author" in p["label"].lower()), None)
        if prep:
            s.owner_text, s.owner_id = prep["value"], prep["entity_id"]
    s.people = people

    # --- other documents it names
    s.refs = [c[0] for c in find_codes(text) if c[0] != s.code][:40]
    return s


# ------------------------------------------------------------------ the local AI, only when the rules are unsure
_LLM_LOCK = threading.Lock()


def llm_up() -> bool:
    try:
        httpx.get(f"{LLM_BASE}/models", timeout=4).raise_for_status()
        return True
    except Exception:                                               # noqa: BLE001
        return False


def ask_llm(k: Knowledge, s: Sorted, file: str) -> dict | None:
    depts = ", ".join(sorted({n["name"] for n in k.depts.values()}))
    prompt = "\n".join([
        "You sort a hospital's documents. Read the start of this document and say what it is.",
        f"Types (pick one): {', '.join(TYPES)}.",
        f"Departments that exist: {depts}. Use one of these, or a short new name if none fits, or \"\" if unclear.",
        'Reply with JSON only: {"type": "...", "department": "...", "title": "...", "confidence": 0-100, '
        '"evidence": "the words in the document that decided it"}',
        f"File: {file}",
        "Document start:",
        s.text[:2200],
    ])
    body = {"model": LLM_MODEL, "temperature": 0, "max_tokens": 500, "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"reasoning_effort": "low"}, "messages": [{"role": "user", "content": prompt}]}
    try:
        with _LLM_LOCK:
            r = httpx.post(f"{LLM_BASE}/chat/completions", json=body, timeout=httpx.Timeout(180, connect=5))
        r.raise_for_status()
        t = r.json()["choices"][0]["message"].get("content") or ""
        d = json.loads(t[t.find("{"): t.rfind("}") + 1])
        return d if isinstance(d, dict) else None
    except Exception:                                               # noqa: BLE001
        return None


# ------------------------------------------------------------------ a batch
def start(*, root: str, label: str, actor: str, integration_id: str | None = None,
          include: list[str] | None = None, use_llm: bool = True) -> str:
    """
    Create a batch and sort it in the background. Returns the batch id.

    Its own connection: a folder sync calls this from inside its write
    transaction, and committing on that connection would commit half a sync.
    """
    con = init(connect())
    bid = f"ib-{secrets.token_hex(5)}"
    try:
        con.execute("""INSERT INTO intake_batches (id, integration_id, root, label, status, stage, message, created_by,
                       created_at, updated_at, options) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (bid, integration_id, root, label, "RUNNING", "reading", "Starting…", actor, _now(), _now(),
                     json.dumps({"include": include, "use_llm": use_llm})))
        con.commit()
    finally:
        con.close()
    threading.Thread(target=_run_safe, args=(bid,), daemon=True).start()
    return bid


def _set(con, bid: str, **cols):
    cols["updated_at"] = _now()
    con.execute(f"UPDATE intake_batches SET {', '.join(f'{k}=?' for k in cols)} WHERE id=?", (*cols.values(), bid))
    con.commit()


def _run_safe(bid: str) -> None:
    con = connect()
    try:
        _run(con, bid)
    except Exception as ex:                                         # noqa: BLE001
        _set(con, bid, status="FAILED", stage="failed", message=f"{type(ex).__name__}: {ex}", finished_at=_now())


def _files(root: Path, include: list[str] | None) -> list[tuple[str, bytes]]:
    """(relative name, bytes) for every file to sort, the members of a .zip included."""
    out = []
    paths = [root / p for p in include] if include else sorted(root.rglob("*"))
    for f in paths:
        if not f.is_file() or f.name.startswith((".", "~$")) or any(p.startswith(".") for p in f.relative_to(root).parts):
            continue
        rel = str(PurePosixPath(*f.relative_to(root).parts))
        ext = f.suffix.lower()
        if ext == ".zip":
            try:
                with zipfile.ZipFile(f) as z:
                    for info in z.infolist()[:2000]:
                        n = PurePosixPath(info.filename)
                        if info.is_dir() or n.name.startswith((".", "~$")) or n.suffix.lower() not in INTAKE_EXT - {".zip"}:
                            continue
                        if info.file_size > 60 * 1024 * 1024:
                            continue
                        out.append((f"{rel} › {info.filename}", z.read(info)))
            except zipfile.BadZipFile:
                out.append((rel, b""))
        elif ext in INTAKE_EXT and f.stat().st_size <= 60 * 1024 * 1024:
            out.append((rel, f.read_bytes()))
    return out


def _run(con, bid: str) -> None:
    init(con)
    b = con.execute("SELECT * FROM intake_batches WHERE id=?", (bid,)).fetchone()
    opts = json.loads(b["options"] or "{}")
    root = Path(b["root"])
    if not root.is_dir():
        _set(con, bid, status="FAILED", stage="failed", message=f"{root} is not readable", finished_at=_now())
        return
    files = _files(root, opts.get("include"))
    _set(con, bid, files_total=len(files), stage="reading", message=f"Reading {len(files)} files…")
    k = Knowledge(con)
    seen_hash: dict[str, str] = {}
    seen_code: dict[str, str] = {}
    # a file read in an earlier upload is not read again: re-syncing a folder must not refile it
    earlier = {r["file_hash"]: (r["status"], r["file"]) for r in con.execute(
        """SELECT file_hash, status, file FROM intake_items
            WHERE batch_id <> ? AND status IN ('SAVED','ON_RECORD','REVIEW','READY') ORDER BY created_at""", (bid,))}
    use_llm = bool(opts.get("use_llm", True)) and llm_up()
    items = []
    for n, (name, data) in enumerate(files, 1):
        h = hashlib.sha256(data).hexdigest()
        if h in seen_hash and data:
            items.append(_item(bid, name, h, 1, 1, Sorted(title=PurePosixPath(name.split(" › ")[-1]).stem),
                               status="DUPLICATE", reasons=[f"the same file as {seen_hash[h]}"], duplicate_of=seen_hash[h],
                               size=len(data)))
            continue
        if h in earlier and data:
            st, was = earlier[h]
            items.append(_item(bid, name, h, 1, 1, Sorted(title=PurePosixPath(name.split(" › ")[-1]).stem),
                               status="ON_RECORD" if st in ("SAVED", "ON_RECORD") else "DUPLICATE",
                               reasons=[f"already read in an earlier upload ({was})" if st in ("SAVED", "ON_RECORD")
                                        else f"already waiting for review from an earlier upload ({was})"],
                               duplicate_of=was, size=len(data)))
            continue
        seen_hash[h] = name
        r = read_bytes(data, name.split(" › ")[-1]) if data else Read([], note="an empty or damaged file")
        whole_title = re.sub(r"[_\-]+", " ", PurePosixPath(name.split(" › ")[-1]).stem).strip()
        parts = split(r) if r.blocks else [Part("", [], None)]
        for i, part in enumerate(parts, 1):
            s = sort_part(k, part, file=name.replace(" › ", "/"), header=r.header, whole_title=whole_title,
                          compound=len(parts) > 1 and part.code is None, ocr=r.ocr)
            if not r.blocks:
                s.confidence = min(s.confidence, 55)
            reasons = []
            # the local AI, only when the rules are unsure and there is text to read
            if use_llm and s.text and (s.confidence < AUTO_TYPE or (s.doc_type in NEEDS_DEPARTMENT and s.dept_status != "matched")):
                d = ask_llm(k, s, name)
                if d:
                    t = str(d.get("type") or "")
                    if t in HOME and s.confidence < AUTO_TYPE:     # the rules were unsure: the AI decides, capped
                        conf = int(d.get("confidence") or 60)
                        agrees = t == s.doc_type
                        s.doc_type, s.method = t, "ai"
                        s.confidence = min(max(conf, s.confidence + 15 if agrees else 0), 90)
                        s.evidence = f'local AI: "{str(d.get("evidence") or "")[:160]}"' + (f"; {s.evidence}" if s.evidence else "")
                    dn = str(d.get("department") or "").strip()
                    if dn and s.dept_status != "matched":
                        node = k.department(dn)
                        if node:
                            s.department, s.dept_node, s.dept_status = node["name"], node["id"], "matched"
                            s.dept_evidence = "local AI read the content"
                        elif not s.department:
                            s.department, s.dept_status, s.dept_evidence = dn[:80], "proposed", "local AI suggests a new department"
                    if d.get("title") and not part.head and len(s.title) < 4:
                        s.title = str(d["title"])[:200]
            # what happens to it
            existing = k.on_record.get(s.code) if s.code else None
            same_file = None if i > 1 else k.files.get((PurePosixPath(name.split(" › ")[-1]).name.lower(), len(data)))
            if s.code and s.code in seen_code:
                status, reasons = "DUPLICATE", [f"code {s.code} already appears in {seen_code[s.code]}"]
            elif existing:
                status, reasons = "ON_RECORD", [f"{s.code} is already in your records"]
            elif same_file:
                existing = same_file
                status, reasons = "ON_RECORD", ["this file is already in your records"]
            else:
                if not r.blocks:
                    reasons.append(r.note or "no readable text")
                if s.doc_type == "Other":
                    reasons.append("could not tell what kind of document this is")
                elif s.confidence < AUTO_TYPE:
                    reasons.append(f"not sure it is a {s.doc_type} ({s.confidence}%)")
                if s.doc_type in NEEDS_DEPARTMENT and s.dept_status != "matched":
                    reasons.append(f'department "{s.department}" does not exist yet' if s.dept_status == "proposed"
                                   else "no department found")
                status = "REVIEW" if reasons else "READY"
            if s.code:
                seen_code.setdefault(s.code, f"{name}" + (f" (part {i})" if len(parts) > 1 else ""))
            it = _item(bid, name, h, i, len(parts), s, status=status, reasons=reasons, existing=existing, ocr=r.ocr,
                       size=len(data))
            items.append(it)
        if n % 5 == 0 or n == len(files):
            _set(con, bid, files_done=n, message=f"Read {n} of {len(files)} files · {len(items)} documents found")
    _insert(con, items)
    _set(con, bid, stage="saving", message="Saving the confident documents into the company structure…")
    ready = [it["id"] for it in items if it["status"] == "READY"]
    save(con, ready, actor=f"document intake ({b['created_by']})", how="auto")
    _refresh_counts(con, bid)
    c = con.execute("SELECT saved, review, on_record, items FROM intake_batches WHERE id=?", (bid,)).fetchone()
    _set(con, bid, status="DONE", stage="done", finished_at=_now(),
         message=f"{c['items']} documents: {c['saved']} filed automatically, {c['review']} to review, "
                 f"{c['on_record']} already on record")


def _item(bid, name, h, part, parts, s: Sorted, *, status, reasons, existing=None, duplicate_of=None, ocr=False,
          size=None) -> dict:
    return {
        "id": f"ii-{secrets.token_hex(6)}", "batch_id": bid, "file": name, "file_hash": h, "part": part, "parts": parts,
        "doc_type": s.doc_type, "type_confidence": s.confidence, "type_evidence": s.evidence, "type_method": s.method,
        "code": s.code, "code_written": s.code_written, "title": s.title, "version": s.version,
        "effective_date": s.effective, "review_date": s.review, "department": s.department,
        "department_node_id": s.dept_node, "department_status": s.dept_status, "department_evidence": s.dept_evidence,
        "owner_text": s.owner_text, "owner_id": s.owner_id, "approver_text": s.approver_text, "approver_id": s.approver_id,
        "people": json.dumps(s.people, ensure_ascii=False), "refs": json.dumps(s.refs), "excerpt": s.text[:600],
        "text": s.text, "chars": len(s.text), "ocr": 1 if ocr else 0, "status": status,
        "reasons": json.dumps(reasons, ensure_ascii=False), "existing_entity_id": existing, "duplicate_of": duplicate_of,
        "created_at": _now(), "updated_at": _now(), "bytes": size,
    }


def _insert(con, items: list[dict]) -> None:
    if not items:
        return
    cols = list(items[0])
    con.executemany(f"INSERT INTO intake_items ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                    [tuple(it[c] for c in cols) for it in items])
    con.commit()


def _refresh_counts(con, bid: str) -> None:
    c = {r[0]: r[1] for r in con.execute("SELECT status, count(*) FROM intake_items WHERE batch_id=? GROUP BY 1", (bid,))}
    _set(con, bid, items=sum(c.values()), saved=c.get("SAVED", 0), review=c.get("REVIEW", 0) + c.get("READY", 0),
         on_record=c.get("ON_RECORD", 0))


# ------------------------------------------------------------------ saving into the company structure
def _ensure_department(con, name: str, k: Knowledge, actor: str) -> str | None:
    node = k.department(name)
    if node:
        return node["id"]
    from . import taxonomy as TX
    TX.init(con)
    nid = TX.add_node(con, name=name.strip()[:80], parent_id=k.dept_parent, kind="Department",
                      description="Added when a document upload named it", actor=actor)["id"]
    k.depts[norm_dept(name)] = {"id": nid, "name": name.strip()[:80], "parent_id": k.dept_parent}
    return nid


def save(con, ids: list[str], *, actor: str, how: str = "reviewed") -> dict:
    """Write items into the company structure: one record each, in its department, linked to what it names."""
    if not ids:
        return {"saved": 0}
    from . import company_db
    init(con)
    company_db.init(con)
    k = Knowledge(con)
    rows = [dict(r) for r in con.execute("SELECT * FROM intake_items WHERE id = ANY(?)", (ids,))]
    roots = {r["id"]: r["root"] for r in con.execute(
        "SELECT id, root FROM intake_batches WHERE id = ANY(?)", (list({r["batch_id"] for r in rows}),))}
    saved = []
    for it in rows:
        if it["status"] not in ("READY", "REVIEW"):
            continue
        typ = it["doc_type"] if it["doc_type"] in HOME else "Other"
        domain, etype = HOME[typ]
        node = it["department_node_id"]
        # a department the documents name but the structure lacks is created only when a person files it
        if not node and it["department"] and it["department_status"] == "proposed" and how != "auto":
            node = _ensure_department(con, it["department"], k, actor)
        key = it["code"] or _slug(it["title"] or it["file"])
        eid = f"doc-{_slug(typ, 12)}-{_slug(key)}"
        if con.execute("SELECT 1 FROM company_entities WHERE id=?", (eid,)).fetchone():
            eid = f"{eid}-{it['id'][-4:]}"
        people = json.loads(it["people"] or "[]")
        attrs = {
            "code": it["code"], "codeAsWritten": it["code_written"], "version": it["version"],
            "effectiveDate": it["effective_date"], "reviewDate": it["review_date"], "department": it["department"],
            "owner": it["owner_text"], "approvedBy": it["approver_text"],
            "people": "; ".join(f"{p['label']}: {p['value']}" for p in people),
            "file": it["file"] + (f" (part {it['part']} of {it['parts']})" if (it["parts"] or 1) > 1 else ""),
            "sortedAs": f"{typ} ({it['type_confidence']}%) — {it['type_evidence']}",
            "placedIn": f"{it['department'] or '—'} — {it['department_evidence'] or ''}",
            "intakeBatch": it["batch_id"], "intakeItem": it["id"], "excerpt": (it["excerpt"] or "")[:500],
        }
        company_db.upsert_entity(con, {
            "id": eid, "domain": domain, "type": etype, "name": (it["title"] or PurePosixPath(it["file"]).stem)[:300],
            "description": (it["excerpt"] or "")[:400],
            "ownerId": it["owner_id"],              # the approver signs; the owner answers for it — not guessed
            "lifecycle": "Active", "status": "Active", "verification": "Pending",
            "attrs": {k2: v for k2, v in attrs.items() if v not in (None, "", [])},
            "source": "document intake", "source_reference": it["code"] or it["file"],
            "orgNodeId": node,
        }, actor=actor)
        con.execute("UPDATE company_entities SET org_node_id=? WHERE id=?", (node, eid))
        # the file itself, so the record opens it and it can be shared with an auditor
        on_disk = it["file"].split(" › ")[0]
        con.execute("""INSERT INTO company_documents (id, name, kind, size, linked_entity_id, status, uploaded_at,
                       document_type, version, approved_by, source, source_reference, storage_path, content_hash)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET
                       linked_entity_id=EXCLUDED.linked_entity_id, document_type=EXCLUDED.document_type,
                       name=EXCLUDED.name, version=EXCLUDED.version, approved_by=EXCLUDED.approved_by""",
                    (f"cdoc-{it['id']}", (it["title"] or PurePosixPath(on_disk).stem)[:300],
                     PurePosixPath(it["file"].split(" › ")[-1]).suffix.lstrip(".").lower(), it.get("bytes"), eid, "Filed", _now(), typ,
                     it["version"], it["approver_text"], "document intake", it["file"],
                     str(Path(roots.get(it["batch_id"]) or "") / on_disk), it["file_hash"]))
        con.execute("""UPDATE intake_items SET status='SAVED', saved_how=?, entity_id=?, department_node_id=?, decided_by=?,
                       department_status=?, updated_at=? WHERE id=?""",
                    (how, eid, node, actor, "matched" if node else it["department_status"], _now(), it["id"]))
        if it["code"]:
            k.on_record[it["code"]] = eid
        saved.append((it, eid, typ))
    con.commit()
    _link(con, k, saved)
    for bid in {it["batch_id"] for it, _, _ in saved}:
        _refresh_counts(con, bid)
    return {"saved": len(saved)}


def _link(con, k: Knowledge, saved: list) -> None:
    """An SOP to the policy it names; a form to the SOP that names it, or that it names."""
    from . import company_db
    types = {}
    for r in con.execute("SELECT id, type FROM company_entities WHERE id = ANY(?)", (list(set(k.on_record.values())),)):
        types[r["id"]] = r["type"]
    for it, eid, typ in saved:
        for ref in json.loads(it["refs"] or "[]"):
            other = k.on_record.get(ref)
            if not other or other == eid:
                continue
            ot = types.get(other) or ""
            pair = None
            if typ == "SOP" and ot == "Policy":
                pair = (eid, "governed_by", other)
            elif typ == "Policy" and ot == "SOP":
                pair = (other, "governed_by", eid)
            elif typ == "Form" and ot == "SOP":
                pair = (eid, "proves", other)
            elif typ == "SOP" and ot == "Form":
                pair = (other, "proves", eid)
            if pair:
                try:
                    company_db.add_relationship(con, {"id": f"rel-{_slug(pair[0], 40)}-{pair[1]}-{_slug(pair[2], 40)}",
                                                      "sourceId": pair[0], "type": pair[1], "targetId": pair[2],
                                                      "confidence": 90, "status": "Pending"})
                except Exception:                                   # noqa: BLE001 — an edge already there
                    pass
    con.commit()


# ------------------------------------------------------------------ corrections and learning
def _waiting(it: dict) -> list[str]:
    """Why an item still needs a person, after a correction or a remembered rule."""
    out = []
    if it["type_method"] != "person":
        if it["doc_type"] == "Other":
            out.append("could not tell what kind of document this is")
        elif (it["type_confidence"] or 0) < AUTO_TYPE:
            out.append(f"not sure it is a {it['doc_type']} ({it['type_confidence']}%)")
    if it["doc_type"] in NEEDS_DEPARTMENT and it["department_status"] != "matched":
        # a new department a person chose (or taught) is theirs to create: filing creates it
        if it["department_status"] == "proposed" and not str(it.get("department_evidence") or "").startswith(("set by", "remembered")):
            out.append(f'department "{it["department"]}" does not exist yet')
        elif it["department_status"] == "unknown":
            out.append("no department found")
    return out


def correct(con, item_id: str, changes: dict, *, actor: str, remember: bool) -> dict:
    """A person fixes an item's type, department or owner; with remember, the rule applies to the next upload."""
    init(con)
    it = con.execute("SELECT * FROM intake_items WHERE id=?", (item_id,)).fetchone()
    if not it:
        raise ValueError("no such item")
    it = dict(it)
    k = Knowledge(con)
    upd: dict[str, Any] = {}
    learned = []
    if changes.get("doc_type") in HOME and changes["doc_type"] != it["doc_type"]:
        upd.update(doc_type=changes["doc_type"], type_confidence=100, type_method="person",
                   type_evidence=f"set by {actor}")
        if remember:
            codes = find_codes(it["code_written"] or it["code"] or "")
            if codes:
                learned.append(("type_token", codes[0][3], changes["doc_type"]))
    if "department" in changes:
        name = (changes.get("department") or "").strip()
        node = k.department(name) if name else None
        upd.update(department=node["name"] if node else name, department_node_id=node["id"] if node else None,
                   department_status="matched" if node else ("proposed" if name else "unknown"),
                   department_evidence=f"set by {actor}")
        if remember and name:
            codes = find_codes(it["code_written"] or it["code"] or "")
            if codes:
                learned.append(("prefix_department", codes[0][2], node["name"] if node else name))
            folders = PurePosixPath(it["file"].split(" › ")[0]).parent.parts
            if folders and not codes:
                learned.append(("folder_department", folders[-1].lower(), node["name"] if node else name))
    for key in ("title", "owner_id", "owner_text"):
        if key in changes:
            upd[key] = changes[key]
    if upd:
        upd["updated_at"] = _now()
        upd["reasons"] = json.dumps(_waiting({**it, **upd}))
        con.execute(f"UPDATE intake_items SET {', '.join(f'{c}=?' for c in upd)} WHERE id=?", (*upd.values(), item_id))
    for kind, key, value in learned:
        con.execute("""INSERT INTO intake_rules (id, kind, key, value, created_by, created_at) VALUES (?,?,?,?,?,?)
                       ON CONFLICT (kind, key) DO UPDATE SET value=EXCLUDED.value, created_by=EXCLUDED.created_by,
                       created_at=EXCLUDED.created_at""",
                    (f"ir-{secrets.token_hex(5)}", kind, key, value, actor, _now()))
    con.commit()
    applied = 0
    if learned:
        applied = reapply(con, it["batch_id"])
    return {"updated": bool(upd), "learned": [{"kind": a, "key": b, "value": c} for a, b, c in learned], "applied": applied}


def reapply(con, bid: str) -> int:
    """Run the remembered rules over the items still waiting for review in a batch."""
    k = Knowledge(con)
    n = 0
    for it in con.execute("SELECT * FROM intake_items WHERE batch_id=? AND status='REVIEW'", (bid,)).fetchall():
        it = dict(it)
        upd = {}
        codes = find_codes(it["code_written"] or it["code"] or "")
        if codes:
            tt = k.rules.get(("type_token", codes[0][3]))
            if tt and it["type_method"] != "person" and tt != it["doc_type"]:
                upd.update(doc_type=tt, type_confidence=92, type_evidence=f'remembered: code type "{codes[0][3]}" means {tt}')
            pd = k.rules.get(("prefix_department", codes[0][2]))
            if pd and it["department_status"] != "matched" and not str(it["department_evidence"] or "").startswith("set by"):
                node = k.department(pd)
                upd.update(department=node["name"] if node else pd, department_node_id=node["id"] if node else None,
                           department_status="matched" if node else "proposed",
                           department_evidence=f'remembered: code prefix "{codes[0][2]}" is {pd}')
        if upd:
            upd["updated_at"] = _now()
            upd["reasons"] = json.dumps(_waiting({**it, **upd}))
            con.execute(f"UPDATE intake_items SET {', '.join(f'{c}=?' for c in upd)} WHERE id=?", (*upd.values(), it["id"]))
            n += 1
    con.commit()
    return n


# ------------------------------------------------------------------ undo
def undo(con, bid: str, *, actor: str) -> dict:
    """Remove what this upload filed, while it is still unverified. Verified records are kept."""
    from . import company_db
    init(con)
    removed = kept = 0
    for it in con.execute("SELECT id, entity_id FROM intake_items WHERE batch_id=? AND status='SAVED'", (bid,)).fetchall():
        e = con.execute("SELECT verification FROM company_entities WHERE id=?", (it["entity_id"],)).fetchone()
        if e and e["verification"] not in ("Pending", None, ""):
            kept += 1
            continue
        con.execute("DELETE FROM entity_relationships WHERE source_id=? OR target_id=?", (it["entity_id"], it["entity_id"]))
        con.execute("DELETE FROM company_documents WHERE id=? AND source='document intake'", (f"cdoc-{it['id']}",))
        con.execute("DELETE FROM company_entities WHERE id=?", (it["entity_id"],))
        con.execute("UPDATE intake_items SET status='UNDONE', updated_at=? WHERE id=?", (_now(), it["id"]))
        company_db.log(con, it["entity_id"], "removed by undoing a document upload", bid, actor)
        removed += 1
    # what was still waiting for review goes with the upload
    left = con.execute("""UPDATE intake_items SET status='SKIPPED', reasons=?, updated_at=?
                           WHERE batch_id=? AND status IN ('REVIEW','READY')""",
                       (json.dumps(["the upload was undone"]), _now(), bid)).rowcount
    con.commit()
    _refresh_counts(con, bid)
    _set(con, bid, status="UNDONE", message=f"Undone by {actor}: {removed} records removed" + (f", {kept} verified records kept" if kept else ""))
    return {"removed": removed, "kept_verified": kept}
