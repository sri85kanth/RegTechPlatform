"""Deterministic obligation + applicability extraction (spec §9-§10).
Rules only — nothing is invented; every item carries its source section ref."""
import re

# obligation-type ontology (spec §9) — keyword → type
TYPE_ONTOLOGY = [
    ("REPORTING", r"\breport(ing|ed)?\b|\bfurnish\b|\bsubmit\b|\bfiling\b|\bSTR\b|\bCTR\b"),
    ("RECORD_KEEPING", r"\brecords?\b.*\b(maintain|preserve|keep)|\b(maintain|preserve|keep)\b.*\brecords?\b"),
    ("KYC", r"\bKYC\b|\bcustomer identification\b|\bcustomer acceptance\b|\bCDD\b|\bdue diligence\b"),
    ("AML", r"\bmoney.?laundering\b|\bAML\b|\bCFT\b|\bterror"),
    ("DISCLOSURE", r"\bdisclos"),
    ("APPROVAL", r"\bprior approval\b|\bapproval of\b|\bpermission\b"),
    ("MONITORING", r"\bmonitor"),
    ("GOVERNANCE", r"\bboard\b|\bsenior management\b|\bgovernance\b"),
    ("AUDIT", r"\baudit"),
    ("TRAINING", r"\btraining\b|\bawareness\b"),
    ("POLICY", r"\bpolicy\b|\bpolicies\b"),
    ("DATA_RETENTION", r"\bretain\b|\bretention\b|\bpreserved? for\b"),
    ("CYBERSECURITY", r"\bcyber\b|\binformation security\b"),
    ("RISK_MANAGEMENT", r"\brisk (assessment|management|categoris)"),
    ("NOTIFICATION", r"\bnotify\b|\bintimat\b|\binform\b"),
    ("REGISTRATION", r"\bregister\b|\bregistration\b"),
    ("LICENSING", r"\blicen[cs]"),
    ("DOCUMENTATION", r"\bdocument(s|ation)?\b|\bcertified cop"),
]
MODAL_RE = re.compile(r"\b(shall|must|is required to|are required to|shall not|should ensure)\b", re.I)
# SUBJECT_RE is defined below APPLICABILITY_VOCAB, which it is built from.
FREQ_RE = re.compile(r"\b(annuall?y|quarterly|monthly|every (?:two|three|\d+) (?:years?|months?)|within \d+ (?:days?|months?|hours?)|periodicall?y|at the time of|on an? ongoing basis)\b", re.I)
EVIDENCE_RE = re.compile(r"\b(records?|register|report|log|certificate|documents?)\b", re.I)

# The entity types an instrument can be ADDRESSED to. Only terms listed here
# are ever looked for, so a type missing from this list cannot produce an
# applicability rule no matter how plainly the document addresses it.
#
# Until 2026-09-10 every one of these was financial. That is why a corpus with
# hospital regulations in it still yielded one applicability rule per document:
# the extractor had no word for what a hospital is. The healthcare and
# general-industry block below is the vocabulary Indian health, drug, waste,
# radiation and labour instruments actually use to name their addressees.
#
# Adding a term does NOT loosen anything: addressee.py still classifies each
# occurrence by the role it plays in its own sentence, and only an addressee
# reading produces "Applies". A mention stays a mention.
APPLICABILITY_VOCAB = [
    # financial
    "Regulated Entities", "Scheduled Commercial Banks", "Commercial Banks", "Co-operative Banks",
    "NBFCs", "Non-Banking Financial Companies", "Payment System Providers", "Payment System Operators",
    "Small Finance Banks", "Payments Banks", "Regional Rural Banks", "Local Area Banks",
    "All India Financial Institutions", "Authorised Persons", "Housing Finance Companies",
    "Asset Reconstruction Companies", "Credit Information Companies", "banks", "financial institutions",
    # healthcare providers
    "Clinical Establishments", "clinical establishment", "hospitals", "hospital",
    "nursing homes", "nursing home", "health care facilities", "healthcare facilities",
    "health care establishments", "medical establishments", "dispensaries",
    # diagnostics, laboratories, blood
    "diagnostic centres", "diagnostic laboratories", "clinical laboratories",
    "medical laboratories", "pathology laboratories", "laboratories",
    "blood banks", "blood centres", "blood centre",
    # pharmacy, drugs, devices
    "pharmacies", "chemists", "druggists", "manufacturers", "importers",
    "licensees", "medical devices manufacturers",
    # people who carry duties personally
    "medical practitioners", "registered medical practitioners", "practitioners",
    "radiological safety officers",
    # PNDT / ART
    "genetic counselling centres", "genetic clinics", "genetic laboratories",
    "imaging centres", "ultrasound clinics",
    # waste, radiation, safety, labour — the instruments that reach any operator
    "occupiers", "occupier", "employers", "employer",
    "health care facility operators", "waste generators",
    "radiation installations", "radiological installations",
    "factories",
    # Parties this hospital IS but the extractor could not name, so 21,382 rules
    # were stored with entity_type "Unknown" and every regulation addressing one
    # of them came back REVIEW_REQUIRED. Each corresponds to a licence on the
    # company profile, or to a fact it records.
    "data fiduciaries", "data fiduciary", "significant data fiduciaries",
    "significant data fiduciary", "data processors", "data processor",
    "food business operators", "food business operator",
    "approved places", "approved place",
    "principal employers", "principal employer", "contractors", "contractor",
    "owners or occupiers", "building owners",
    # Specialised facility types. Added 2026-09-29 because NABH publishes a
    # separate standard for each, and without a word for them those standards
    # were declared against "hospitals"/"clinical establishment" — which this
    # company IS — and every one came back CONDITIONAL. A company acquires these
    # only from the matching licence or registration, so naming them is what lets
    # the engine say "does not apply, we are not an Ayush hospital" instead.
    "ayush hospitals", "ayush hospital", "ayush centres", "ayush centre",
    "ayush treatment and wellness centres", "ayurveda hospitals",
    "dental clinics", "dental clinic", "dental healthcare service providers",
    "care homes", "care home",
    "eye care organisations", "eye care organisation",
    "primary health centres", "primary health centre",
    "medical value travel facilitators",
    "stroke centres", "stroke centre",
]

