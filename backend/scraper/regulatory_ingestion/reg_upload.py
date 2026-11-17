"""
Upload a regulation and watch it land: text -> obligations -> requirements ->
RAG -> gap assessment against the hospital's own documents -> Impact Cascade.

The API (api_reg_upload.py) stores the file and queues a job; this module is
the worker. It runs as its own process (``python -m regulatory_ingestion.reg_upload``)
so a long OCR or LLM run never ties up an API worker, and a flock makes sure
only one runner works the queue however many API workers kick it.

Stages, each written to reg_uploads so the page can show live progress:
  extract    pdftotext per page; OCR (ocr_pdf.sh) when the PDF is a scan; DOCX/TXT read directly
  profile    local LLM reads the opening pages: title, regulator, type, applicability to the hospital
  structure  local LLM, one call per ~4,000-character slice: every duty on the hospital, rewritten
             as an obligation + testable requirement, with severity and whether it applies.
             Each slice is loaded into the app as soon as it is read (status NOT_ASSESSED).
  embed      page text into the RAG store (company_brain_rag.chunks, source_table 'upload')
  assess     per requirement, the most relevant hospital passages are retrieved by meaning
             (bge-base, same model as RAG) and the local LLM judges MET / PARTIAL / GAP /
             NOT_COVERED, citing document codes. Each batch is written to the compliance
             tables and gap_assessments as it finishes, so the Impact Cascade fills in live.

Every LLM answer is cached in the job folder, so a retry after a restart resumes
where it stopped. Every row the job writes carries the job id in its id
(<regulation>-u<job>-...), so deleting the job removes exactly what it added.

Risk is a rule on the LLM's severity of breach (Critical / High / Medium / Low):
GAP and NOT_COVERED take the severity, PARTIAL one band lower, MET none.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx

SCRAPER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRAPER))

from .db import connect                                          # noqa: E402

# a company workspace (tenancy.py) keeps its upload jobs in its own folder
ROOT = Path(os.environ.get("CB_REG_UPLOADS_DIR") or SCRAPER / "output" / "reg-uploads")
LOCK = ROOT / ".runner.lock"
LLM_BASE = os.environ.get("LOCAL_LLM_BASE_URL", "http://172.22.64.1:8081/v1")
LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "gpt-oss-120b")
LLM_SLOTS = 4                                  # llama-server parallel slots
COMPANY = 1
SLICE = 4000                                   # characters of regulation text per structuring call
JUDGE_BATCH = 6                                # requirements per assessment call
BANDS = ["None", "Low", "Medium", "High", "Critical"]
STATUS = {"MET": "COMPLIANT", "PARTIAL": "PARTIALLY_COMPLIANT", "GAP": "NON_COMPLIANT",
          "NOT_COVERED": "EVIDENCE_MISSING", "NOT_APPLICABLE": "NOT_APPLICABLE"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS reg_uploads (
  id            TEXT PRIMARY KEY,
  regulation_id TEXT NOT NULL,
  attach        INTEGER NOT NULL DEFAULT 0,     -- 1 = added to an existing regulation
  filename      TEXT NOT NULL,
  title         TEXT, regulator TEXT, regulation_type TEXT, jurisdiction TEXT,
  status        TEXT NOT NULL,                  -- QUEUED RUNNING DONE FAILED
  stage         TEXT, done INTEGER DEFAULT 0, total INTEGER DEFAULT 0,
  message       TEXT, counts TEXT, log TEXT,
  created_by    TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT
);
"""

now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")   # noqa: E731


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def init(con):
    con.executescript(SCHEMA)
    con.commit()
    return con


# --------------------------------------------------------------------------- #
# Job bookkeeping                                                              #
# --------------------------------------------------------------------------- #
class Job:
    def __init__(self, con, jid: str):
        self.con, self.id = con, jid
        self.row = dict(con.execute("SELECT * FROM reg_uploads WHERE id=?", (jid,)).fetchone())
        self.dir = ROOT / jid
        self.reg = self.row["regulation_id"]
        self.prefix = f"{self.reg}-u{jid}"
        self.counts: dict = json.loads(self.row.get("counts") or "{}")
        self.lines: list[str] = json.loads(self.row.get("log") or "[]")
        self.lock = threading.Lock()

    def set(self, **kw):
        with self.lock:
            if "log" in kw:
                self.lines = (self.lines + [f"{datetime.now().strftime('%H:%M:%S')} {kw.pop('log')}"])[-60:]
            kw["log"] = json.dumps(self.lines)
            kw["counts"] = json.dumps(self.counts)
            kw["updated_at"] = now()
            cols = ", ".join(f"{k}=?" for k in kw)
            self.con.execute(f"UPDATE reg_uploads SET {cols} WHERE id=?", (*kw.values(), self.id))
            self.con.commit()

    def cache(self, name: str) -> Path:
        p = self.dir / "work" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        return p


# --------------------------------------------------------------------------- #
# Local LLM                                                                     #
# --------------------------------------------------------------------------- #
def llm_up() -> tuple[bool, str]:
    try:
        r = httpx.get(f"{LLM_BASE}/models", timeout=5)
        r.raise_for_status()
        return True, f"{LLM_MODEL} at {LLM_BASE}"
    except Exception as ex:                                      # noqa: BLE001
        return False, f"local LLM not reachable at {LLM_BASE} ({type(ex).__name__})"


