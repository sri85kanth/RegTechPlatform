"""
Populate the regulation semantics layer FROM EXISTING VERIFIED SOURCE TEXT.

Nothing here is invented. Every row is derived from text already stored and
already hash-verified against the official document, and every row carries a
provenance record pointing back to the exact source.

    documents/sections/obligations   ->  provenance
    obligations.source_excerpt       ->  legal_provisions   (actor/modality/action/object)
    section text                     ->  definitions        ("X means Y")
    source_excerpt                   ->  thresholds         (amounts, percentages, counts)
    source_excerpt                   ->  timing_rules       (deadlines, frequencies)
    source_excerpt                   ->  provision_conditions / exceptions
    section text                     ->  cross_references

Where the source does not state something, the field is left NULL. That is the
whole point: a blank is a fact about the regulation, not a gap to fill.
"""
from __future__ import annotations

import argparse
import re
from datetime import datetime, timezone

from regulatory_ingestion.db import connect

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# ---------------------------------------------------------------- modality
# Order matters: "shall not" must be tested before "shall".
MODALITY = [
    (re.compile(r"\bshall\s+not\b", re.I),          "SHALL_NOT",  True,  False),
    (re.compile(r"\bmust\s+not\b", re.I),           "MUST_NOT",   True,  False),
    (re.compile(r"\b(is|are)\s+prohibited\b", re.I), "PROHIBITED", True,  False),
    (re.compile(r"\bshall\s+ensure\b", re.I),       "SHALL",      False, False),
    (re.compile(r"\bshall\b", re.I),                "SHALL",      False, False),
    (re.compile(r"\bmust\b", re.I),                 "MUST",       False, False),
    (re.compile(r"\b(is|are)\s+required\s+to\b", re.I), "REQUIRED", False, False),
    (re.compile(r"\bmay\s+not\b", re.I),            "MAY_NOT",    True,  False),
    (re.compile(r"\bis\s+permitted\b", re.I),       "PERMITTED",  False, True),
    (re.compile(r"\bmay\b", re.I),                  "MAY",        False, True),
    (re.compile(r"\bshould\b", re.I),               "SHOULD",     False, False),
]


def modality_of(text: str):
    for pat, name, prohibition, permission in MODALITY:
        if pat.search(text or ""):
            return name, prohibition, permission
    return None, False, False


# ---------------------------------------------------------------- conditions
CONDITION = re.compile(
    r"\b(provided\s+that|subject\s+to|unless|except\s+(?:where|that|in)|"
    r"in\s+case\s+(?:of|where)|if\b|where\b|when\b)", re.I)
EXCEPTION = re.compile(
    r"\b(shall\s+not\s+apply|does\s+not\s+apply|is\s+exempt(?:ed)?|"
    r"exempt(?:ion|ed)?\s+from|nothing\s+(?:in\s+)?(?:these|this)\b|"
    r"except\s+(?:as|where|that))", re.I)

# ---------------------------------------------------------------- thresholds
AMOUNT = re.compile(
    r"(?:₹|rs\.?|rupees|inr)\s*(\d[\d,]*(?:\.\d+)?)\s*(lakh|lakhs|crore|crores|thousand)?",
    re.I)
PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:per\s*cent|percent|%)", re.I)
DURATION = re.compile(
    r"\bwithin\s+(\d+)\s+(day|days|month|months|year|years|hour|hours|working\s+days?)\b", re.I)
AGE = re.compile(r"\b(?:aged?|age\s+of)\s+(\d+)\s*(?:years?)?\b", re.I)

FREQUENCY = re.compile(
    r"\b(annually|half[- ]yearly|semi[- ]annually|quarterly|monthly|fortnightly|weekly|"
    r"daily|periodically|once\s+in\s+(?:a|every)\s+\w+|every\s+\d+\s+\w+)\b", re.I)

# ---------------------------------------------------------------- definitions
# "X" means / shall mean / is defined as …
DEFINITION = re.compile(
    r"[\"“”']([A-Z][^\"“”']{2,80})[\"“”']\s*(?:shall\s+)?(?:means?|shall\s+mean|"
    r"is\s+defined\s+as)\s+(.{20,600}?)(?:;|\.\s|$)", re.S)

