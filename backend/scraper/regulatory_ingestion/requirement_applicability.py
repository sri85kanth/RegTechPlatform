"""
Does this REQUIREMENT apply to this company, and why?

The regulation-level engine (applicability.py) answers "does this law reach us".
Compliance work happens one level down: a law that reaches a hospital still has
definitions, duties of the Authority, duties of manufacturers or insurers, and
duties that bind only in a situation the hospital may not be in. Until now every
requirement simply inherited its regulation's verdict, and the only per-
requirement "not applicable" in the system was a blanket one with a boilerplate
reason ("this provision does not place a duty on the hospital"), stamped on
15,038 requirements — 868 of them reading "the hospital shall …".

SAME RULES AS THE REGULATION ENGINE
-----------------------------------
  * Deterministic and explainable: every verdict names the kind of sentence it
    read and quotes the words it rests on. No model is consulted.
  * Silence is never a "no". A requirement is ruled out only by its own words:
    it defines a term, it is addressed to an authority, or it names an entity
    type the company plainly is not (a bank, an insurer, a manufacturer).
  * A requirement is never more applicable than its regulation. "The hospital
    shall …" inside a CONDITIONAL regulation is CONDITIONAL.
  * Ambiguous addressees (an occupier, a licensee, a contractor) go to a person:
    a hospital is very often the occupier, and nothing here may guess otherwise.
"""
from __future__ import annotations

import re

from . import applicability as A

ENGINE = "req-engine/1"
APPLICABLE, CONDITIONAL, NOT_APPLICABLE = "APPLICABLE", "CONDITIONAL", "NOT_APPLICABLE"
REVIEW_REQUIRED, UNASSESSED = "REVIEW_REQUIRED", "UNASSESSED"

# The kinds of sentence a requirement can be. The kind decides the verdict.
NOT_A_DUTY = "NOT_A_DUTY"            # a definition, the short title, commencement, a classification
AUTHORITY = "AUTHORITY"              # a duty or power of a government body, not of the company
OTHER_TYPE = "OTHER_TYPE"            # addressed to a type the company plainly is not
AMBIGUOUS_TYPE = "AMBIGUOUS_TYPE"    # addressed to a type the company may be: a person confirms
OURS = "OURS"                        # addressed to a type the company is
SITUATION = "SITUATION"              # binds only where / if something is the case
INHERITS = "INHERITS"                # a duty that names no one: it binds whoever the regulation binds
NO_DUTY_WORDS = "NO_DUTY_WORDS"      # a heading, a list item, a standard's element: read with the regulation
REGULATION_OUT = "REGULATION_OUT"    # the regulation itself does not apply

# Types a hospital is not. Only these can rule a requirement out by addressee.
CLEARLY_OTHER = {"bank", "nbfc", "insurer", "intermediary", "payment", "financial institution",
                 "hfc", "cic", "arc", "travel facilitator", "manufacturer"}

_NOT_A_DUTY = re.compile(
    r"\bshall\s+mean\b|"
    r"^\W*(?:\(\w{1,4}\)\s*)?[\"“'‘]?[A-Za-z][\w\s,/-]{0,50}[\"”'’]?\s+means\b|"
    r"\b(?:come|comes)\s+into\s+(?:force|effect|operation)\b|"
    r"\b(?:shall|may)\s+be\s+(?:called|cited)\b|"
    r"\bshall\s+be\s+assigned\s+to\s+class\b|"
    r"\bis\s+hereby\s+repealed\b|"
    r"^\W*(?:it|they|these\s+\w+)\s+(?:shall\s+)?extends?\s+to\s+the\s+whole\s+of\b", re.I)
_DUTY = re.compile(r"\b(?:shall|must|is\s+required\s+to|are\s+required\s+to)\b", re.I)
# Bodies of the state. Not "board", "committee", "director" or "officer": a
# hospital has its own, and their duties are the hospital's.
_AUTHORITY = re.compile(
    r"^\W*(?:the\s+|every\s+|such\s+|any\s+)?(?:central\s+|state\s+|appropriate\s+|competent\s+|"
    r"food\s+|licensing\s+|appellate\s+|adjudicating\s+|designated\s+)?"
    r"(?:government|authority|tribunal|commission|council|court|registrar|inspector|"
    r"controller|commissioner|magistrate|regulator|adjudicating\s+officer)s?\b", re.I)
_SITUATION = re.compile(r"^\W*(?:\(\w{1,4}\)\s*)?(?:where|if|in\s+case|in\s+the\s+case\s+of|"
                        r"provided\s+that|unless|when)\b", re.I)


