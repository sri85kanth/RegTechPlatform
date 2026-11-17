"""
Who a regulation is ADDRESSED to — as distinct from who it merely mentions.

THE BUG THIS EXISTS TO FIX
--------------------------
The original extractor asked one question: does the string "NBFCs" appear in
the first few sections? If yes, it wrote `applicability = Applies` at a flat
0.85 confidence. That is keyword similarity, not law.

Run it against the RBI (Commercial Banks – Credit Facilities) Directions and it
finds "NBFC" in:

    "Shares and debentures shall not be accepted as collateral securities for
     secured loans granted to NBFC borrowers for any purpose."

and concludes that a Directions document addressed to banks applies to an NBFC.
It does not. The NBFC there is the *borrower* — the party the bank is regulated
about, not the party being regulated. A compliance officer handed that list
would be reading somebody else's rulebook.

WHAT THIS MODULE DOES INSTEAD
-----------------------------
For every occurrence of an entity term it asks what grammatical role the term
plays in its own sentence, and returns one of four roles:

  ADDRESSEE_SCOPE    a scope clause names it — "these Directions shall be
                     applicable to Commercial Banks"
  ADDRESSEE_SUBJECT  it is the subject of an obligation — "every NBFC shall
                     put in place a policy"
  EXCLUDED           a scope clause or carve-out removes it — "other than
                     Small Finance Banks", "shall not apply to ..."
  COUNTERPARTY       it is the object of somebody else's duty — "loans granted
                     to NBFC borrowers", "bills discounted by NBFCs"
  UNCERTAIN          none of the above could be established

Only ADDRESSEE_* means the regulation reaches that entity type.

DELIBERATELY CONSERVATIVE
-------------------------
Where the reading is genuinely ambiguous this returns UNCERTAIN rather than
guessing, and an entity that is the object of a hard preposition (to / by /
from / against) is treated as a counterparty even when a modal follows later in
the sentence. That under-claims: a regulation that does apply may land in
"review required". In this domain an under-claim costs a human read; an
over-claim puts a bank's rulebook on an NBFC's compliance list and is only
discovered when somebody audits it.
"""
from __future__ import annotations

import re

# Roles, ranked. When a term occurs several times the strongest reading wins.
ADDRESSEE_SCOPE = "ADDRESSEE_SCOPE"
ADDRESSEE_SUBJECT = "ADDRESSEE_SUBJECT"
ADDRESSEE_LIST = "ADDRESSEE_LIST"
OUTSIDE_SCOPE = "OUTSIDE_SCOPE"
EXCLUDED = "EXCLUDED"
COUNTERPARTY = "COUNTERPARTY"
UNCERTAIN = "UNCERTAIN"

RANK = {ADDRESSEE_SCOPE: 4, EXCLUDED: 3, ADDRESSEE_SUBJECT: 2, ADDRESSEE_LIST: 2,
        COUNTERPARTY: 1, OUTSIDE_SCOPE: 1, UNCERTAIN: 0}

# The stored verdict each role maps to. "Applies" keeps its original meaning;
# the other three are new and are what the old extractor was mislabelling.
VERDICT = {
    ADDRESSEE_SCOPE: "Applies",
    ADDRESSEE_SUBJECT: "Applies",
    ADDRESSEE_LIST: "Applies",
    EXCLUDED: "Does Not Apply",
    COUNTERPARTY: "Mentioned Only",
    OUTSIDE_SCOPE: "Mentioned Only",
    UNCERTAIN: "Unknown",
}
CONFIDENCE = {
    ADDRESSEE_SCOPE: 0.90,     # an explicit scope clause is the best evidence there is
    ADDRESSEE_SUBJECT: 0.75,   # an obligation addressed to the type, but not a scope clause
    ADDRESSEE_LIST: 0.70,      # named in the document's own distribution list
    EXCLUDED: 0.85,
    COUNTERPARTY: 0.80,        # confident it is a mention, which is not applicability
    OUTSIDE_SCOPE: 0.80,       # named in the document, but outside the scope clause
    UNCERTAIN: 0.0,
}

# ---------------------------------------------------------------- language ---

# Verbs that open a scope statement: "applies to", "extends to", "is binding on".
# "cover" was in this list and matched the NOUN in "instruction (the cover)
# from the ordering financial institution", which read as a scope clause in the
# KYC Master Direction and suppressed its real one. Only verbs that take "to"
# or "on" survive, and they must sit close to the term.
_SCOPE_VERB = re.compile(
    r"\b(?:appl(?:y|ies|icable|ication)\s+(?:to|in\s+respect\s+of)|extends?\s+to|"
    r"binding\s+on|addressed\s+to)\b", re.I)

