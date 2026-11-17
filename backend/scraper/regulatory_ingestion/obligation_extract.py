"""
Classify extracted sentences, and parse the ones that are actually duties.

WHY THE OLD RULE WAS WRONG
--------------------------
Obligations were identified by the presence of a modal verb. That treats

    "These Directions shall be called the ... KYC Directions, 2016"     (a title)
    "The provisions shall apply to every entity regulated by RBI"       (applicability)
    "RBI may advise further action"                                     (a regulator power)

as compliance duties owed by the company, which they are not. A duty needs an
actor who is obliged, an action they must take, and something they must take it
on. Everything else is a different kind of sentence and belongs in a different
part of the model.

CONSERVATIVE BY CONSTRUCTION
----------------------------
Where the shape is not clear the sentence is marked NEEDS_REVIEW rather than
guessed into a category. A false obligation is worse than an unclassified one:
it puts work in front of a compliance officer that the regulation never asked
for, and it inflates every coverage number downstream.

Deterministic. No model is consulted, so the same text always classifies the
same way and the reasoning can be shown next to the result.
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------- vocabularies

# Sentences that define the instrument itself rather than impose anything.
SCOPE_PATTERNS = (
    r"shall be called",
    r"shall come into (force|effect)",
    r"may be called",
    r"these (directions|regulations|rules|guidelines) shall extend",
    r"^\s*(short title|commencement|extent)\b",
)

# Sentences that say WHO the instrument covers. These belong to applicability.
APPLICABILITY_PATTERNS = (
    r"(provisions of )?these (directions|regulations|rules|guidelines) shall (also )?apply",
    r"shall (be )?applicable to",
    r"this (direction|regulation|circular) applies to",
    r"shall apply to (every|all|any) ",
    r"nothing (in|contained in) these",
)

# Definitions.
DEFINITION_PATTERNS = (
    r"\bshall mean\b", r"\bmeans\b.*\bincludes\b", r"^\s*[\"“].+[\"”]\s+means",
    r"unless the context otherwise requires",
    r"for the purposes? of these (directions|regulations)",
    r"\bis defined as\b",
)

# References to amendment history, not duties.
AMENDMENT_PATTERNS = (
    r"\b(inserted|substituted|omitted|amended|deleted)\s+(by|vide)\b",
    r"\bvide\s+(circular|notification)\b",
    r"\bw\.e\.f\.\b",
)

# Actors a regulation can oblige. The regulator itself is listed because a
# sentence about what the REGULATOR may do is not a duty on the company.
COMPANY_ACTORS = (
    "re", "res", "regulated entity", "regulated entities", "bank", "banks",
    "nbfc", "nbfcs", "company", "companies", "entity", "entities",
    "financial institution", "financial institutions", "intermediary",
    "intermediaries", "insurer", "insurers", "applicant", "registered person",
    "taxable person", "employer", "issuer", "operator",
)
REGULATOR_ACTORS = (
    "reserve bank", "rbi", "sebi", "irdai", "the board", "central government",
    "the authority", "the bank may", "competent authority",
)

# Duty-bearing modals, and permissive ones that are not duties.
DUTY_MODALS = ("shall", "must", "is required to", "are required to",
               "shall not", "must not")
PERMISSIVE_MODALS = ("may", "can", "is permitted to", "at its discretion")


def _has(text: str, patterns) -> str | None:
    low = text.lower()
    for p in patterns:
        if re.search(p, low):
            return p
    return None


def _actor(text: str) -> tuple[str | None, str]:
    """
    Who the sentence is about, and whose kind of actor they are.

    Returns (actor, 'company' | 'regulator' | 'unknown').
    """
    low = " " + re.sub(r"[^a-z0-9 ]+", " ", text.lower()) + " "
    for a in sorted(REGULATOR_ACTORS, key=len, reverse=True):
        if f" {a} " in low or low.strip().startswith(a):
            return a, "regulator"
    for a in sorted(COMPANY_ACTORS, key=len, reverse=True):
        if f" {a} " in low:
            return a, "company"
    return None, "unknown"


_ACTION_RE = re.compile(
    r"\b(?:shall|must)\s+(?:not\s+)?(?:also\s+)?([a-z]+(?:\s+[a-z]+)?)", re.I)


def parse_duty(text: str) -> dict:
    """
    Actor, action and object, where the sentence supports it.

    Intentionally shallow: a first verb phrase after the modal, and the clause
    that follows it. This is enough to make an obligation readable as a duty
    rather than a wall of source text, and it never claims to be a parse of the
    legal meaning.
    """
    actor, actor_kind = _actor(text)
    m = _ACTION_RE.search(text)
    action = m.group(1).strip().lower() if m else None
    obj = None
    if m:
        tail = text[m.end():].strip(" ,;:")
        obj = re.split(r"[.;]| provided | subject to | in terms of ", tail)[0].strip()
        obj = (obj[:160] or None) if obj else None
    condition = None
    cm = re.search(r"\b(provided that|subject to|where|if|unless)\b(.{0,160})", text, re.I)
    if cm:
        condition = (cm.group(1) + cm.group(2)).strip()
    return {"actor": actor, "actorKind": actor_kind, "action": action,
            "object": obj, "condition": condition}


def classify(text: str) -> dict:
    """
    What kind of sentence this is, with the reason.

    Order matters: scope and definitions are checked before applicability, and
    applicability before duty, because a sentence can contain a duty modal and
    still be one of the others. The first confident match wins.
    """
    t = (text or "").strip()
    if not t:
        return {"kind": "EXPLANATORY", "confidence": 0.3, "reason": "empty text",
                "review": "NEEDS_REVIEW"}

    if len(t) < 25 or not re.search(r"[a-z]{3}", t.lower()):
        return {"kind": "EXPLANATORY", "confidence": 0.5,
                "reason": "too short to carry a duty; likely a heading",
                "review": "NEEDS_REVIEW"}

    hit = _has(t, AMENDMENT_PATTERNS)
    if hit:
        return {"kind": "AMENDMENT_REF", "confidence": 0.8,
                "reason": f"amendment reference ({hit})", "review": "UNREVIEWED"}

    hit = _has(t, SCOPE_PATTERNS)
    if hit:
        return {"kind": "SCOPE", "confidence": 0.9,
                "reason": f"defines the instrument itself ({hit})", "review": "UNREVIEWED"}

    hit = _has(t, DEFINITION_PATTERNS)
    if hit:
        return {"kind": "DEFINITION", "confidence": 0.8,
                "reason": f"defines a term ({hit})", "review": "UNREVIEWED"}

    hit = _has(t, APPLICABILITY_PATTERNS)
    if hit:
        return {"kind": "APPLICABILITY", "confidence": 0.85,
                "reason": f"states who the instrument covers ({hit})", "review": "UNREVIEWED"}

    low = t.lower()
    has_duty = any(m in low for m in DUTY_MODALS)
    actor, actor_kind = _actor(t)

    if not has_duty:
        if any(m in low for m in PERMISSIVE_MODALS):
            return {"kind": "PERMISSION", "confidence": 0.7,
                    "reason": "permissive modal, not a duty", "review": "UNREVIEWED"}
        return {"kind": "EXPLANATORY", "confidence": 0.6,
                "reason": "no duty-bearing modal", "review": "UNREVIEWED"}

    if actor_kind == "regulator":
        return {"kind": "PERMISSION", "confidence": 0.75,
                "reason": f"the duty falls on the regulator ({actor}), not the company",
                "review": "UNREVIEWED"}

    if actor_kind == "company":
        return {"kind": "OBLIGATION", "confidence": 0.8,
                "reason": f"duty modal with an obliged actor ({actor})",
                "review": "UNREVIEWED"}

    # A duty modal with nobody obliged. Real often enough to keep, never certain
    # enough to accept silently.
    return {"kind": "OBLIGATION", "confidence": 0.45,
            "reason": "duty modal but no identifiable actor",
            "review": "NEEDS_REVIEW"}