def ask(prompt: str, max_tokens: int = 4000) -> dict:
    body = {"model": LLM_MODEL, "temperature": 0, "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"reasoning_effort": "low"},
            "messages": [{"role": "user", "content": prompt}]}
    # Two kinds of failure, treated differently. The server being down or still
    # loading the model (connection refused, 502/503) is waited out for up to
    # 15 minutes — a restarting llama-server used to fail the whole job after
    # three quick retries. A bad answer (unparseable JSON) is retried 3 times.
    last = None
    bad_answers = 0
    deadline = time.time() + 900
    while True:
        try:
            r = httpx.post(f"{LLM_BASE}/chat/completions", json=body, timeout=1800)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"] or ""
            return json.loads(content[content.find("{"): content.rfind("}") + 1])
        except (httpx.TransportError, OSError) as ex:            # unreachable, timed out, dropped
            last = ex
        except httpx.HTTPStatusError as ex:
            last = ex
            if ex.response.status_code not in (502, 503, 504):
                bad_answers += 1
        except Exception as ex:                                  # noqa: BLE001 — a bad answer
            last = ex
            bad_answers += 1
        if bad_answers >= 3 or time.time() > deadline:
            raise RuntimeError(f"LLM call failed: {last}")
        time.sleep(15)


def cached_ask(job: Job, name: str, prompt: str, max_tokens: int = 4000) -> dict:
    p = job.cache(name)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:                                        # noqa: BLE001 — re-ask
            pass
    ans = ask(prompt, max_tokens)
    p.write_text(json.dumps(ans, ensure_ascii=False))
    return ans


# --------------------------------------------------------------------------- #
# 1. Text                                                                       #
# --------------------------------------------------------------------------- #
def extract_pages(job: Job, path: Path) -> list[str]:
    cache = job.cache("pages.json")
    if cache.exists():
        return json.loads(cache.read_text())
    ext = path.suffix.lower()
    if ext == ".pdf":
        out = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, timeout=600)
        pages = out.stdout.decode("utf8", "ignore").split("\f")
        if pages and not pages[-1].strip():
            pages = pages[:-1]
        n = len(pages) or int(re.search(r"Pages:\s+(\d+)", subprocess.run(
            ["pdfinfo", str(path)], capture_output=True, text=True).stdout).group(1))
        real = sum(len(p.strip()) for p in pages)
        if real < 200 * max(n, 1):                       # a scan: little or no text layer
            pages = ocr(job, path, n)
    elif ext == ".docx":
        import classify_company_documents as C
        paras = [t for _s, t in C.paragraphs(path) if t.strip()]
        pages, cur = [], ""
        for t in paras:                                   # DOCX has no pages: ~3,000-char pseudo pages
            cur += t + "\n"
            if len(cur) > 3000:
                pages.append(cur)
                cur = ""
        if cur:
            pages.append(cur)
    else:
        text = path.read_text(errors="ignore")
        if ext in (".html", ".htm"):
            text = re.sub(r"<[^>]+>", " ", text)
        pages = [text[i:i + 3000] for i in range(0, len(text), 3000)]
    pages = [re.sub(r"[ \t]+", " ", p).strip() for p in pages]
    cache.write_text(json.dumps(pages, ensure_ascii=False))
    return pages