# The narrowest, strongest form: the instrument naming its own addressees.
# Only this can stop a distribution list elsewhere in the document from
# widening the scope back out.
_INSTRUMENT_SCOPE = re.compile(
    r"\bthese\s+(?:directions|regulations|guidelines|rules|instructions|provisions|master)\b"
    r"[^.]{0,90}?\bappl|\bprovisions\s+of\s+these\b[^.]{0,90}?\bappl", re.I)

# The same verbs negated — checked first, because "shall not apply to X"
# contains "apply to X".
_NEG_SCOPE = re.compile(
    r"\b(?:shall|does|do|will|would|is|are|were)\s+not\s+(?:be\s+)?"
    r"(?:appl\w+|extend\w*|cover\w*|binding)\b", re.I)

# Carve-outs. "other than Small Finance Banks" is an exclusion even though it
# sits inside a sentence whose main verb is "applicable to".
_EXCEPT = re.compile(
    r"\b(?:other\s+than|excluding|exclusive\s+of|save\s+(?:for|as)|except(?:\s+for)?|"
    r"shall\s+not\s+include|does\s+not\s+include|do\s+not\s+include)\b", re.I)

# Deontic verbs. A term followed by one of these is being told what to do.
_MODAL = re.compile(
    r"^(?P<gap>[^.]{0,90}?)\b(?:shall|must|should|may|will|is\s+required\s+to|are\s+required\s+to|"
    r"is\s+expected\s+to|are\s+expected\s+to|has\s+to|have\s+to|is\s+permitted\s+to|"
    r"are\s+permitted\s+to|is\s+prohibited|are\s+prohibited)\b", re.I)

# Prepositions that make the following noun the OBJECT of somebody else's duty.
# "for" and "of" are excluded on purpose: "For NBFCs, paragraph 3 shall apply"
# is an addressee construction, not a counterparty one.
# The gap allows the term to be the head of a noun phrase ("by non-bank
# financial companies"), but stops at words that signal a new clause, so
# "to ensure that banks shall ..." is not read as an object.
_HARD_OBJ = re.compile(
    r"\b(?:to|by|from|with|against|upon|between|among|amongst|through|via|into|onto|on)\s+"
    r"(?:(?!that\b|which\b|whether\b|ensure\b|be\b|being\b|have\b|has\b)[\w\u2019'-]+[\s-]+){0,4}$", re.I)

# A definition is not an obligation. "'NBFC' shall mean a company registered
# under ..." tells you what a word means; it does not tell an NBFC to do
# anything, and a bank's Directions routinely define the counterparties it deals
# with. Without this, every glossary entry read as an addressee.
_DEFINITIONAL = re.compile(
    r"^[^.]{0,70}?\b(?:shall\s+(?:mean|include|be\s+as\s+defined|have\s+the\s+(?:same\s+)?meaning)|"
    r"means\b|is\s+defined\s+as|shall\s+be\s+construed)\b", re.I)

# A new subject between the term and the modal means the duty belongs to
# somebody else: in "the paid-up equity of an NBFC, it shall be required to
# demonstrate ...", "it" is the bank, not the NBFC.
_NEW_SUBJECT = re.compile(
    r"[,;]\s*(?:it|they|he|she|the|such|a|an|this|these|those|which|who|that)\s+\w*\s*$", re.I)

# The quantifiers a distribution list actually uses. "any" is not one of them.
_LIST_QUANT = re.compile(r"\b(?:every|each|all)\s+(?:[\w\u2019'-]+\s+){0,5}$", re.I)

# "every NBFC", "each bank", "all Regulated Entities".
_QUANT = re.compile(r"\b(?:every|each|all|any|no)\s+(?:[\w\u2019'-]+\s+){0,5}$", re.I)

# The entity term used as a MODIFIER rather than as the entity: "hospital
# records", "bank charges", "laboratory data". The thing being regulated is the
# noun that follows, and the entity is describing it. An IRDAI circular telling
# insurers to keep "all applicable hospital records" is addressed to insurers;
# reading it as addressed to hospitals put cable-TV and insurance rulebooks on a
# hospital's applicable list.
_MODIFIER_NOUN = re.compile(
    r"^\s*(?:records?|data|bills?|charges?|invoices?|claims?|accounts?|"
    r"details?|information|documents?|reports?|returns?|statements?|"
    r"services?|facilities|premises|staff|beds?|equipment|expenses?|"
    r"costs?|fees?|rates?|tariffs?|networks?|chains?|groups?|systems?)\b", re.I)