# Who OWES the duty in an obligation sentence. This sets
# `obligations.responsible_entity`, and extract_clauses.promotable() rejects any
# obligation whose owner is under 4 characters — so a party missing here cannot
# produce a requirement, no matter how plainly the sentence imposes a duty.
#
# Until 2026-09-28 this pattern was finance-only (REs, Regulated Entities, banks,
# NBFCs, companies, intermediaries, insurers, "every X"). Measured against 20,000
# owner-less obligations in health, labour and environment instruments it matched
# exactly 0. That is why 96% of those obligations carried no owner, and why those
# regulations produced no requirements at all.
#
# It is now built FROM APPLICABILITY_VOCAB, so the subject matcher cannot drift
# from the addressee vocabulary again: widen one and both widen together. A
# measured variant that also accepted "the/no/any <party>" recovered no
# additional obligations, so the plainer pattern stands.
# Each vocabulary term is accepted in both the form it is listed in and its
# singular/plural counterpart: the list holds "licensees" but statutes write
# "The licensee shall", and without the singular that sentence fell through to
# the generic "every ..." branch and recorded the owner as "every transaction".
def _forms(term: str) -> set[str]:
    out = {term}
    if term.endswith("ies"):
        out.add(term[:-3] + "y")
    elif term.endswith("s"):
        out.add(term[:-1])
    else:
        out.add(term + "s")
        if term.endswith("y"):
            out.add(term[:-1] + "ies")
    return out


_SUBJECT_ALT = "|".join(
    sorted((re.escape(f) for t in APPLICABILITY_VOCAB for f in _forms(t)),
           key=len, reverse=True)
)
# The generic branch stops at the modal verb, so "Every hospital shall maintain
# a register" records "Every hospital", not "Every hospital shall maintain a ".
SUBJECT_RE = re.compile(
    r"\b(REs?|Regulated Entit(?:y|ies)|banks?|NBFCs?|companies"
    r"|intermediar(?:y|ies)|insurers?|" + _SUBJECT_ALT +
    r"|every [A-Za-z][A-Za-z ]{2,29}?(?=\s+(?:shall|must|is required|may|should))"
    r"|every [A-Za-z ]{3,30})\b", re.I)


def classify(text: str) -> str:
    for otype, pat in TYPE_ONTOLOGY:
        if re.search(pat, text, re.I):
            return otype
    return "DOCUMENTATION"


def split_sentences(text: str) -> list[str]:
    flat = re.sub(r"\s+", " ", text)
    return [s.strip() for s in re.split(r"(?<=[a-z0-9\)])\.\s+(?=[A-Z(])", flat) if len(s.strip()) > 30]


