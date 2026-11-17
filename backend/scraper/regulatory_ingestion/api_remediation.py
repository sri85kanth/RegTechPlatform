"""
Remediation — turn a gap into the document that closes it.

The treatment plan says what each unmet duty needs: a register risk, a policy,
a control, or evidence. This module drafts that artefact with the local LLM
(gpt-oss-120b on the workstation), lets a person edit it, saves it as a company
record marked Draft / Pending review, and exports drafts and the plan as files.

  GET  /api/remediation/llm                       is the local model reachable
  POST /api/remediation/drafts                    start a draft  {requirement_id, kind, fresh?, questionnaire?}
  POST /api/remediation/drafts/{id}/answers       the hospital's answers → write the draft  {answers, skip?}
  GET  /api/remediation/drafts?regulation_id=…    drafts for a regulation (chip states)
  GET  /api/remediation/drafts/{id}               one draft: status, streamed text, result
  PUT  /api/remediation/drafts/{id}               save a person's edits  {draft}
  POST /api/remediation/drafts/{id}/save          create the company record from the draft
  GET  /api/remediation/drafts/{id}/download?format=docx|pdf|md
  POST /api/remediation/plan/export               the plan rows on screen → csv|xlsx|docx|pdf|md

A draft never changes a gap's status. It is a proposal: the gap closes when the
assessment is re-run against the approved document, not when a model writes one.

ASK BEFORE WRITING
------------------
A draft written from the gap alone is full of [placeholders] — the model does not
know who owns the process, which form is used, or what the hospital does today.
So a draft starts with a short questionnaire (status QUESTIONS):

  standard questions   per kind, asked at once and pre-filled from what is on
                       record (the responsible role, the forms that partly cover
                       the duty, the departments, a risk band);
  duty questions       3–6 more the local model writes for this one duty, added
                       while the person answers the standard ones.

The answers go into the drafting prompt as facts the draft must use. A person
can skip the questionnaire; the draft then keeps its placeholders.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response

from . import company_db
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/remediation", tags=["remediation"])
READ = Depends(require("read"))
WRITE = Depends(require("propose"))
# the plan export only formats rows the caller already sees, so an auditor may download its cascade's plan
AUDIT = Depends(require("audit"))

LLM_BASE = os.environ.get("LOCAL_LLM_BASE_URL", "http://172.22.64.1:8081/v1")
LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "gpt-oss-120b")
KINDS = ("policy", "risk", "control", "evidence")
FONT_DIR = "/usr/share/fonts/truetype/dejavu"

# where a saved draft lands in the company registers
DOMAIN = {
    "policy": ("policies", "Policy"),
    "risk": ("risks", "Compliance risk"),
    "control": ("controls", "Internal control"),
    "evidence": ("evidence", "Control Evidence"),
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS remediation_drafts (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  regulation_id TEXT,
  item_code TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  draft TEXT,
  partial TEXT,
  error TEXT,
  entity_id TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
)"""
_READY = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _con():
    global _READY
    con = connect()
    if not _READY:
        con.execute(_SCHEMA)
        con.execute("CREATE INDEX IF NOT EXISTS ix_rd_req ON remediation_drafts(requirement_id)")
        con.execute("CREATE INDEX IF NOT EXISTS ix_rd_reg ON remediation_drafts(regulation_id)")
        # the questionnaire asked before drafting, and the hospital's answers
        con.execute("ALTER TABLE remediation_drafts ADD COLUMN IF NOT EXISTS questions TEXT")
        con.execute("ALTER TABLE remediation_drafts ADD COLUMN IF NOT EXISTS answers TEXT")
        con.commit()
        _READY = True
    return con


def _actor(user) -> str:
    return ((user or {}).get("email") or (user or {}).get("name") or "api") if isinstance(user, dict) else "api"