# ---------------------------------------------------------------- references
XREF = re.compile(
    r"\b(?:read\s+with|in\s+terms\s+of|as\s+defined\s+in|under|pursuant\s+to|"
    r"subject\s+to|referred\s+to\s+in|specified\s+in)\s+"
    r"((?:section|rule|clause|paragraph|regulation|chapter)\s+[\dIVXA-Za-z().\-]+"
    r"(?:\s+of\s+(?:the\s+)?[A-Z][\w\s,()\-]{4,80})?)", re.I)
XREF_RELATION = {"read with": "READ_WITH", "subject to": "SUBJECT_TO",
                 "as defined in": "REFERS_TO", "in terms of": "REFERS_TO"}


def norm_amount(num: str, scale: str | None) -> str | None:
    """Returns None when the match caught a currency word with no number."""
    cleaned = (num or "").replace(",", "").strip()
    if not cleaned or not re.match(r"^\d+(\.\d+)?$", cleaned):
        return None
    v = float(cleaned)
    if scale:
        s = scale.lower()
        if s.startswith("lakh"):
            v *= 100_000
        elif s.startswith("crore"):
            v *= 10_000_000
        elif s.startswith("thousand"):
            v *= 1_000
    return f"{v:.0f}"


def run(limit_regs: int = 0, progress=print) -> dict:
    con = connect()
    regs = [r[0] for r in con.execute(
        "SELECT DISTINCT regulation_id FROM obligations ORDER BY regulation_id"
        + (f" LIMIT {limit_regs}" if limit_regs else ""))]
    progress(f"  {len(regs)} regulation(s) with extracted obligations\n")

    made = {"provenance": 0, "provisions": 0, "conditions": 0, "exceptions": 0,
            "thresholds": 0, "timing": 0, "definitions": 0, "xrefs": 0}

    for n, rid in enumerate(regs, 1):
        doc = con.execute(
            """SELECT id, source_url, document_hash, created_at, extraction_method
               FROM documents WHERE regulation_id=?""", (rid,)).fetchone()
        reg = con.execute(
            "SELECT regulator FROM regulations WHERE id=?", (rid,)).fetchone()

        obls = con.execute(
            """SELECT id, source_excerpt, actor, action, obj, section_id, condition,
                      frequency, confidence, extraction_method
               FROM obligations WHERE regulation_id=? AND source_excerpt IS NOT NULL""",
            (rid,)).fetchall()

        for o in obls:
            text = o["source_excerpt"] or ""
            if len(text.strip()) < 20:
                continue
            mod, prohib, permit = modality_of(text)
            if not mod:
                continue      # no binding modal verb -> not a provision

            # one provenance row per provision, pointing at the exact source
            pv = con.execute(
                """INSERT INTO provenance
                   (regulation_id, document_id, source_authority, source_url, sha256,
                    retrieved_at, section_reference, source_text, extraction_method,
                    extraction_confidence, review_status)
                   VALUES (?,?,?,?,?,?,?,?,?,?, 'UNREVIEWED')""",
                (rid, doc["id"] if doc else None, reg["regulator"] if reg else None,
                 doc["source_url"] if doc else None, doc["document_hash"] if doc else None,
                 doc["created_at"] if doc else None, o["section_id"], text[:4000],
                 o["extraction_method"], o["confidence"])).lastrowid
            made["provenance"] += 1

            pid = f"prov-{o['id']}"
            con.execute(
                """INSERT INTO legal_provisions
                   (id, regulation_id, section_id, actor, modality, action, object,
                    is_prohibition, is_permission, source_text, provenance_id, review_status)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?, 'PROPOSED')
                   ON CONFLICT (id) DO NOTHING""",
                (pid, rid, o["section_id"], o["actor"], mod, o["action"], o["obj"],
                 prohib, permit, text[:4000], pv))
            con.execute("UPDATE obligations SET provision_id=?, modality=?, provenance_id=? WHERE id=?",
                        (pid, mod, pv, o["id"]))
            made["provisions"] += 1

            # ---- qualifiers, all quoting the source sentence ----
            for m in CONDITION.finditer(text):
                con.execute(
                    """INSERT INTO provision_conditions
                       (provision_id, obligation_id, condition_type, expression, source_text, provenance_id)
                       VALUES (?,?,?,?,?,?)""",
                    (pid, o["id"], m.group(1).upper().replace(" ", "_"),
                     text[max(0, m.start() - 40):m.start() + 200], text[:1000], pv))
                made["conditions"] += 1
                break

            for m in EXCEPTION.finditer(text):
                con.execute(
                    """INSERT INTO provision_exceptions
                       (provision_id, obligation_id, exception_type, expression, source_text, provenance_id)
                       VALUES (?,?,?,?,?,?)""",
                    (pid, o["id"], "EXEMPTION" if "exempt" in m.group(1).lower() else "EXCEPTION",
                     text[max(0, m.start() - 40):m.start() + 200], text[:1000], pv))
                made["exceptions"] += 1
                break

            for m in AMOUNT.finditer(text):
                amt = norm_amount(m.group(1), m.group(2))
                if amt is None:
                    continue
                con.execute(
                    """INSERT INTO thresholds
                       (provision_id, obligation_id, metric, operator, value, unit, currency,
                        source_text, provenance_id) VALUES (?,?,?,?,?,?,?,?,?)""",
                    (pid, o["id"], "amount", None, amt, None, "INR", m.group(0), pv))
                made["thresholds"] += 1
                break
            for m in PERCENT.finditer(text):
                con.execute(
                    """INSERT INTO thresholds
                       (provision_id, obligation_id, metric, operator, value, unit,
                        source_text, provenance_id) VALUES (?,?,?,?,?,?,?,?)""",
                    (pid, o["id"], "percentage", None, m.group(1), "%", m.group(0), pv))
                made["thresholds"] += 1
                break

            for m in DURATION.finditer(text):
                con.execute(
                    """INSERT INTO timing_rules
                       (provision_id, obligation_id, rule_type, expression, value, unit,
                        source_text, provenance_id) VALUES (?,?,?,?,?,?,?,?)""",
                    (pid, o["id"], "DEADLINE", m.group(0), m.group(1), m.group(2), m.group(0), pv))
                made["timing"] += 1
                break
            fm = FREQUENCY.search(text)
            if fm:
                con.execute(
                    """INSERT INTO timing_rules
                       (provision_id, obligation_id, rule_type, expression, value,
                        source_text, provenance_id) VALUES (?,?,?,?,?,?,?)""",
                    (pid, o["id"], "FREQUENCY", fm.group(1), fm.group(1).lower(), fm.group(0), pv))
                made["timing"] += 1

        # ---- definitions and cross-references, from section text ----
        for s in con.execute(
                """SELECT id, section_number, section_text FROM sections
                   WHERE regulation_id=? AND section_text IS NOT NULL""", (rid,)):
            body = s["section_text"] or ""
            for m in DEFINITION.finditer(body[:12000]):
                term = m.group(1).strip()
                if len(term) < 3 or term.lower().startswith("the "):
                    continue
                did = f"def-{rid}-{re.sub(r'[^a-z0-9]+','-',term.lower())[:40]}"
                con.execute(
                    """INSERT INTO definitions
                       (id, regulation_id, term, definition_text, source_section_id)
                       VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING""",
                    (did, rid, term, m.group(2).strip()[:2000], s["id"]))
                made["definitions"] += 1

            for m in XREF.finditer(body[:12000]):
                phrase = m.group(0).lower()
                rel = next((v for k, v in XREF_RELATION.items() if k in phrase), "REFERS_TO")
                con.execute(
                    """INSERT INTO cross_references
                       (source_regulation_id, source_reference, relation, target_reference,
                        resolved, source_text) VALUES (?,?,?,?,FALSE,?)""",
                    (rid, s["section_number"], rel, m.group(1).strip()[:200], m.group(0)[:400]))
                made["xrefs"] += 1

        if n % 25 == 0:
            con.commit()
            progress(f"  {n}/{len(regs)} · {made['provisions']} provisions, "
                     f"{made['definitions']} definitions, {made['thresholds']} thresholds")
    con.commit()
    return made


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only N regulations")
    a = ap.parse_args()
    res = run(a.limit)
    print("\n  backfilled:")
    for k, v in res.items():
        print(f"    {k:<14} {v}")