# Reported speech. A consultation paper quotes what stakeholders proposed; a
# suggestion that hospitals be included is not the instrument including them.
_REPORTED = re.compile(
    r"\b(?:suggest(?:ed|ion|ions)?|propos(?:ed|al|als)|recommend(?:ed|ation|ations)?|"
    r"submitted|commented|stakeholders?|respondents?|views? (?:of|were)|"
    r"in (?:its|their) comments)\b", re.I)

# Nouns that mark the term as the other side of a transaction.
_ROLE_NOUN = re.compile(
    r"^\s*(?:borrower|customer|client|counterpart(?:y|ies)|vendor|agent|supplier|"
    r"partner|investor|depositor|applicant|subsidiar)", re.I)

# Sentence-ish split. Regulatory text uses ";" and "(a)" as much as ".".
_SPLIT = re.compile(r"(?<=[.;:])\s+(?=[A-Z(\d])|\n+")


def _segments(text: str) -> list[tuple[int, str]]:
    """Segments with their offset in the original text, so evidence can be quoted."""
    out, pos = [], 0
    for part in _SPLIT.split(text):
        if part is None:
            continue
        i = text.find(part, pos)
        if i < 0:
            i = pos
        out.append((i, part))
        pos = i + len(part)
    return out


def _classify_one(seg: str, start: int, end: int) -> str:
    """The role of seg[start:end] within its own segment. Priority is the point."""
    before, after = seg[:start], seg[end:]

    # An abbreviation in brackets inherits the role of the phrase it stands for:
    # in "bills discounted by non-bank financial companies (NBFCs)" the acronym
    # is not doing its own grammatical work.
    if before.rstrip().endswith("("):
        before = seg[:before.rstrip().rfind("(")]
        after = after.lstrip()
        if after.startswith(")"):
            after = after[1:]

    tail = before[-90:]

    # 1. Exclusion beats everything, because the exclusion clause is normally
    #    nested inside a sentence whose main verb is a scope verb.
    if _NEG_SCOPE.search(tail) or _EXCEPT.search(tail):
        return EXCLUDED

    # 2. An explicit scope clause naming the term.
    # The scope verb has to be near the term; one three sentences back is not
    # governing this one.
    if _SCOPE_VERB.search(before[-160:]) and not _NEG_SCOPE.search(before):
        return ADDRESSEE_SCOPE

    # 3. Object of somebody else's duty — checked before the modal test, so
    #    "loans granted to NBFCs ... shall be secured" does not read as an
    #    obligation on the NBFC.
    if _HARD_OBJ.search(before) or _ROLE_NOUN.match(after):
        return COUNTERPARTY

    # 4. Subject of an obligation — but not of a definition, and not when a
    #    different subject intervenes before the modal.
    m = _MODAL.match(after)
    if m and not _DEFINITIONAL.match(after) and not _NEW_SUBJECT.search(m.group("gap")):
        return ADDRESSEE_SUBJECT

    # 5. "every NBFC" with a duty somewhere later in the segment.
    if _QUANT.search(tail) and _MODAL.match(after) and not _DEFINITIONAL.match(after):
        return ADDRESSEE_SUBJECT

    # 6. The document's own distribution list: "All Scheduled Commercial Banks /
    #    All NBFCs / All Payment System Providers". A quantified entity type in a
    #    segment that contains no duty verb at all is an addressee being named,
    #    not a party being talked about.
    # "any NBFC which is part of a group holding assets over Rs 5000 crore" is
    # an eligibility criterion in a bank-licensing document, not a distribution
    # list, so "any" is excluded and the segment has to be short enough to be a
    # list item rather than a prose clause.
    if (_LIST_QUANT.search(tail) and len(seg) <= 200 and not _ANY_MODAL.search(seg)
            # "all applicable hospital records" — the entity qualifies the noun
            # after it and is not itself what is being addressed.
            and not _MODIFIER_NOUN.match(after)
            # "Another suggestion is for inclusion of all hospitals with 30 beds"
            # — a consultation paper reporting what someone proposed.
            and not _REPORTED.search(seg)):
        return ADDRESSEE_LIST

    return UNCERTAIN