def extract_obligations(reg_id: str, sections: list[dict], max_per_section: int = 6) -> list[dict]:
    out = []
    n = 0
    for sec in sections:
        found = 0
        for sent in split_sentences(sec.get("text", "")):
            if found >= max_per_section:
                break
            m = MODAL_RE.search(sent)
            if not m:
                continue
            subj = SUBJECT_RE.search(sent)
            freq = FREQ_RE.search(sent)
            ev = EVIDENCE_RE.search(sent)
            # confidence: deterministic pattern base, penalised for messy sentences
            conf = 0.9
            if len(sent) > 600:
                conf -= 0.15
            if not subj:
                conf -= 0.1
            n += 1
            found += 1
            out.append({
                "id": f"{reg_id}-obl-{n:03d}",
                "regulation_id": reg_id,
                "section_no": sec["no"],
                "title": sent[:110].rstrip(" ,;") + ("…" if len(sent) > 110 else ""),
                "description": sent[:800],
                "obligation_type": classify(sent),
                "mandatory_action": m.group(0).lower(),
                "responsible_entity": subj.group(0) if subj else None,
                "frequency": freq.group(0) if freq else None,
                "evidence_required": ev.group(0) if ev else None,
                "source_reference": f"Section {sec['no']}",
                "confidence": round(conf, 2),
                "extraction_method": "deterministic modal-verb rule",
            })
    return out


from .addressee import RANK  # noqa: E402

SCOPE_HINT = r"applicab|scope|extent|commencement|coverage|definition"

# A cost bound on the whole-document fallback below, not a claim about the
# document: a text that names its addressee names it well before section 200.
FALLBACK_SECTION_LIMIT = 200


def scan_addressees(items: list[tuple]) -> dict[str, dict]:
    """
    Strongest addressee role per entity type. `items` are (no, title, text).

    Reads where scope is normally declared — the first twelve sections, plus
    any later one whose title or opening reads like a scope clause.

    FALLBACK: if that finds no ADDRESSEE at all, the whole document is read.
    An Act says who it binds in section 1. A guidance document often has no
    scope clause and opens with a contents page: the Hospital Infection Control
    Guidelines runs to 352 sections, is addressed to hospitals throughout, and
    its first twelve "sections" are the table of contents — dotted leaders and
    all. The targeted read found nothing, so a document about hospitals
    produced one applicability rule and looked as though it bound nobody.

    The fallback cannot loosen the standard. role_in() still classifies every
    occurrence by the part it plays in its own sentence, so a mention stays a
    mention wherever it is found. And it only runs when the narrow read came
    back empty, so no result that already exists can change because of it.

    This is the single implementation: reclassify_applicability.py used to
    carry its own copy, which meant a change here silently did not apply there.
    """
    from .addressee import role_in

    def collect(chosen) -> dict[str, dict]:
        best: dict[str, dict] = {}
        for no, _title, text in chosen:
            if not text:
                continue
            for ent in APPLICABILITY_VOCAB:
                found = role_in(text, ent)
                if not found:
                    continue
                role, evidence = found
                prev = best.get(ent)
                if prev is None or RANK[role] > RANK[prev["role"]]:
                    best[ent] = {"role": role, "evidence": evidence, "sec": no}
        return best

    head = items[:12]
    scope_like = [it for it in items[12:]
                  if re.search(SCOPE_HINT, f"{it[1] or ''} {(it[2] or '')[:200]}", re.I)][:12]
    best = collect(head + scope_like)
    if not any(b["role"].startswith("ADDRESSEE") for b in best.values()):
        best = collect(items[:FALLBACK_SECTION_LIMIT])
    return best


def extract_applicability(sections: list[dict]) -> list[dict]:
    """
    Which entity types a regulation is ADDRESSED to.

    This used to be a substring test: if "NBFCs" appeared anywhere in the first
    eight sections the regulation was recorded as applying to NBFCs at a flat
    0.85. That is how a Commercial Banks Directions document ended up on an
    NBFC's applicable list — the only NBFC in it was a borrower being lent to.

    Every occurrence is now classified by the role it plays in its own sentence
    (see addressee.py). Only an addressee reading produces "Applies"; a mention
    is stored as a mention, and a carve-out as an exclusion. Nothing is dropped:
    a counterparty mention is still a fact about the document, and keeping it
    with its evidence is what makes the verdict checkable.
    """
    from .addressee import resolve_document, VERDICT, CONFIDENCE, UNCERTAIN

    best = scan_addressees([(s.get("no"), s.get("title", ""), s.get("text", ""))
                            for s in sections])
    rules = []

    for ent, b in resolve_document(best).items():
        if b["role"] == UNCERTAIN:
            continue
        rules.append({
            "entity_type": ent,
            "applicability": VERDICT[b["role"]],
            "applicability_rule": b["evidence"],
            "source_clause": f"Section {b['sec']}",
            "confidence": CONFIDENCE[b["role"]],
            "role": b["role"],
        })

    if not rules:
        rules.append({"entity_type": "Unknown", "applicability": "Unknown",
                      "applicability_rule": "No entity type is addressed in the scope or "
                                            "obligation language of this document",
                      "source_clause": None, "confidence": 0.0, "role": UNCERTAIN})
    return rules