def _clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _ours(fams: set[str], company: set[str]) -> set[str]:
    """Families in the sentence that the company is. A hospital that generates
    bio-medical waste is the "occupier" those rules address."""
    hit = fams & company
    if "occupier" in fams and company & {"waste generator", "building occupier"}:
        hit.add("occupier")
    return hit


def classify(statement: str | None, company: set[str]) -> dict:
    """What kind of sentence this is, and the words that show it."""
    s = _clean(statement)
    if not s:
        return {"kind": NO_DUTY_WORDS, "quote": ""}
    quote = s[:300]
    if _NOT_A_DUTY.search(s):
        return {"kind": NOT_A_DUTY, "quote": quote}
    m = _DUTY.search(s)
    subject = s[:m.start()] if m else s[:140]
    if m and _AUTHORITY.search(subject):
        return {"kind": AUTHORITY, "quote": quote, "subject": _clean(subject)[:80]}
    if not m:
        return {"kind": NO_DUTY_WORDS, "quote": quote}
    fams = A._families(subject) - A.UMBRELLA
    ours = _ours(fams, company)
    if _SITUATION.search(s):
        return {"kind": SITUATION, "quote": quote}
    if ours:
        return {"kind": OURS, "quote": quote, "families": sorted(ours)}
    if fams and fams <= CLEARLY_OTHER:
        return {"kind": OTHER_TYPE, "quote": quote, "families": sorted(fams)}
    if fams:
        return {"kind": AMBIGUOUS_TYPE, "quote": quote, "families": sorted(fams - CLEARLY_OTHER) or sorted(fams)}
    return {"kind": INHERITS, "quote": quote}


def _cap(status: str, regulation: str) -> str:
    """Never more applicable than the regulation."""
    order = {NOT_APPLICABLE: 0, UNASSESSED: 1, REVIEW_REQUIRED: 2, CONDITIONAL: 3, APPLICABLE: 4}
    return status if order[status] <= order[regulation] else regulation


def decide(statement: str | None, regulation_verdict: str | None, company: set[str],
           origins: dict[str, str] | None = None) -> dict:
    """
    The requirement's verdict: status (the scope table's vocabulary), kind,
    reason (one sentence a person can check) and confidence.
    """
    reg = regulation_verdict if regulation_verdict in (APPLICABLE, CONDITIONAL, REVIEW_REQUIRED,
                                                       NOT_APPLICABLE) else UNASSESSED
    if reg == NOT_APPLICABLE:
        return {"status": NOT_APPLICABLE, "kind": REGULATION_OUT, "confidence": 0.9,
                "reason": "The regulation itself does not apply to the company."}
    c = classify(statement, company)
    k, origins = c["kind"], origins or {}
    names = ", ".join(c.get("families", []))
    if k == NOT_A_DUTY:
        out = (NOT_APPLICABLE, 0.9, "Not a duty: it defines a term, names the instrument, sets its "
                                    "commencement or classifies something.")
    elif k == AUTHORITY:
        out = (NOT_APPLICABLE, 0.8, f"A duty or power of {c.get('subject') or 'a government body'}, "
                                    "not of the company.")
    elif k == OTHER_TYPE:
        out = (NOT_APPLICABLE, 0.8, f"Addressed to {names}, which the company is not.")
    elif k == AMBIGUOUS_TYPE:
        out = (_cap(CONDITIONAL, reg), 0.5, f"Addressed to {names}. Confirm whether the company is one.")
    elif k == OURS:
        fam = c["families"][0]
        why = origins.get(fam)
        out = (_cap(APPLICABLE, reg), 0.85,
               f"Addressed to {names}, which the company is" + (f" (from its {why})." if why else "."))
    elif k == SITUATION:
        out = (_cap(CONDITIONAL, reg), 0.5, "Binds only in the situation it describes. Confirm whether "
                                            "the company is in it.")
    elif k == INHERITS:
        out = (_cap(APPLICABLE, reg), 0.6, "Names no one, so it binds whoever the regulation binds.")
    else:
        out = (_cap(APPLICABLE, reg), 0.5, "States no separate addressee, so it is read with the regulation.")
    status, conf, reason = out
    if k in (OURS, INHERITS, NO_DUTY_WORDS) and reg == CONDITIONAL:
        reason += " The regulation itself is conditional for the company."
    return {"status": status, "kind": k, "confidence": conf, "reason": reason, "quote": c.get("quote", "")}