def _row(r) -> dict:
    d = dict(r)
    for k in ("draft", "questions", "answers"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except Exception:                                    # noqa: BLE001
                pass
    return d


# ---------------------------------------------------------------- context

def _context(con, requirement_id: str) -> dict:
    g = con.execute("SELECT * FROM gap_assessments WHERE requirement_id=?", (requirement_id,)).fetchone()
    if not g:
        raise HTTPException(404, "no gap assessment for this requirement")
    g = dict(g)
    reg = con.execute("SELECT id, title, short_title, regulator, regulator_short FROM regulations WHERE id=?",
                      (g.get("regulation_id"),)).fetchone()
    reg = dict(reg) if reg else {}
    prof = con.execute("SELECT legal_name, entity_type, hq_state FROM company_profile LIMIT 1").fetchone()
    prof = dict(prof) if prof else {}
    covered = []
    try:
        cg = con.execute("SELECT payload FROM cascade_graph WHERE id='company'").fetchone()
        docs = json.loads(cg[0]).get("docs", {}) if cg else {}
        for code in json.loads(g.get("covered_by") or "[]"):
            d = docs.get(code) or {}
            covered.append(f"{code} — {d.get('t', '')} ({d.get('k', '')})".strip())
    except Exception:                                            # noqa: BLE001
        pass
    subs = []
    try:
        for s in json.loads(g.get("sub_requirements") or "[]")[:8]:
            subs.append(f"- {s.get('rq', '')} (evidence: {s.get('ev', '')}) — {s.get('st', '')}")
    except Exception:                                            # noqa: BLE001
        pass
    return {"g": g, "reg": reg, "prof": prof, "covered": covered, "subs": subs}


_SHAPES = {
    "policy": """{"title": "...", "owner": "...", "approved_by": "...", "effective_date": "...",
 "purpose": "...", "scope": "...",
 "definitions": [{"term": "...", "meaning": "..."}],
 "policy_statement": "...",
 "provisions": ["numbered, concrete rules the hospital will follow"],
 "responsibilities": [{"role": "...", "duty": "..."}],
 "records": ["forms / registers to be kept"],
 "monitoring": "how compliance is checked, by whom, how often",
 "review_frequency": "...", "references": ["the regulation clause and any document named above"]}""",
    "risk": """{"title": "...", "description": "...", "category": "Patient Safety|Clinical|Compliance|Staff Safety|Legal|Operational|Environmental",
 "cause": "...", "consequence": "...",
 "likelihood": "Rare|Unlikely|Possible|Likely|Almost certain", "impact": "Minor|Moderate|Major|Severe",
 "inherent_rating": "Low|Medium|High|Critical", "existing_controls": ["..."],
 "treatment_actions": [{"action": "...", "owner_role": "...", "due_in_days": 30}],
 "residual_rating": "Low|Medium|High|Critical", "risk_owner_role": "...", "target_date": "...", "key_risk_indicators": ["..."]}""",
    "control": """{"title": "...", "objective": "...", "control_type": "Preventive|Detective|Corrective",
 "nature": "Manual|Automated|Semi-automated", "frequency": "...", "owner_role": "...",
 "procedure_steps": ["step-by-step, who does what"], "evidence_required": ["records that prove the control ran"],
 "test_procedure": "how an auditor tests it", "pass_criteria": "...", "escalation": "who is told when it fails, and when",
 "related_policy": "..."}""",
    "evidence": """{"title": "...", "custodian": "...", "review_period": "...",
 "items": [{"evidence": "...", "description": "...", "form_or_record": "...", "owner_role": "...", "frequency": "...", "retention": "..."}],
 "how_to_verify": "...", "sampling": "how many records an assessor samples"}""",
}

_ASK = {
    "policy": "Write a hospital POLICY that closes this gap.",
    "risk": "Write a RISK REGISTER entry for the risk this unmet duty creates.",
    "control": "Design an internal CONTROL (a recurring check or safeguard) that makes this duty happen and proves it.",
    "evidence": "List the EVIDENCE the hospital must collect to show this duty is met.",
}


def _duty_lines(ctx: dict) -> list[str]:
    """The duty, its gap and what partly covers it — the same facts for the questions and the draft."""
    g, reg = ctx["g"], ctx["reg"]
    lines = [
        f"Regulation: {reg.get('title') or g.get('regulation_id')} ({reg.get('regulator') or reg.get('regulator_short') or ''})",
        f"Clause: {g.get('item_code') or ''} — {g.get('unit_title') or ''}",
        f"Requirement as written: {g.get('requirement_text') or ''}",
        f"Obligation: {g.get('obligation') or ''}",
        f"Testable requirement: {g.get('testable_requirement') or ''}",
        f"Responsible: {g.get('responsible') or 'not stated'}",
        f"Assessment: {g.get('status')} · risk {g.get('risk') or 'not rated'} · category {g.get('category') or '-'}",
        f"What is missing: {g.get('gap') or ''}",
        f"Suggested fix: {g.get('fix') or ''}",
        f"If not fixed: {g.get('consequence') or ''}",
    ]
    if ctx["covered"]:
        lines.append("Hospital documents that partly cover it: " + "; ".join(ctx["covered"]))
    if ctx["subs"]:
        lines.append("Guidebook sub-requirements:\n" + "\n".join(ctx["subs"]))
    return lines


def _answer_lines(questions: dict | None, answers: dict | None) -> list[str]:
    """The questionnaire as 'question → answer' facts; unanswered ones are named so the draft keeps a placeholder."""
    if not questions or not isinstance(answers, dict):
        return []
    out, missing = [], []
    for q in (questions.get("base") or []) + (questions.get("specific") or []):
        a = answers.get(q["id"])
        if isinstance(a, list):
            a = ", ".join(str(x) for x in a if str(x).strip())
        a = str(a).strip() if a is not None else ""
        (out if a else missing).append(f"- {q['q']} → {a}" if a else f"- {q['q']}")
    lines = []
    if out:
        lines += ["", "ANSWERS FROM THE HOSPITAL — facts: use them exactly, and do not write a placeholder "
                      "where an answer is given:", *out]
    if missing:
        lines += ["Not answered (write a [placeholder] for these):", *missing]
    return lines


def _prompt(kind: str, ctx: dict, questions: dict | None = None, answers: dict | None = None) -> str:
    prof = ctx["prof"]
    lines = [
        f"You are the compliance officer of {prof.get('legal_name') or 'the hospital'}, "
        f"a {prof.get('entity_type') or 'hospital'} in {prof.get('hq_state') or 'India'}, India.",
        _ASK[kind],
        "Rules: use only the facts below; where a name, number or date is unknown write a placeholder in "
        "[square brackets] for the hospital to fill; do not cite laws or clauses other than the regulation named; "
        "be specific to this duty, practical and concise. Reply with JSON only, in exactly this shape:",
        _SHAPES[kind],
        "",
        *_duty_lines(ctx),
        *_answer_lines(questions, answers),
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------- the questionnaire

QTYPES = ("text", "long", "choice", "multi", "number", "date", "person", "yesno")
_IMPACT = {"Critical": "Severe", "High": "Major", "Medium": "Moderate", "Low": "Minor"}
_LIKELY = {"NOT_COVERED": "Likely", "GAP": "Likely", "PARTIAL": "Possible", "MET": "Unlikely"}


def _q(id_: str, q: str, type_: str = "text", *, help_: str = "", options: list | None = None,
       suggested: Any = None, required: bool = False) -> dict:
    d = {"id": id_, "q": q, "type": type_, "source": "standard"}
    if help_:
        d["help"] = help_
    if options:
        d["options"] = options
    if suggested not in (None, "", []):
        d["suggested"] = suggested
    if required:
        d["required"] = True
    return d


def _departments(con) -> list[str]:
    try:
        names = [r[0] for r in con.execute(
            "SELECT DISTINCT name FROM org_nodes WHERE kind='Department' AND name <> 'Hospital-wide' ORDER BY name")]
    except Exception:                                            # noqa: BLE001
        names = []
    return ["Hospital-wide", *names]


def _base_questions(con, kind: str, ctx: dict) -> list[dict]:
    """The questions every draft of this kind needs, pre-filled from what is already on record."""
    g = ctx["g"]
    who = g.get("responsible") or ""
    forms = [c for c in ctx["covered"] if "(Form)" in c]
    covered = "; ".join(ctx["covered"])
    freq = next((s.get("freq") for s in _subs(g) if s.get("freq")), "")
    depts = _departments(con)
    if kind == "policy":
        return [
            _q("owner", "Who owns this policy and keeps it up to date?", "person", suggested=who, required=True,
               help_="A named person, or the role if the person is not decided yet."),
            _q("approver", "Who approves it?", "choice", suggested="Medical Superintendent",
               options=["Medical Superintendent", "Medical Director", "CEO", "Quality Committee", "Nursing Superintendent"]),
            _q("scope", "Which departments or units does it apply to?", "multi", options=depts, suggested=["Hospital-wide"]),
            _q("practice", "What is done today, even if it is not written down?", "long",
               help_=f"Partly covered by: {covered}" if covered else "Leave blank if nothing is done yet."),
            _q("records", "Which forms or registers record it? Give their codes.", "text",
               suggested="; ".join(forms), help_="Existing or planned, e.g. NUR-F-12 Fall Risk Assessment Form."),
            _q("timelines", "Which time limits or numbers must the policy state?", "text",
               help_="e.g. within 24 hours of admission; audit 10 records a month."),
            _q("review", "How often is the policy reviewed?", "choice", suggested="Annually",
               options=["Annually", "Every 2 years", "Every 3 years"]),
            _q("effective", "From what date does it apply?", "date"),
        ]
    if kind == "risk":
        return [
            _q("owner", "Who owns this risk?", "person", suggested=who, required=True),
            _q("controls", "What already reduces this risk today?", "long",
               help_=f"On record: {covered}" if covered else "Checks, training, forms or equipment already in place."),
            _q("history", "Has it happened in the last 12 months?", "choice",
               options=["Never", "Once", "A few times", "Often", "Not known"], suggested="Not known"),
            _q("likelihood", "How likely is it, as things stand?", "choice",
               options=["Rare", "Unlikely", "Possible", "Likely", "Almost certain"], suggested=_LIKELY.get(g.get("status"), "Possible")),
            _q("impact", "How bad would it be?", "choice",
               options=["Minor", "Moderate", "Major", "Severe"], suggested=_IMPACT.get(g.get("risk") or "", "Major")),
            _q("target", "By when should the treatment be done?", "date"),
        ]
    if kind == "control":
        return [
            _q("owner", "Who owns the control?", "person", suggested=who, required=True),
            _q("performer", "Who carries out the check?", "text", suggested=who),
            _q("frequency", "How often is it done?", "choice", suggested=freq or "Monthly",
               options=["Each case", "Daily", "Weekly", "Monthly", "Quarterly", "Annually"]),
            _q("sample", "How many records or cases are checked each time?", "number", suggested=10),
            _q("system", "Where is it recorded?", "choice", options=["Paper register", "HIS / EMR", "Excel tracker", "Other"]),
            _q("record", "Which form or register shows it was done? Give its code.", "text", suggested="; ".join(forms)),
            _q("escalation", "Who is told when the check fails, and within how long?", "text"),
        ]
    return [                                                     # evidence
        _q("custodian", "Who keeps these records?", "person", suggested=who, required=True),
        _q("sources", "Where does the evidence come from?", "multi",
           options=["Patient case files", "HIS / EMR", "Registers", "Excel trackers", "Committee minutes", "Training records", "Photographs"]),
        _q("existing", "Which of these records exist today?", "long",
           help_=f"On record: {covered}" if covered else "Name them, with form or register codes."),
        _q("period", "Over what period will an assessor look?", "choice", suggested="Last 3 months",
           options=["Last 3 months", "Last 6 months", "Last 12 months"]),
        _q("sample", "How many records should a sample check?", "number", suggested=30,
           help_="NABH does not fix a number; 30, or all records if there are fewer, is a common default."),
        _q("retention", "How long are the records kept?", "text"),
    ]


def _subs(g: dict) -> list[dict]:
    try:
        return [s for s in json.loads(g.get("sub_requirements") or "[]") if isinstance(s, dict)]
    except Exception:                                            # noqa: BLE001
        return []


def _ask_prompt(kind: str, ctx: dict, base: list[dict]) -> str:
    prof = ctx["prof"]
    noun = {"policy": "policy", "risk": "risk-register entry", "control": "internal control", "evidence": "evidence list"}[kind]
    return "\n".join([
        f"You are the compliance officer of {prof.get('legal_name') or 'the hospital'}, India. "
        f"You will draft a {noun} that closes the gap below.",
        f"Before drafting, list the 3 to 6 questions you must ask the hospital so the {noun} states its real "
        "practice instead of placeholders: who does what, which forms or equipment, time limits, numbers, exceptions.",
        "Do not ask anything stated below, and do not repeat these questions, which are already asked:",
        *[f"- {q['q']}" for q in base],
        "Ask short, concrete questions a department head can answer in one line. Where the answer is one of a few "
        "choices, give 2 to 5 options. Reply with JSON only:",
        '{"questions": [{"q": "...", "why": "what the answer changes in the draft", '
        '"type": "text|choice|multi|number|yesno", "options": ["..."], "suggested": "..."}]}',
        "",
        *_duty_lines(ctx),
    ])


def _clean_questions(raw: Any) -> list[dict]:
    """The model's questions, made safe to render: known types, short text, at most six."""
    out = []
    items = raw.get("questions") if isinstance(raw, dict) else raw
    for i, q in enumerate(items if isinstance(items, list) else []):
        if not isinstance(q, dict) or not str(q.get("q") or "").strip():
            continue
        t = str(q.get("type") or "text").lower()
        t = t if t in QTYPES else "text"
        opts = [str(o)[:120] for o in (q.get("options") or []) if str(o).strip()][:8]
        if t in ("choice", "multi") and len(opts) < 2:
            t = "text"
        d = {"id": f"ai{i + 1}", "q": str(q["q"]).strip()[:300], "type": t, "source": "ai"}
        if q.get("why"):
            d["help"] = str(q["why"]).strip()[:300]
        if opts and t in ("choice", "multi"):
            d["options"] = opts
        if t == "yesno":
            d["type"], d["options"] = "choice", ["Yes", "No", "Not sure"]
        sug = q.get("suggested")
        if sug not in (None, "", []):
            d["suggested"] = sug if isinstance(sug, (list, int, float)) else str(sug)[:200]
        out.append(d)
        if len(out) == 6:
            break
    return out


_DASHES = str.maketrans({"‐": "-", "‑": "-", "‒": "-", " ": " ", " ": " ", " ": " "})


def _tidy(v: Any) -> Any:
    """The model writes non-breaking hyphens and spaces ("ANS‑F‑01"); a form code must read as typed."""
    if isinstance(v, str):
        return v.translate(_DASHES)
    if isinstance(v, list):
        return [_tidy(x) for x in v]
    if isinstance(v, dict):
        return {k: _tidy(x) for k, x in v.items()}
    return v


def _ask(id_: str, prompt: str) -> None:
    """The model writes the duty-specific questions; the standard ones are already on screen."""
    con = connect()
    body = {"model": LLM_MODEL, "temperature": 0.2, "max_tokens": 1500,
            "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"reasoning_effort": "low"},
            "messages": [{"role": "user", "content": prompt}]}
    try:
        r = httpx.post(f"{LLM_BASE}/chat/completions", json=body, timeout=httpx.Timeout(600, connect=10))
        r.raise_for_status()
        text = r.json()["choices"][0]["message"].get("content") or ""
        specific = _clean_questions(_tidy(json.loads(text[text.find("{"): text.rfind("}") + 1])))
        status, note = ("READY", "") if specific else ("FAILED", "The AI did not add questions for this duty.")
    except (httpx.TransportError, OSError) as ex:
        specific, status, note = [], "FAILED", f"The local AI is not reachable ({type(ex).__name__}); only the standard questions are asked."
    except Exception as ex:                                      # noqa: BLE001
        specific, status, note = [], "FAILED", f"The AI's questions could not be read ({type(ex).__name__})."
    row = con.execute("SELECT questions FROM remediation_drafts WHERE id=?", (id_,)).fetchone()
    q = json.loads(row[0]) if row and row[0] else {"base": []}
    q.update({"specific": specific, "specific_status": status, "note": note})
    _set(id_, questions=json.dumps(q, ensure_ascii=False),
         message="Answer the questions, then draft" if status == "READY" else "Answer the standard questions, then draft")


# ---------------------------------------------------------------- the LLM job

def _set(id_: str, **cols):
    con = connect()
    cols["updated_at"] = _now()
    con.execute(f"UPDATE remediation_drafts SET {', '.join(f'{k}=?' for k in cols)} WHERE id=?", (*cols.values(), id_))
    con.commit()


def _run(id_: str, prompt: str) -> None:
    body = {"model": LLM_MODEL, "temperature": 0.2, "max_tokens": 3000, "stream": True,
            "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"reasoning_effort": "low"},
            "messages": [{"role": "user", "content": prompt}]}
    deadline = time.time() + 600
    while True:                                   # wait out a model that is still loading
        try:
            parts: list[str] = []
            thinking = 0
            last = 0.0
            _set(id_, status="RUNNING", message="Local AI is reading the gap…")
            with httpx.stream("POST", f"{LLM_BASE}/chat/completions", json=body,
                              timeout=httpx.Timeout(1800, connect=10)) as r:
                if r.status_code in (502, 503, 504):
                    raise httpx.TransportError(f"model not ready ({r.status_code})")
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0].get("delta") or {}
                    except Exception:                    # noqa: BLE001
                        continue
                    if delta.get("content"):
                        parts.append(delta["content"])
                    if delta.get("reasoning_content"):
                        thinking += 1
                    if time.time() - last > 1.5:
                        last = time.time()
                        _set(id_, partial="".join(parts),
                             message=("Writing the draft…" if parts else f"Thinking… ({thinking} steps)"))
            text = "".join(parts)
            draft = _tidy(json.loads(text[text.find("{"): text.rfind("}") + 1]))
            _set(id_, status="READY", draft=json.dumps(draft, ensure_ascii=False), partial=text,
                 message="Draft ready — review and edit before saving")
            return
        except (httpx.TransportError, OSError) as ex:
            if time.time() > deadline:
                _set(id_, status="FAILED", error=f"Local AI not reachable at {LLM_BASE}: {ex}",
                     message="The local AI model is not running")
                return
            _set(id_, status="QUEUED", message="Waiting for the local AI model to load…")
            time.sleep(10)
        except Exception as ex:                          # noqa: BLE001 — unparseable answer
            _set(id_, status="FAILED", error=f"{type(ex).__name__}: {ex}", message="The AI answer could not be read — try again")
            return


def _llm_up() -> tuple[bool, str]:
    try:
        httpx.get(f"{LLM_BASE}/models", timeout=4).raise_for_status()
        return True, f"{LLM_MODEL} (local)"
    except Exception as ex:                              # noqa: BLE001
        return False, f"local AI not reachable ({type(ex).__name__})"


@router.get("/llm", dependencies=[READ])
def llm_status():
    ok, msg = _llm_up()
    return {"ok": ok, "message": msg, "model": LLM_MODEL}


@router.post("/drafts")
def start_draft(payload: dict[str, Any] = Body(...), user=WRITE):
    rid = str(payload.get("requirement_id") or "").strip()
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(KINDS)}")
    con = _con()
    if not payload.get("fresh"):
        ex = con.execute("""SELECT * FROM remediation_drafts WHERE requirement_id=? AND kind=?
                             AND status IN ('QUESTIONS','QUEUED','RUNNING','READY','SAVED') ORDER BY created_at DESC LIMIT 1""",
                         (rid, kind)).fetchone()
        if ex:
            return _row(ex)
    ctx = _context(con, rid)
    ok, msg = _llm_up()
    id_ = "rd-" + secrets.token_hex(5)
    ask = payload.get("questionnaire", True) is not False
    if ask:
        # ask before writing: the standard questions now, the duty's own questions when the model has them
        base = _base_questions(con, kind, ctx)
        questions = {"base": base, "specific": [], "specific_status": "PENDING" if ok else "FAILED",
                     "note": "" if ok else "The local AI is not reachable; only the standard questions are asked."}
        con.execute("""INSERT INTO remediation_drafts (id, requirement_id, regulation_id, item_code, kind, status, message,
                       questions, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (id_, rid, ctx["g"].get("regulation_id"), ctx["g"].get("item_code"), kind, "QUESTIONS",
                     "The AI is adding questions for this duty…" if ok else "Answer the standard questions, then draft",
                     json.dumps(questions, ensure_ascii=False), _actor(user), _now(), _now()))
        con.commit()
        if ok:
            threading.Thread(target=_ask, args=(id_, _ask_prompt(kind, ctx, base)), daemon=True).start()
        return _row(con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone())
    con.execute("""INSERT INTO remediation_drafts (id, requirement_id, regulation_id, item_code, kind, status, message,
                   created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (id_, rid, ctx["g"].get("regulation_id"), ctx["g"].get("item_code"), kind, "QUEUED",
                 "Starting…" if ok else "Waiting for the local AI model to load…", _actor(user), _now(), _now()))
    con.commit()
    threading.Thread(target=_run, args=(id_, _prompt(kind, ctx)), daemon=True).start()
    return _row(con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone())


@router.post("/drafts/{id_}/answers")
def submit_answers(id_: str, payload: dict[str, Any] = Body(...), user=WRITE):
    """The hospital's answers (or skip) → the model writes the draft with them as facts."""
    con = _con()
    r = con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone()
    if not r:
        raise HTTPException(404, "draft not found")
    d = _row(r)
    if d["status"] in ("QUEUED", "RUNNING"):
        raise HTTPException(409, "the draft is already being written")
    questions = d.get("questions") if isinstance(d.get("questions"), dict) else None
    answers = {} if payload.get("skip") else payload.get("answers")
    if not isinstance(answers, dict):
        raise HTTPException(400, "answers must be an object of question id → answer")
    known = {q["id"]: q for q in ((questions or {}).get("base") or []) + ((questions or {}).get("specific") or [])}
    clip = lambda v: [str(x)[:300] for x in v][:50] if isinstance(v, list) else str(v)[:2000]  # noqa: E731
    answers = {k: clip(v) for k, v in answers.items() if k in known and v not in (None, "", [])}
    missing = [q["q"] for q in known.values() if q.get("required") and q["id"] not in answers and not payload.get("skip")]
    if missing:
        raise HTTPException(400, "please answer: " + "; ".join(missing))
    ctx = _context(con, d["requirement_id"])
    ok, _ = _llm_up()
    _set(id_, answers=json.dumps(answers, ensure_ascii=False), status="QUEUED", error=None, partial=None,
         message="Starting…" if ok else "Waiting for the local AI model to load…")
    company_db.log(con, id_, "remediation questionnaire answered" if answers else "remediation questionnaire skipped",
                   f"{len(answers)} of {len(known)} questions answered", _actor(user))
    con.commit()
    threading.Thread(target=_run, args=(id_, _prompt(d["kind"], ctx, questions, answers)), daemon=True).start()
    return _row(con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone())


def _expire(con) -> None:
    """A job whose worker died (API restart) would sit at RUNNING for ever."""
    cutoff = datetime.fromtimestamp(time.time() - 900, timezone.utc).isoformat(timespec="seconds")
    con.execute("""UPDATE remediation_drafts SET status='FAILED', message='Interrupted — start it again',
                   error='worker stopped' WHERE status IN ('QUEUED','RUNNING') AND updated_at < ?""", (cutoff,))
    # the same for the duty questions: the standard ones stay answerable
    for r in con.execute("""SELECT id, questions FROM remediation_drafts WHERE status='QUESTIONS'
                             AND updated_at < ? AND questions LIKE '%"specific_status": "PENDING"%'""", (cutoff,)).fetchall():
        q = json.loads(r[1])
        q.update({"specific_status": "FAILED", "note": "The AI's questions were interrupted; answer the standard ones."})
        con.execute("UPDATE remediation_drafts SET questions=? WHERE id=?", (json.dumps(q, ensure_ascii=False), r[0]))
    con.commit()


@router.get("/drafts", dependencies=[READ])
def list_drafts(regulation_id: str | None = None, requirement_id: str | None = None):
    con = _con()
    _expire(con)
    where, p = [], []
    if regulation_id:
        where.append("regulation_id=?"); p.append(regulation_id)
    if requirement_id:
        where.append("requirement_id=?"); p.append(requirement_id)
    sql = ("SELECT id, requirement_id, regulation_id, item_code, kind, status, message, entity_id, created_by, "
           "created_at, updated_at FROM remediation_drafts")
    if where:
        sql += " WHERE " + " AND ".join(where)
    return {"items": [dict(r) for r in con.execute(sql + " ORDER BY created_at DESC LIMIT 2000", p).fetchall()]}


@router.get("/drafts/{id_}", dependencies=[READ])
def get_draft(id_: str):
    con = _con()
    _expire(con)
    r = con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone()
    if not r:
        raise HTTPException(404, "draft not found")
    return _row(r)


@router.put("/drafts/{id_}")
def edit_draft(id_: str, payload: dict[str, Any] = Body(...), user=WRITE):
    draft = payload.get("draft")
    if not isinstance(draft, dict):
        raise HTTPException(400, "draft must be an object")
    con = _con()
    r = con.execute("SELECT status FROM remediation_drafts WHERE id=?", (id_,)).fetchone()
    if not r:
        raise HTTPException(404, "draft not found")
    con.execute("UPDATE remediation_drafts SET draft=?, updated_at=? WHERE id=?",
                (json.dumps(draft, ensure_ascii=False), _now(), id_))
    company_db.log(con, id_, "remediation draft edited", "", _actor(user))
    con.commit()
    return _row(con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone())


def _flat(v) -> str:
    if isinstance(v, list):
        return "\n".join("• " + _item(i) for i in v)
    if isinstance(v, dict):
        return "; ".join(f"{k}: {x}" for k, x in v.items())
    return "" if v is None else str(v)


@router.post("/drafts/{id_}/save")
def save_draft(id_: str, user=WRITE):
    con = _con()
    r = con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone()
    if not r:
        raise HTTPException(404, "draft not found")
    d = _row(r)
    if d["status"] not in ("READY", "SAVED") or not isinstance(d.get("draft"), dict):
        raise HTTPException(409, "the draft is not ready")
    draft = d["draft"]
    domain, etype = DOMAIN[d["kind"]]
    g = con.execute("SELECT risk FROM gap_assessments WHERE requirement_id=?", (d["requirement_id"],)).fetchone()
    crit = draft.get("inherent_rating") if d["kind"] == "risk" else (g[0] if g else None)
    eid = d.get("entity_id") or f"ai-{d['kind']}-{secrets.token_hex(4)}"
    attrs = {k: _flat(v) for k, v in draft.items() if k != "title"}
    attrs.update({"requirementId": d["requirement_id"], "regulationId": d["regulation_id"],
                  "clause": d["item_code"], "draftId": id_,
                  "origin": f"AI draft ({LLM_MODEL}, local) — needs human review"})
    company_db.upsert_entity(con, {
        "id": eid, "domain": domain, "type": etype,
        "name": str(draft.get("title") or f"{d['kind'].title()} for {d['item_code']}")[:300],
        "description": str(draft.get("purpose") or draft.get("description") or draft.get("objective")
                           or draft.get("how_to_verify") or "")[:2000],
        "criticality": crit if crit in ("Critical", "High", "Medium", "Low") else None,
        "lifecycle": "Draft", "status": "Draft", "verification": "Pending",
        "attrs": attrs, "source": "AI draft", "source_reference": f"{d['regulation_id']} {d['item_code']}",
    }, actor=_actor(user))
    con.execute("UPDATE remediation_drafts SET status='SAVED', entity_id=?, message=?, updated_at=? WHERE id=?",
                (eid, f"Saved to {domain} as a draft record", _now(), id_))
    con.commit()
    return {"entity_id": eid, "domain": domain}


# ---------------------------------------------------------------- files

def _doc_sections(d: dict) -> tuple[str, list[str], list[tuple[str, Any]]]:
    draft = d.get("draft") or {}
    title = str(draft.get("title") or f"{d['kind'].title()} draft")
    meta = [f"Regulation: {d.get('regulation_id') or ''}   Clause: {d.get('item_code') or ''}",
            f"Kind: {d['kind'].title()}   Status: {d['status']}   Generated: {d.get('updated_at', '')[:16].replace('T', ' ')}",
            f"DRAFT written by the local AI ({LLM_MODEL}) — review and approve before use."]
    secs = [(k.replace("_", " ").capitalize(), v) for k, v in draft.items() if k != "title" and v not in (None, "", [])]
    return title, meta, secs


def _item(x) -> str:
    """One list entry. A dict reads as its values ("PAC — Pre-anaesthesia check-up"),
    with numbers labelled ("due in 30 days") — "term: … meaning: …" is noise."""
    if not isinstance(x, dict):
        return re.sub(r"^\s*(\d+[.)]|[-•*])\s+", "", str(x))
    vals = []
    for k, y in x.items():
        if y in (None, ""):
            continue
        if isinstance(y, (int, float)) or k.endswith(("_days", "_in_days")):
            vals.append(f"{k.replace('_', ' ')} {y}")
        else:
            vals.append(str(y))
    return " — ".join(vals)


def _lines(v) -> list[str]:
    if isinstance(v, list):
        return [f"{i}. {_item(x)}" for i, x in enumerate(v, 1)]
    if isinstance(v, dict):
        return [f"{k.replace('_', ' ')}: {y}" for k, y in v.items()]
    return [str(v)]


def _md(title, meta, secs) -> bytes:
    out = [f"# {title}", "", *[f"_{m}_  " for m in meta], ""]
    for h, v in secs:
        out += [f"## {h}", "", *_lines(v), ""]
    return "\n".join(out).encode()


def _docx(title, meta, secs, table: tuple[list[str], list[list[str]]] | None = None) -> bytes:
    from docx import Document
    from docx.shared import Pt, RGBColor
    doc = Document()
    doc.styles["Normal"].font.name = "Calibri"
    doc.styles["Normal"].font.size = Pt(10.5)
    doc.add_heading(title, level=1)
    for m in meta:
        p = doc.add_paragraph(m)
        p.runs[0].italic = True
        p.runs[0].font.color.rgb = RGBColor(0x52, 0x60, 0x77)
    for h, v in secs:
        doc.add_heading(h, level=2)
        for ln in _lines(v):
            doc.add_paragraph(ln)
    if table:
        head, rows = table
        t = doc.add_table(rows=1, cols=len(head))
        t.style = "Light Grid Accent 1"
        for i, h in enumerate(head):
            t.rows[0].cells[i].text = h
        for r in rows:
            cells = t.add_row().cells
            for i, v in enumerate(r):
                cells[i].text = str(v)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _pdf(title, meta, secs, table: tuple[list[str], list[list[str]]] | None = None, landscape=False) -> bytes:
    from fpdf import FPDF
    pdf = FPDF(orientation="L" if landscape else "P", format="A4")
    pdf.set_auto_page_break(True, margin=14)
    try:
        pdf.add_font("DejaVu", "", f"{FONT_DIR}/DejaVuSans.ttf")
        pdf.add_font("DejaVu", "B", f"{FONT_DIR}/DejaVuSans-Bold.ttf")
        fam = "DejaVu"
    except Exception:                                    # noqa: BLE001 — no unicode font on this box
        fam = "Helvetica"
    clean = (lambda s: s) if fam == "DejaVu" else (lambda s: str(s).encode("latin-1", "replace").decode("latin-1"))
    pdf.add_page()
    pdf.set_font(fam, "B", 16)
    pdf.multi_cell(0, 8, clean(title), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(fam, "", 8.5)
    pdf.set_text_color(82, 96, 119)
    for m in meta:
        pdf.multi_cell(0, 5, clean(m), new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(15, 23, 42)
    for h, v in secs:
        pdf.ln(3)
        pdf.set_font(fam, "B", 11.5)
        pdf.multi_cell(0, 6, clean(h), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font(fam, "", 10)
        for ln in _lines(v):
            pdf.multi_cell(0, 5.2, clean(ln), new_x="LMARGIN", new_y="NEXT")
    if table:
        head, rows = table
        pdf.ln(3)
        pdf.set_font(fam, "", 7.5)
        weight = {"Code": 9, "Status": 9, "Risk": 7, "Requirement": 30, "Gap — what is missing": 24, "Fix": 24,
                  "If not fixed": 18, "Actions needed": 14, "Owner": 13, "Controls": 13, "Documents": 13}
        with pdf.table(text_align="LEFT", line_height=4, col_widths=tuple(weight.get(h, 12) for h in head)) as t:
            hr = t.row()
            for h in head:
                hr.cell(clean(h))
            for r in rows:
                rr = t.row()
                for v in r:
                    rr.cell(clean(str(v))[:600])
    return bytes(pdf.output())


_MIME = {
    "md": "text/markdown; charset=utf-8", "csv": "text/csv; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pdf": "application/pdf",
}


def _file(data: bytes, name: str, fmt: str) -> Response:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-")[:90] or "export"
    return Response(content=data, media_type=_MIME[fmt],
                    headers={"Content-Disposition": f'attachment; filename="{safe}.{fmt}"'})


@router.get("/drafts/{id_}/download", dependencies=[READ])
def download_draft(id_: str, format: str = Query("docx", pattern="^(docx|pdf|md)$")):
    con = _con()
    r = con.execute("SELECT * FROM remediation_drafts WHERE id=?", (id_,)).fetchone()
    if not r:
        raise HTTPException(404, "draft not found")
    d = _row(r)
    if not isinstance(d.get("draft"), dict):
        raise HTTPException(409, "the draft is not ready")
    title, meta, secs = _doc_sections(d)
    data = {"md": _md, "docx": _docx, "pdf": _pdf}[format](title, meta, secs)
    return _file(data, f"{d['item_code'] or d['requirement_id']}-{d['kind']}-draft", format)


PLAN_COLS = [("code", "Code"), ("status", "Status"), ("risk", "Risk"), ("requirement", "Requirement"),
             ("gap", "Gap — what is missing"), ("fix", "Fix"), ("consequence", "If not fixed"),
             ("actions", "Actions needed"), ("owner", "Owner"), ("controls", "Controls"), ("documents", "Documents")]


@router.post("/plan/export", dependencies=[AUDIT])
def export_plan(payload: dict[str, Any] = Body(...)):
    """The treatment plan exactly as filtered on screen — the client sends its rows."""
    fmt = str(payload.get("format") or "xlsx").lower()
    if fmt not in ("csv", "xlsx", "docx", "pdf", "md"):
        raise HTTPException(400, "format must be csv, xlsx, docx, pdf or md")
    rows = payload.get("rows") or []
    if not isinstance(rows, list) or len(rows) > 20000:
        raise HTTPException(400, "rows must be a list (max 20,000)")
    title = str(payload.get("title") or "Risk-treatment plan")
    meta = [str(m) for m in (payload.get("meta") or [])][:8]
    meta.append(f"Exported {datetime.now().strftime('%d %b %Y %H:%M')} from Company Brain")
    cols = [c for c in PLAN_COLS if any(str(r.get(c[0]) or "").strip() for r in rows)] or PLAN_COLS[:4]
    head = [c[1] for c in cols]
    body = [[_cell(r.get(k)) for k, _ in cols] for r in rows]
    name = re.sub(r"\s+", "-", title.lower())

    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(head)
        w.writerows(body)
        return _file(("﻿" + buf.getvalue()).encode("utf-8"), name, "csv")
    if fmt == "xlsx":
        return _file(_xlsx(title, meta, head, body), name, "xlsx")
    if fmt == "md":
        md = [f"# {title}", "", *[f"_{m}_  " for m in meta], "", "| " + " | ".join(head) + " |",
              "|" + "---|" * len(head)]
        md += ["| " + " | ".join(v.replace("|", "/").replace("\n", " ") for v in r) + " |" for r in body]
        return _file("\n".join(md).encode(), name, "md")
    if fmt == "docx":
        return _file(_docx(title, meta, [], (head, body)), name, "docx")
    return _file(_pdf(title, meta, [], (head, body), landscape=True), name, "pdf")


def _cell(v) -> str:
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return "" if v is None else str(v)


def _xlsx(title, meta, head, body) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    ws = wb.active
    ws.title = "Treatment plan"
    ws.append([title])
    ws["A1"].font = Font(bold=True, size=14)
    for m in meta:
        ws.append([m])
    ws.append([])
    hr = ws.max_row + 1
    ws.append(head)
    for c in ws[hr]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="2563EB")
        c.alignment = Alignment(vertical="center", wrap_text=True)
    fills = {"gap": "FEE2E2", "partial": "FEF3C7", "not covered": "FFEDD5", "met": "DCFCE7", "documented": "DCFCE7",
             "critical": "FECACA", "high": "FED7AA", "medium": "FDE68A", "low": "E2E8F0"}
    for r in body:
        ws.append(r)
        for c in ws[ws.max_row]:
            c.alignment = Alignment(vertical="top", wrap_text=True)
            f = fills.get(str(c.value).strip().lower())
            if f:
                c.fill = PatternFill("solid", fgColor=f)
    widths = {"Code": 12, "Status": 13, "Risk": 10, "Requirement": 60, "Gap — what is missing": 45, "Fix": 45,
              "If not fixed": 35, "Actions needed": 26, "Owner": 22, "Controls": 22, "Documents": 22}
    for i, h in enumerate(head, 1):
        ws.column_dimensions[ws.cell(row=hr, column=i).column_letter].width = widths.get(h, 18)
    ws.freeze_panes = ws.cell(row=hr + 1, column=1)
    ws.auto_filter.ref = f"A{hr}:{ws.cell(row=hr, column=len(head)).column_letter}{ws.max_row}"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