# Some addressee sets are never written in the vocabulary's words. The KYC
# Master Direction says its provisions "shall apply to every entity regulated by
# Reserve Bank of India" — the broadest scope clause in the corpus, and it
# contains none of the terms the vocabulary looks for. Without these aliases the
# document that most obviously binds every RBI-regulated firm read as applying
# to nobody.
SURFACE_ALIASES: dict[str, list[str]] = {
    "Regulated Entities": [
        r"Regulated\s+Entit(?:y|ies)",
        r"entit(?:y|ies)\s+regulated\s+by\s+(?:the\s+)?Reserve\s+Bank(?:\s+of\s+India)?",
        r"REs\b",
    ],
}

# Any deontic verb anywhere in the segment. A distribution list — "All Scheduled
# Commercial Banks / All NBFCs / All Payment System Providers" — has none.
_ANY_MODAL = re.compile(r"\b(?:shall|must|should|may|required\s+to)\b", re.I)


def _term_pattern(term: str) -> re.Pattern:
    """
    Singular and plural both count. The vocabulary stores "NBFCs", but the text
    that matters says "NBFC borrowers" — matching only the stored form silently
    skipped exactly the occurrences worth classifying.
    """
    forms = {term}
    low = term.lower()
    if low.endswith("ies"):
        forms.add(term[:-3] + "y")
    elif low.endswith("s"):
        forms.add(term[:-1])
    else:
        forms.add(term + "s")
        if low.endswith("y"):
            forms.add(term[:-1] + "ies")
    parts = [re.escape(f) for f in sorted(forms, key=len, reverse=True)]
    parts += SURFACE_ALIASES.get(term, [])
    return re.compile(r"(?<![A-Za-z])(?:" + "|".join(parts) + r")(?![A-Za-z])", re.I)


def _quote(seg: str) -> str:
    return re.sub(r"\s+", " ", seg).strip()[:300]


def role_in(text: str, term: str) -> tuple[str, str] | None:
    """
    The strongest role `term` plays anywhere in `text`, with the sentence that
    established it. Returns None when the term does not occur at all.
    """
    pat = _term_pattern(term)
    best: tuple[str, str] | None = None
    for off, seg in _segments(text):
        for m in pat.finditer(seg):
            role = _classify_one(seg, m.start(), m.end())
            if best is None or RANK[role] > RANK[best[0]]:
                best = (role, _quote(seg))
            if RANK[role] == 4:          # nothing can beat an explicit scope clause
                return best
    return best


# The entity families broad enough to cover anyone the regulator regulates. A
# document scoped to these has not narrowed itself, so nothing inside it is
# "outside scope".
# "All India Financial Institutions" is a named RBI category (NABARD, SIDBI,
# EXIM, NHB), not a catch-all, so it is deliberately NOT here: a document scoped
# to AIFIs has narrowed itself, and treating it as an umbrella let a
# distribution list inside it widen the scope back out.
UMBRELLA_TERMS = {"regulated entities"}


def resolve_document(best: dict[str, dict]) -> dict[str, dict]:
    """
    Reconcile a document's readings against its own scope clause.

    The RBI (Commercial Banks – Know Your Customer) Directions say plainly
    "These directions shall be applicable to Commercial Banks", and then, in a
    later paragraph, reproduce the parent Master Direction's distribution list —
    "(c) All Non-Banking Finance Companies (NBFCs)". Read term by term, both are
    addressee constructions, and the document ends up applying to NBFCs.

    It does not. A scope clause governs; a list quoted inside the document
    cannot widen it. So when a document names a SPECIFIC scope, every other
    entity type found in it is marked OUTSIDE_SCOPE rather than treated as an
    addressee. An umbrella scope ("every entity regulated by the Reserve Bank")
    narrows nothing, so it leaves the other readings alone.
    """
    scoped = {t for t, b in best.items()
              if b["role"] == ADDRESSEE_SCOPE
              and t.lower() not in UMBRELLA_TERMS
              and _INSTRUMENT_SCOPE.search(b.get("evidence") or "")}
    if not scoped:
        return best

    out = {}
    for term, b in best.items():
        if b["role"] in (ADDRESSEE_LIST, ADDRESSEE_SUBJECT) and term not in scoped:
            out[term] = {**b, "role": OUTSIDE_SCOPE}
        else:
            out[term] = b
    return out