def ocr(job: Job, pdf: Path, n: int) -> list[str]:
    out = job.dir / "ocr"
    job.set(stage="ocr", done=0, total=n, log=f"no text layer — OCR of {n} pages")
    proc = subprocess.Popen(["bash", str(SCRAPER / "ocr_pdf.sh"), str(pdf), str(out), str(min(16, os.cpu_count() or 4))],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while proc.poll() is None:
        time.sleep(4)
        done = len(list((out / "pages").glob("p-*.txt"))) if (out / "pages").exists() else 0
        job.set(done=done)
    text = (out / "ocr.txt").read_text(errors="ignore")
    pages = re.split(r"<<<PAGE \d+>>>\n", text)[1:]
    job.set(done=n, log=f"OCR done · {sum(len(p) for p in pages):,} characters")
    return pages


def slices(pages: list[str]) -> list[dict]:
    """Paragraph-aligned slices of ~SLICE characters, each remembering its first page."""
    out, cur, first = [], "", 1
    for pno, page in enumerate(pages, 1):
        for para in re.split(r"\n\s*\n", page):
            para = para.strip()
            if not para:
                continue
            if cur and len(cur) + len(para) > SLICE:
                out.append({"page": first, "text": cur})
                cur, first = "", pno
            if not cur:
                first = pno
            cur += para + "\n\n"
            while len(cur) > SLICE * 1.5:                 # one enormous paragraph (OCR tables)
                out.append({"page": first, "text": cur[:SLICE]})
                cur = cur[SLICE:]
    if cur.strip():
        out.append({"page": first, "text": cur})
    return out


# --------------------------------------------------------------------------- #
# 2. Profile + applicability                                                    #
# --------------------------------------------------------------------------- #
def company_facts(con) -> dict:
    r = con.execute("SELECT * FROM company_profile WHERE id=?", (COMPANY,)).fetchone()
    return dict(r) if r else {}


def describe(f: dict) -> str:
    def j(v):
        try:
            return ", ".join(json.loads(v)) if v else ""
        except Exception:                                        # noqa: BLE001
            return str(v)
    return (f"{f.get('legal_name', 'The hospital')}: a {f.get('beds') or ''}-bed private {f.get('entity_type') or 'hospital'} "
            f"in {f.get('hq_state') or 'India'}, India ({f.get('legal_form') or 'company'}, {f.get('employees') or '?'} employees). "
            f"Sectors: {j(f.get('sectors'))}. Holds/needs: {j(f.get('licences'))[:600]}.")


PROFILE = """You are a hospital regulatory analyst in India. Read the opening of an uploaded regulatory
document and answer about it.

THE HOSPITAL: {company}

DOCUMENT FILE NAME: {filename}
OPENING TEXT:
{text}

Answer with JSON only:
{{"title":"<official title of the document>","short":"<short name, under 8 words>",
"regulator":"<issuing body>","type":"Act|Rules|Regulations|Notification|Circular|Guidelines|Standard|Order|Other",
"jurisdiction":"India|<state name>","effective":"YYYY-MM-DD or empty",
"verdict":"APPLICABLE|CONDITIONAL|NOT_APPLICABLE",
"reason":"<one or two sentences: does this document place duties on this hospital, and why>"}}"""


# --------------------------------------------------------------------------- #
# 3. Obligations + requirements                                                 #
# --------------------------------------------------------------------------- #
EXTRACT = """You are a hospital compliance analyst in India. Below is part {i} of {n} of the regulatory
document "{title}" ({regulator}).

THE HOSPITAL: {company}

Extract EVERY provision in this part that places a duty, prohibition, licence/registration,
record-keeping, reporting, display, staffing or infrastructure requirement on a hospital /
healthcare establishment (or on it as employer, occupier, licensee, or data holder).
Skip definitions, preambles, contents pages, and powers or duties of the government/authority.
Merge sub-clauses that make one duty; split a provision that makes several distinct duties.

For each item:
"sec": section / rule / clause number as printed (e.g. "Rule 8(2)", "4.3.1"), or ""
"h":   short heading of the section it sits in
"t":   the source wording, quoted briefly (max 50 words)
"ob":  the obligation as one duty sentence starting "The hospital shall" (or "shall not")
"rq":  the testable requirement: what an assessor checks, and the evidence that proves it
"who": responsible role or department; "freq": how often ("Ongoing", "Per event", "Annually", ...)
"sev": consequence of breach: "Critical" (criminal liability, closure/licence cancellation, serious
       patient harm), "High" (significant fine or regulatory action), "Medium" (administrative penalty,
       inspection finding), "Low" (procedural)
"ap":  true if it applies to THIS hospital; false if it only applies to other kinds of entity,
       other states, or services a general hospital would not run
"na":  why not, when "ap" is false

Answer with JSON only: {{"r":[{{"sec":"","h":"","t":"","ob":"","rq":"","who":"","freq":"","sev":"","ap":true,"na":""}}]}}
If the part contains no such duty, answer {{"r":[]}}. Keep every field short.

TEXT (part {i} of {n}):
{text}"""


def unit_of(sec: str, h: str) -> str:
    m = re.match(r"\s*((?:Section|Sec\.|Rule|Regulation|Reg\.|Clause|Article|Schedule|Chapter|Part|Para(?:graph)?|Annex(?:ure)?|Form)\s*[\dIVXLC]+[A-Z]?)",
                 sec or "", re.I)
    if m:
        return m.group(1).strip()
    m = re.match(r"\s*(\d+[A-Z]?)(?:[.(\s]|$)", sec or "")
    if m:
        return m.group(1)
    return (h or "General")[:60]


# --------------------------------------------------------------------------- #
# 4. Gap assessment                                                             #
# --------------------------------------------------------------------------- #
JUDGE = """You are a hospital compliance assessor doing a document-based gap assessment against
"{title}" ({regulator}).

{scope}

INDEX OF EVERY POLICY AND SOP THE HOSPITAL HAS (code: title):
{index}

MOST RELEVANT PASSAGES FROM THE HOSPITAL'S DOCUMENTS, retrieved by meaning for these requirements
(code | type | title: text):
{passages}

REQUIREMENTS TO JUDGE:
{reqs}

For EVERY requirement decide from the passages only:
- MET: a policy/SOP/control/form clearly satisfies it.
- PARTIAL: something relevant exists but a specific part is missing (say exactly what).
- GAP: it falls in an area the hospital documented, but the requirement is not addressed.
- NOT_COVERED: it belongs to an area for which the hospital provided no documents.
A passage that merely shares words does not count; it must actually satisfy the requirement.
If the index shows a policy/SOP whose title clearly addresses it but its passage is not shown,
treat it as at least PARTIAL and cite that code.

Answer with JSON only:
{{"r":[{{"i":<requirement number>,"st":"MET|PARTIAL|GAP|NOT_COVERED","by":["<doc codes that satisfy it>"],
"gap":"<what is missing, empty if MET>","fix":"<recommended action, empty if MET>",
"why":"<one line: consequence for patients / the hospital if not met>"}}]}}
Keep every field under 30 words."""


def risk_for(sev: str, st: str) -> str:
    base = sev if sev in BANDS[1:] else "Medium"
    if st == "MET":
        return "None"
    if st == "PARTIAL":
        return BANDS[max(1, BANDS.index(base) - 1)]
    return base


def company_folder() -> Path | None:
    from .upload_store import ROOT as uploads     # the company's own uploads folder
    dirs = sorted(uploads.glob("company-documents-*"))
    return dirs[-1] if dirs else None


class Corpus:
    """The hospital's documents as provision-level passages, embedded once per run."""

    def __init__(self, folder: Path):
        import nabh6_gap as G
        from . import rag
        self.docs = G.company_corpus(folder)
        self.model = rag.model()
        self.emb = self.model.encode([f"{d['kind']} {d['code']} {d['title']}. {d['text'][:1500]}" for d in self.docs],
                                     normalize_embeddings=True, batch_size=32, show_progress_bar=False)
        self.index = "\n".join(dict.fromkeys(f"{d['code']}: {d['title']}" for d in self.docs
                                             if d["kind"] in ("Policy", "SOP")))
        self.codes = {d["code"] for d in self.docs}
        areas = sorted({f.name.replace("_", " ").rsplit(".", 1)[0] for f in folder.rglob("*")
                        if f.is_file() and f.suffix.lower() in (".docx", ".xlsx")})
        self.scope = ("The hospital has provided ONLY these documents: " + "; ".join(areas) +
                      ". Anything outside the areas these documents cover is NOT_COVERED.")

    def top(self, query: str, k: int = 5):
        import numpy as np
        q = self.model.encode(["Represent this sentence for searching relevant passages: " + query],
                              normalize_embeddings=True)[0]
        sims = self.emb @ q
        return [(self.docs[i], float(sims[i])) for i in np.argsort(-sims)[:k]]


# --------------------------------------------------------------------------- #
# Loading into the app                                                          #
# --------------------------------------------------------------------------- #
def ensure_regulation(job: Job, prof: dict) -> None:
    con, r = job.con, job.row
    if r["attach"]:
        return
    ts = now()
    title = r["title"] or prof.get("title") or Path(r["filename"]).stem
    con.execute(
        """INSERT INTO regulations (id,title,short_title,regulator,regulator_short,regulation_type,jurisdiction,sector,
             effective_from,status,applicability,ingestion_status,source_verified,created_at,updated_at,language)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, short_title=EXCLUDED.short_title,
             regulator=EXCLUDED.regulator, regulator_short=EXCLUDED.regulator_short,
             regulation_type=EXCLUDED.regulation_type, jurisdiction=EXCLUDED.jurisdiction,
             effective_from=EXCLUDED.effective_from, applicability=EXCLUDED.applicability, updated_at=EXCLUDED.updated_at""",
        (job.reg, title, (prof.get("short") or title)[:120], r["regulator"] or prof.get("regulator") or "",
         r["regulator"] or prof.get("regulator") or "", r["regulation_type"] or prof.get("type") or "Other",
         r["jurisdiction"] or prof.get("jurisdiction") or "India", "Healthcare & Hospitals",
         prof.get("effective") or None, "Active", prof.get("verdict") or "CONDITIONAL", "STRUCTURED", 0, ts, ts, "en"))
    con.execute("DELETE FROM applicability_results WHERE regulation_id=? AND company_id=? AND scope_type='COMPANY'",
                (job.reg, COMPANY))
    con.execute(
        """INSERT INTO applicability_results (id,regulation_id,company_id,scope_type,verdict,confidence,reason,checks,
             missing_facts,engine_version,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (f"app-{job.reg}-{COMPANY}", job.reg, COMPANY, "COMPANY", prof.get("verdict") or "CONDITIONAL", "MEDIUM",
         prof.get("reason") or "", "[]", "[]", "reg-upload/llm-1", ts))
    con.commit()


def load_structure(job: Job, items: list[dict], prof: dict) -> None:
    """Sections, clauses, obligations, requirements and CRI rows for one slice (idempotent)."""
    con, ts = job.con, now()
    ar = con.execute("SELECT id, verdict, reason FROM applicability_results WHERE regulation_id=? AND company_id=? "
                     "AND scope_type='COMPANY'", (job.reg, COMPANY)).fetchone()
    for it in items:
        sec_id = f"{job.prefix}-s-{slug(it['unit'])[:60] or 'general'}"
        con.execute("INSERT INTO sections (id,regulation_id,section_number,section_title,section_text,chars) "
                    "VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
                    (sec_id, job.reg, it["unit"], it["h"] or it["unit"], it["t"], len(it["t"])))
        base = it["base"]
        rq_id, ob_id, cri_id = f"{base}-r", f"{base}-obl", f"cri-{base}-r-{COMPANY}"
        con.execute("INSERT INTO clauses (id,section_id,clause_number,clause_text,page_number,regulation_id,clause_path,depth) "
                    "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
                    (base, sec_id, it["sec"] or it["unit"], it["t"], it["page"], job.reg, it["sec"] or it["unit"], 1))
        con.execute(
            """INSERT INTO obligations (id,regulation_id,section_id,clause_id,title,description,obligation_type,
                 mandatory_action,responsible_entity,frequency,applicability,evidence_required,source_reference,
                 confidence,extraction_method,kind,actor,source_excerpt,page_number,extracted_at,review_status,modality)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING""",
            (ob_id, job.reg, sec_id, base, f"{it['sec']} {it['ob']}".strip()[:400], it["ob"], "OPERATIONAL", "shall",
             it["who"] or "Hospital", it["freq"], "Applies" if it["ap"] else f"Not applicable: {it['na']}",
             it["rq"], f"{it['sec'] or it['unit']} (page {it['page']})", 0.75, "reg-upload/llm-1", "DUTY",
             it["who"], it["t"], it["page"], ts, "UNREVIEWED", "shall"))
        con.execute(
            """INSERT INTO requirements (id,obligation_id,regulation_id,statement,expected_action,frequency,
                 responsible_role,test_method,source_clause,source_excerpt,page_number,confidence,derivation_method,
                 review_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING""",
            (rq_id, ob_id, job.reg, it["rq"] or it["ob"], it["ob"], it["freq"], it["who"],
             "Document review: policies, SOPs, forms and control register", it["sec"] or it["unit"], it["t"],
             it["page"], 0.75, "reg-upload/llm-1", "UNREVIEWED", ts))
        st = "NOT_APPLICABLE" if not it["ap"] else "NOT_ASSESSED"
        con.execute(
            """INSERT INTO company_requirement_instances (id,requirement_id,company_id,applicability_result_id,
                 compliance_status,compliance_reason,compliance_computed_at,applicability_reason,fact_class,
                 review_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING""",
            (cri_id, rq_id, COMPANY, ar["id"] if ar else None, st,
             f"Not applicable: {it['na']}" if not it["ap"] else "Awaiting document review.", ts,
             ar["reason"] if ar else None, "COMPANY_ASSESSMENT", "UNREVIEWED", ts, ts))
        if not it["ap"]:
            write_gap_row(job, it, {"st": "NOT_APPLICABLE", "rk": "None", "by": [], "gap": "", "fix": "",
                                    "why": it["na"]})
    con.commit()


def write_gap_row(job: Job, it: dict, v: dict) -> None:
    con = job.con
    con.execute(
        """INSERT INTO gap_assessments (requirement_id,regulation_id,unit_group,unit_code,unit_title,item_code,
             requirement_text,category,status,risk,obligation,testable_requirement,responsible,frequency,covered_by,
             gap,fix,consequence,sub_requirements,interpretation,source_page,position,assessed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (requirement_id) DO UPDATE SET status=EXCLUDED.status, risk=EXCLUDED.risk,
             covered_by=EXCLUDED.covered_by, gap=EXCLUDED.gap, fix=EXCLUDED.fix, consequence=EXCLUDED.consequence,
             assessed_at=EXCLUDED.assessed_at""",
        (f"{it['base']}-r", job.reg, job.row["title"] or "Uploaded", it["unit"], it["h"], it["sec"] or it["unit"],
         it["t"], it["sev"], v["st"], v["rk"], it["ob"], it["rq"], it["who"], it["freq"], json.dumps(v["by"]),
         v["gap"], v["fix"], v["why"], "[]", "", it["page"], 100000 + it["n"], now()))


def load_verdicts(job: Job, pairs: list[tuple[dict, dict]], d2c: dict, known_controls: set) -> None:
    con, ts = job.con, now()
    for it, v in pairs:
        rq_id = f"{it['base']}-r"
        cri_id = f"cri-{rq_id}-{COMPANY}"
        st = v["st"]
        covered = ", ".join(v["by"]) or "—"
        reason = (f"[{v['rk']} risk] {st.replace('_', ' ')}" + (f": {v['gap']}" if v["gap"] else ": covered by the hospital's documents.")
                  + (f" Fix: {v['fix']}" if v["fix"] else "") + f" Covered by: {covered}.")
        con.execute("UPDATE company_requirement_instances SET compliance_status=?, compliance_reason=?, "
                    "compliance_computed_at=?, updated_at=? WHERE id=?", (STATUS[st], reason, ts, ts, cri_id))
        ctls = sorted({x for code in v["by"] for x in d2c.get(code, set()) if x in known_controls})
        con.execute("DELETE FROM control_requirements WHERE requirement_id=? AND mapped_by='reg_upload'", (rq_id,))
        for x in ctls:
            con.execute(
                """INSERT INTO control_requirements (control_id,requirement_id,rationale,mapped_by,review_status,created_at,
                     cri_id,fact_class,relationship_type,mapping_method,confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT DO NOTHING""",
                (x, rq_id, f"{st.replace('_', ' ').lower()} via {covered}", "reg_upload", "UNREVIEWED", ts, cri_id,
                 "COMPANY_ASSESSMENT", "COVERS" if st == "MET" else "PARTIALLY_COVERS",
                 "semantic retrieval + local LLM review", 0.8 if st == "MET" else 0.6))
        aid, fid = f"asm-{it['base']}", f"fnd-{it['base']}"
        con.execute("DELETE FROM assessments WHERE id=?", (aid,))
        con.execute(
            """INSERT INTO assessments (id,cri_id,requirement_id,control_id,result,method,confidence,rationale,
                 evidence_considered,review_status,assessed_by,assessed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (aid, cri_id, rq_id, ctls[0] if ctls else None, st,
             f"Local LLM ({LLM_MODEL}) document review over semantically retrieved hospital documents", 0.7, reason,
             json.dumps(v.get("passages", [])), "UNREVIEWED", "reg_upload", ts, ts))
        con.execute("DELETE FROM findings WHERE id=?", (fid,))
        if st != "MET":
            con.execute(
                """INSERT INTO findings (id,cri_id,test_id,control_id,severity,title,description,root_cause,raised_by,
                     raised_at,status,fact_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (fid, cri_id, None, ctls[0] if ctls else None, v["rk"].upper(),
                 f"{it['sec'] or it['unit']} {st.replace('_', ' ')}: {v['gap'] or it['rq']}"[:300],
                 f"Requirement: {it['rq']} | Missing: {v['gap']} | Consequence: {v['why']} | Fix: {v['fix']}",
                 v["why"], "reg_upload", ts, "OPEN", "COMPANY_ASSESSMENT"))
        write_gap_row(job, it, v)
    con.commit()


def embed(job: Job, pages: list[str], title: str) -> int:
    from . import rag
    chunks = []
    for pno, text in enumerate(pages, 1):
        if len(text) < 80:
            continue
        head = f"{title} — page {pno}"
        for i, piece in enumerate(rag.split(text)):
            chunks.append({"source_id": f"{job.prefix}-p{pno:04d}#{i}", "title": head, "content": f"{head}\n{piece}"})
    if not chunks:
        return 0
    vecs = rag.model().encode([c["content"] for c in chunks], batch_size=32, normalize_embeddings=True,
                              show_progress_bar=False)
    pcon = rag.connect_pg()
    n = 0
    with pcon.cursor() as cur:
        cur.execute("DELETE FROM chunks WHERE source_table='upload' AND source_id LIKE %s", (job.prefix + "-p%",))
        for c, v in zip(chunks, vecs):
            cur.execute(
                """INSERT INTO chunks (corpus, source_table, source_id, regulation_id, entity_id, domain, title,
                     section_number, content, token_estimate, url, app_path, content_hash, embedding)
                   VALUES ('regulatory','upload',%s,%s,NULL,'Uploaded',%s,NULL,%s,%s,'',%s,%s,%s)
                   ON CONFLICT (source_table, source_id, content_hash) DO NOTHING""",
                (c["source_id"], job.reg, c["title"], c["content"], len(c["content"]) // 4,
                 f"/regulation/{job.reg}", rag._h(c["content"]), v))
            n += cur.rowcount
    pcon.commit()
    return n


def finish_regulation(job: Job) -> None:
    """Regulation-level impact from what the assessment found (new regulations only)."""
    con = job.con
    rows = con.execute("SELECT risk, status FROM gap_assessments WHERE requirement_id LIKE ?", (job.prefix + "-%",)).fetchall()
    unmet = [r["risk"] for r in rows if r["status"] in ("PARTIAL", "GAP", "NOT_COVERED")]
    c = {b: unmet.count(b) for b in BANDS}
    if not job.row["attach"]:
        level = next((b for b in ("Critical", "High", "Medium", "Low") if c[b]), "Low")
        score = min(100, 30 + 12 * c["Critical"] + 5 * c["High"] + 2 * c["Medium"] + c["Low"]) if unmet else 20
        con.execute("UPDATE regulations SET impact_level=?, impact_score=?, ingestion_status='MAPPED', updated_at=? WHERE id=?",
                    (level, score, now(), job.reg))
    con.commit()


# --------------------------------------------------------------------------- #
# The run                                                                       #
# --------------------------------------------------------------------------- #
def run(con, jid: str) -> None:
    job = Job(con, jid)
    src = next((p for p in job.dir.iterdir() if p.is_file() and not p.name.startswith(".")), None)
    if not src:
        raise RuntimeError("uploaded file is missing")
    job.set(status="RUNNING", stage="extract", done=0, total=0, message="Reading the document", log=f"started · {src.name}")

    ok, msg = llm_up()
    if not ok:
        raise RuntimeError(msg + " — start llama-server, then press Retry")

    # 1. text
    pages = extract_pages(job, src)
    chars = sum(len(p) for p in pages)
    job.counts.update(pages=len(pages), chars=chars)
    job.set(stage="extract", done=len(pages), total=len(pages), log=f"text: {len(pages)} pages · {chars:,} characters")
    if chars < 200:
        raise RuntimeError("no readable text in the document (even after OCR)")

    # 2. what is it, and does it apply
    job.set(stage="profile", done=0, total=1, message="Identifying the regulation and whether it applies")
    facts = describe(company_facts(con))
    prof = cached_ask(job, "profile.json", PROFILE.format(company=facts, filename=src.name,
                                                          text="\n".join(pages)[:6000]), 1500)
    prof["verdict"] = (prof.get("verdict") or "CONDITIONAL").upper().replace(" ", "_")
    if prof["verdict"] not in ("APPLICABLE", "CONDITIONAL", "NOT_APPLICABLE"):
        prof["verdict"] = "CONDITIONAL"
    if not job.row["title"]:
        job.row["title"] = prof.get("title") or src.stem
        con.execute("UPDATE reg_uploads SET title=? WHERE id=?", (job.row["title"], jid))
    ensure_regulation(job, prof)
    job.counts.update(applicability=prof["verdict"])
    job.set(done=1, log=f"{prof['verdict'].replace('_', ' ').lower()}: {prof.get('reason', '')[:160]}")

    # 3. obligations + requirements, loaded slice by slice
    sl = slices(pages)
    job.set(stage="structure", done=0, total=len(sl), message=f"Extracting obligations with {LLM_MODEL}")
    items: dict[int, list[dict]] = {}
    lock = threading.Lock()
    title = job.row["title"]
    regulator = job.row["regulator"] or prof.get("regulator") or ""

    def do_slice(ci: int):
        s = sl[ci]
        ans = cached_ask(job, f"extract/s{ci:04d}.json", EXTRACT.format(
            i=ci + 1, n=len(sl), title=title, regulator=regulator, company=facts, text=s["text"]), 4500)
        out, seen = [], set()
        for k, a in enumerate(ans.get("r") or []):
            ob = (a.get("ob") or "").strip()
            if not ob or ob.lower() in seen:
                continue
            seen.add(ob.lower())
            sev = (a.get("sev") or "Medium").strip().title()
            ap = a.get("ap") is not False and prof["verdict"] != "NOT_APPLICABLE"
            na = a.get("na") or (prof.get("reason") if prof["verdict"] == "NOT_APPLICABLE" else "") or ""
            sec, h = (a.get("sec") or "").strip()[:80], (a.get("h") or "").strip()[:200]
            out.append({"base": f"{job.prefix}-c{ci:04d}-{k:02d}", "n": ci * 100 + k, "page": s["page"],
                        "sec": sec, "h": h, "unit": unit_of(sec, h), "t": (a.get("t") or "")[:1200], "ob": ob[:1000],
                        "rq": (a.get("rq") or "")[:1000], "who": (a.get("who") or "")[:200],
                        "freq": (a.get("freq") or "")[:100], "sev": sev if sev in BANDS[1:] else "Medium",
                        "ap": ap, "na": na[:400]})
        with lock:
            items[ci] = out
            load_structure(job, out, prof)
            job.counts["requirements"] = sum(len(v) for v in items.values())
            job.counts["not_applicable"] = sum(1 for v in items.values() for i in v if not i["ap"])
            job.set(done=len(items), log=f"part {ci + 1}/{len(sl)} (p.{s['page']}): {len(out)} requirements")

    with ThreadPoolExecutor(max_workers=LLM_SLOTS) as pool:
        for f in [pool.submit(do_slice, i) for i in range(len(sl))]:
            f.result()
    allitems = [i for ci in sorted(items) for i in items[ci]]

    # 4. RAG
    job.set(stage="embed", done=0, total=len(pages), message="Embedding the text for search")
    n = embed(job, pages, title)
    job.counts["rag_chunks"] = n
    job.set(done=len(pages), log=f"RAG: {n} chunks embedded")

    # 5. gap assessment, batch by batch, written as it goes
    todo = [i for i in allitems if i["ap"]]
    batches = [todo[i:i + JUDGE_BATCH] for i in range(0, len(todo), JUDGE_BATCH)]
    job.set(stage="assess", done=0, total=len(batches), message="Checking each requirement against the hospital's documents")
    folder = company_folder()
    if not folder:
        raise RuntimeError("no company documents uploaded — nothing to assess against")
    corpus = Corpus(folder)
    from nabh6_load import doc_to_controls
    d2c = doc_to_controls(folder)
    known_controls = {r["id"] for r in con.execute("SELECT id FROM controls")}
    tally = {k: 0 for k in ("MET", "PARTIAL", "GAP", "NOT_COVERED")}
    crit = [0]
    done = [0]

    def do_batch(bi: int):
        batch = batches[bi]
        best: dict[int, tuple[dict, float]] = {}
        for it in batch:
            for d, s in corpus.top(f"{it['ob']} {it['rq']}", 5):
                if id(d) not in best or s > best[id(d)][1]:
                    best[id(d)] = (d, s)
        passages = sorted(best.values(), key=lambda x: -x[1])[:22]
        grouped, heads = {}, {}
        for d, _ in passages:
            heads[d["code"]] = f"{d['code']} | {d['kind']} | {d['title']}"
            grouped.setdefault(d["code"], []).append(d["text"][:380])
        ps = "\n".join(heads[c] + ":\n" + "\n".join(f"   - {t}" for t in ts) for c, ts in grouped.items())
        reqs = "\n".join(f"[{k + 1}] {it['sec'] or it['unit']}: {it['ob']} | Check: {it['rq']}" for k, it in enumerate(batch))
        ans = cached_ask(job, f"judge/b{bi:04d}.json", JUDGE.format(
            title=title, regulator=regulator, scope=corpus.scope, index=corpus.index, passages=ps, reqs=reqs), 3000)
        got = {}
        for a in ans.get("r") or []:
            try:
                got[int(a.get("i"))] = a
            except Exception:                                    # noqa: BLE001
                pass
        pairs = []
        for k, it in enumerate(batch):
            a = got.get(k + 1, {})
            st = (a.get("st") or "GAP").upper().replace(" ", "_")
            st = st if st in tally else "GAP"
            by = [c for c in (a.get("by") or []) if c in corpus.codes]
            pairs.append((it, {"st": st, "rk": risk_for(it["sev"], st), "by": by,
                               "gap": (a.get("gap") or "") if st != "MET" else "",
                               "fix": (a.get("fix") or "") if st != "MET" else "",
                               "why": a.get("why") or "", "passages": [d["code"] for d, _ in passages]}))
        with lock:
            load_verdicts(job, pairs, d2c, known_controls)
            for _it, v in pairs:
                tally[v["st"]] += 1
                crit[0] += v["rk"] == "Critical"
            done[0] += 1
            job.counts.update(assessed=sum(tally.values()), met=tally["MET"], partial=tally["PARTIAL"],
                              gap=tally["GAP"], not_covered=tally["NOT_COVERED"], critical=crit[0])
            job.set(done=done[0], log=f"assessed {sum(tally.values())}/{len(todo)} · " +
                    " ".join(f"{k.lower()} {v}" for k, v in tally.items()))

    with ThreadPoolExecutor(max_workers=LLM_SLOTS) as pool:
        for f in [pool.submit(do_batch, i) for i in range(len(batches))]:
            f.result()

    finish_regulation(job)
    job.set(status="DONE", stage="done", message="Done — live in Regulations, Compliance and Impact Cascade",
            finished_at=now(), log="done")


def remove(con, jid: str) -> dict:
    """Delete everything a job added (its rows all carry <regulation>-u<job> in their ids)."""
    row = con.execute("SELECT * FROM reg_uploads WHERE id=?", (jid,)).fetchone()
    if not row:
        return {}
    reg, prefix = row["regulation_id"], f"{row['regulation_id']}-u{jid}"
    like = prefix + "-%"
    req_ids = [r["id"] for r in con.execute("SELECT id FROM requirements WHERE id LIKE ?", (like,))]
    con.execute("DELETE FROM findings WHERE id LIKE ?", (f"fnd-{like}",))
    con.execute("DELETE FROM assessments WHERE requirement_id = ANY(?)", (req_ids,))
    con.execute("DELETE FROM control_requirements WHERE requirement_id = ANY(?)", (req_ids,))
    con.execute("DELETE FROM gap_assessments WHERE requirement_id LIKE ?", (like,))
    con.execute("DELETE FROM company_requirement_scopes WHERE cri_id LIKE ?", (f"cri-{like}",))
    con.execute("DELETE FROM company_requirement_instances WHERE requirement_id = ANY(?)", (req_ids,))
    con.execute("DELETE FROM requirements WHERE id = ANY(?)", (req_ids,))
    con.execute("DELETE FROM obligations WHERE id LIKE ?", (like,))
    con.execute("DELETE FROM clauses WHERE id LIKE ?", (like,))
    con.execute("DELETE FROM sections WHERE id LIKE ?", (like,))
    if not row["attach"]:
        left = con.execute("SELECT count(*) FROM obligations WHERE regulation_id=?", (reg,)).fetchone()[0]
        if not left:
            con.execute("DELETE FROM applicability_results WHERE regulation_id=?", (reg,))
            con.execute("DELETE FROM regulations WHERE id=?", (reg,))
    con.execute("DELETE FROM reg_uploads WHERE id=?", (jid,))
    con.commit()
    try:
        from . import rag
        pcon = rag.connect_pg()
        with pcon.cursor() as cur:
            cur.execute("DELETE FROM chunks WHERE source_table='upload' AND source_id LIKE %s", (prefix + "-p%",))
        pcon.commit()
    except Exception:                                            # noqa: BLE001 — RAG store optional
        pass
    import shutil
    shutil.rmtree(ROOT / jid, ignore_errors=True)
    return {"deleted": jid, "requirements": len(req_ids)}


def runner_alive() -> bool:
    ROOT.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "a+") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fh, fcntl.LOCK_UN)
            return False
        except BlockingIOError:
            return True


def kick() -> None:
    """Start the queue runner if none is running (called by the API after an upload or retry)."""
    if runner_alive():
        return
    ROOT.mkdir(parents=True, exist_ok=True)
    # Prefer the worker's own systemd unit: a child of the API process lives in
    # the API's cgroup and is killed whenever the API restarts, which left jobs
    # stuck at RUNNING. Fall back to a detached process where systemd is absent.
    try:
        r = subprocess.run(["systemctl", "start", "--no-block", "company-brain-uploads.service"],
                           capture_output=True, timeout=10)
        if r.returncode == 0:
            return
    except Exception:                                            # noqa: BLE001 — no systemd here
        pass
    subprocess.Popen([sys.executable, "-m", "regulatory_ingestion.reg_upload"], cwd=str(SCRAPER),
                     stdout=open(ROOT / "runner.log", "a"), stderr=subprocess.STDOUT, start_new_session=True,
                     env={**os.environ, "HF_HUB_OFFLINE": "1"})


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    fh = open(LOCK, "a+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("runner already active")
        return
    con = init(connect())
    # a job left RUNNING belongs to a runner that died (restart): pick it up again
    con.execute("UPDATE reg_uploads SET status='QUEUED' WHERE status='RUNNING'")
    con.commit()
    while True:
        row = con.execute("SELECT id FROM reg_uploads WHERE status='QUEUED' ORDER BY created_at LIMIT 1").fetchone()
        if not row:
            break
        jid = row["id"]
        print(f"{now()} job {jid}", flush=True)
        try:
            run(con, jid)
        except Exception as ex:                                  # noqa: BLE001 — recorded on the job
            traceback.print_exc()
            try:
                con.rollback()
            except Exception:                                    # noqa: BLE001
                pass
            Job(con, jid).set(status="FAILED", message=str(ex)[:500], finished_at=now(), log=f"failed: {str(ex)[:300]}")


if __name__ == "__main__":
    main()
