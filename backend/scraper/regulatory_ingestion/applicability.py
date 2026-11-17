"""
Does this regulation apply to this company, and why?

DETERMINISTIC AND EXPLAINABLE, BY DESIGN
----------------------------------------
No model is consulted. Every verdict is the sum of named checks, each of which
reports what it compared, what it found, and which clause it came from. A
compliance officer has to be able to defend the answer to an auditor, which means
the reasoning has to be inspectable and the same inputs must always produce the
same output.

THREE OUTCOMES, NOT TWO
-----------------------
    APPLICABLE       at least one check matched and none contradicted it
    NOT_APPLICABLE   a check positively excluded the company
    REVIEW_REQUIRED  the evidence is insufficient to decide

REVIEW_REQUIRED is the default. Silence is not a "no": a regulation we cannot
evaluate is a regulation a human must look at, and reporting it as inapplicable
would be the most dangerous possible failure of a compliance tool.

WHAT THIS CANNOT DO YET
-----------------------
The extracted `applicability_rule` text is a raw excerpt from the source, not a
parsed condition, so it is shown as supporting evidence rather than evaluated.
There is no threshold model in the schema (no asset-size or turnover condition is
stored), so threshold checks report UNKNOWN rather than guessing. Both are
reported to the caller as explicit gaps rather than hidden.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime

MATCH, NO_MATCH, UNKNOWN = "MATCH", "NO_MATCH", "UNKNOWN"
APPLICABLE, NOT_APPLICABLE, REVIEW_REQUIRED = "APPLICABLE", "NOT_APPLICABLE", "REVIEW_REQUIRED"
# A fifth outcome, because "it reaches companies like yours, but conditions we
# cannot evaluate may exclude you" is neither a yes nor a maybe.
CONDITIONAL = "CONDITIONAL"

# Entity vocabulary. A regulation says "Regulated Entities" or "NBFC-ND-SI"; a
# company profile says "NBFC — Investment & Credit Company". Matching those needs
# the synonyms written down rather than inferred, so the reasoning stays legible.
ENTITY_SYNONYMS: dict[str, set[str]] = {
    "nbfc": {"nbfc", "nbfcs", "non-banking financial", "non banking financial",
             "investment & credit company", "investment and credit company",
             "nbfc-icc", "nbfc-nd", "nbfc-nd-si", "nbfc-d"},
    "bank": {"bank", "banks", "scheduled commercial bank", "commercial bank",
             "co-operative bank", "cooperative bank", "rrb", "regional rural bank",
             "local area bank", "payments bank", "small finance bank"},
    "regulated entity": {"regulated entity", "regulated entities", "re", "res"},
    "insurer": {"insurer", "insurance company", "insurers"},
    "payment": {"payment aggregator", "payment gateway", "psp", "payment system operator",
                "payment system operators", "payment system provider", "payment system providers",
                "payment aggregators", "payment gateways"},
    "intermediary": {"intermediary", "intermediaries", "market intermediary"},
    # Healthcare and general-industry families. Their absence is why a hospital
    # matched nothing: "Private company limited by shares" is a corporate form,
    # not a regulated-entity type, so _families() returned an empty set and
    # every verdict fell through to "could not be matched to a known family".
    "hospital": {"hospital", "hospitals", "clinical establishment", "clinical establishments",
                 "nursing home", "nursing homes", "health care facility", "healthcare facility",
                 "health care facilities", "healthcare facilities", "healthcare & hospitals",
                 "health care establishment", "health care establishments",
                 "medical establishment", "medical establishments",
                 "healthcare and hospitals", "dispensary", "dispensaries"},
    "laboratory": {"laboratory", "laboratories", "diagnostic centre", "diagnostic center",
                   "diagnostic centres", "diagnostic laboratory", "clinical laboratory",
                   "medical laboratory", "pathology laboratory", "diagnostics",
                   "diagnostics & laboratory", "diagnostics and laboratory", "nabl"},
    "blood centre": {"blood bank", "blood banks", "blood centre", "blood center",
                     "blood centres", "blood storage centre"},
    "pharmacy": {"pharmacy", "pharmacies", "chemist", "chemists", "druggist", "druggists",
                 "retail pharmacy", "drug licence", "drug license"},
    "genetic clinic": {"genetic counselling centre", "genetic clinic", "genetic laboratory",
                       "genetic clinics", "genetic counselling centres", "genetic laboratories",
                       "imaging centre", "imaging centres", "ultrasound clinic", "ultrasound clinics",
                       "pndt", "pcpndt", "pndt registration"},
    "manufacturer": {"manufacturer", "manufacturers", "importer", "importers"},
    # Specialised facility types, added 2026-09-29. Each is a longer phrase that
    # CONTAINS a generic one — "ayush hospitals" contains "hospitals", "dental
    # clinics" contains "clinics" — so without their own family they resolved to
    # the generic family and every NABH standard written for them came back as
    # applicable to this hospital. The longest-span rule below does the rest.
    "ayush": {"ayush hospital", "ayush hospitals", "ayush centre", "ayush centres",
              "ayush treatment and wellness centre", "ayush treatment and wellness centres",
              "ayurveda hospital", "ayurveda hospitals", "entry level ayush hospital",
              "entry level ayush centre"},
    "dental": {"dental clinic", "dental clinics", "dental healthcare service provider",
               "dental healthcare service providers", "dental hospital", "dental hospitals"},
    "care home": {"care home", "care homes"},
    "primary health centre": {"primary health centre", "primary health centres", "phc"},
    "eye care": {"eye care organisation", "eye care organisations",
                 "eye care organization", "eye care organizations"},
    "travel facilitator": {"medical value travel facilitator",
                           "medical value travel facilitators"},
    # A stroke centre is a certification a hospital opts into, not a hospital.
    # Its own family, so a hospital without that certification is not bound by
    # the stroke-centre standard — the same reasoning as eye care above.
    "stroke centre": {"stroke centre", "stroke centres", "stroke center", "stroke centers"},
    # "Occupier" is whoever occupies the premises THAT ACT governs, and in this
    # corpus that is overwhelmingly a factory or an electrical installation:
    # mapping a fire NOC here gave a hospital the Atomic Energy (Factories)
    # Rules and the CEA electricity regulations — 8,741 duties, 47% of
    # everything that reached it, from one certificate.
    "occupier": {"occupier", "occupiers", "factory", "factories"},
    # What a fire NOC actually establishes: we own or occupy a building. Only
    # instruments that address the party in those words match.
    "building occupier": {"fire noc", "fire safety certificate", "fire licence",
                          "fire license", "building owner", "building owners",
                          "owners or occupiers"},
    "employer": {"employer", "employers"},
    # Financial types that were in APPLICABILITY_VOCAB from the start but had
    # no family here. A rule whose entity_type resolves to no family is skipped
    # by evaluate() ("if not fam: continue"), so these produced findings that
    # could never reach a verdict — an HFC would not have matched its own
    # regulations either. Found by the invariant test, not by the symptom.
    "hfc": {"housing finance company", "housing finance companies", "hfc", "hfcs"},
    "arc": {"asset reconstruction company", "asset reconstruction companies", "arc", "arcs"},
    "cic": {"credit information company", "credit information companies", "cic", "cics"},
    "financial institution": {"financial institution", "financial institutions",
                              "all india financial institution", "all india financial institutions"},
    "authorised person": {"authorised person", "authorised persons", "authorized person",
                          "authorized persons", "authorised dealer", "authorised dealers"},
    # healthcare roles that carry duties in their own right
    "practitioner": {"medical practitioner", "medical practitioners", "practitioner",
                     "practitioners", "registered medical practitioner",
                     "registered medical practitioners"},
    "licensee": {"licensee", "licensees"},
    "radiation": {"radiation installation", "radiation installations",
                  "radiological installation", "radiological installations",
                  "radiological safety officer", "radiological safety officers", "aerb"},
    "waste generator": {"waste generator", "waste generators", "occupier of a health care facility",
                        "bio-medical waste", "biomedical waste"},
    # Families added 2026-09-26 so the licences this hospital actually holds are
    # not inert. Each set holds BOTH the regulator's word for the party and the
    # name the licence goes by on our own certificate register, because the same
    # vocabulary matches a regulation's addressee and a company's fact.
    "data fiduciary": {"data fiduciary", "data fiduciaries", "significant data fiduciary",
                       "significant data fiduciaries", "data processor", "data processors"},
    "food business operator": {"food business operator", "food business operators", "fbo",
                               "food licence", "food license", "fssai",
                               "food safety licence", "food safety license",
                               "eating house licence", "eating house license"},
    "approved place": {"approved place", "approved places", "mtp licence", "mtp license",
                       "mtp registration", "medical termination of pregnancy"},
    # Two different parties under the same Act, kept apart on purpose. A hospital
    # that engages contract labour is the PRINCIPAL EMPLOYER; the contractor is
    # the firm it engages. Merging them handed this hospital 42 regulations
    # addressed to contractors — somebody else's rulebook.
    "principal employer": {"principal employer", "principal employers",
                           "labour licence", "labour license",
                           "contract labour licence", "contract labour license"},
    "contractor": {"contractor", "contractors", "contracting agency", "contracting agencies"},
}

# "Regulated Entities" is a catch-all a regulator uses to mean everyone it
# supervises. It is a weaker signal than a named entity type and is scored as such.
UMBRELLA = {"regulated entity"}


def _norm(s: str | None) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()


def company_entity_families(facts: dict) -> tuple[set[str], dict[str, str]]:
    """
    What the company IS, for entity-type matching — and where each answer came from.

    entity_type alone was never enough. A hospital's entity_type is "Private
    company limited by shares": a corporate form, not a regulated-entity type.
    It matches no family, so company_families was empty for every regulation in
    the corpus and every verdict came back REVIEW_REQUIRED with the reason
    "The company's entity type could not be matched to a known family."

    What actually decides whether a healthcare instrument binds this company is
    the sectors it operates in and the licences it holds — both already on the
    profile, both previously unread by this check. The origin of each family is
    returned alongside it so the verdict can cite the field it rests on rather
    than asserting a match the reader cannot trace.
    """
    out: set[str] = set()
    origin: dict[str, str] = {}

    def take(value, label):
        for fam in _families(value):
            out.add(fam)
            origin.setdefault(fam, f'{label} "{value}"')

    take(facts.get("entityType"), "entity type")
    # Kept apart from entity_type since the setup form split them; still read,
    # so a family the corporate form used to match is matched still.
    take(facts.get("legalForm"), "legal form")
    for sec in facts.get("sectors") or []:
        take(sec, "sector")
    for lic in facts.get("licences") or []:
        take(lic, "licence")

    # A company with staff is an employer, whatever else it is. Labour law says
    # so in those words — the Code on Wages addresses "every employer" — and
    # none of the fields above ever contain the word, so `The Code on Wages,
    # 2019` was reported NOT_APPLICABLE to a hospital with 413 employees on the
    # profile. The count is the evidence, so the count is what gets cited.
    # A company that records personal data is a data fiduciary under the DPDP
    # Act whatever else it is, and a hospital holds patient records. The flag is
    # on the profile; without this nothing on the profile ever says the words.
    if facts.get("handlesPersonalData"):
        out.add("data fiduciary")
        origin.setdefault("data fiduciary", "profile fact: handles personal data")

    staff = facts.get("employees")
    try:
        staff = int(float(str(staff).replace(",", "").strip())) if staff not in (None, "") else 0
    except (TypeError, ValueError):
        staff = 0
    if staff > 0:
        out.add("employer")
        origin.setdefault("employer", f"employee count {staff:,}")

    return out, origin


def _families(text: str | None) -> set[str]:
    """
    Which entity families a phrase belongs to.

    Matched on word boundaries, not substrings. Plain `in` was catastrophically
    wrong here: the abbreviation "re" for Regulated Entity is a substring of
    "Asset REconstruction Companies", "aREa" and "REgional", so three entity
    types that have nothing to do with each other were all being classed as the
    same family — and an applicability verdict built on that would be wrong in a
    way nobody could see.
    """
    t = _norm(text)
    if not t:
        return set()

    hits: list[tuple[int, int, str]] = []
    for family, words in ENTITY_SYNONYMS.items():
        for w in words:
            for m in re.finditer(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", t):
                hits.append((m.start(), m.end(), family))

    # The longest phrase wins the span it covers. Without this a "Blood Bank"
    # is a BANK: the word is right there, with clean boundaries on both sides,
    # and the hospital that holds a blood centre licence would be handed every
    # RBI banking regulation as applicable. Boundary matching alone does not
    # save you from a term that legitimately contains another term.
    out = set()
    for start, end, family in hits:
        covered = any(s <= start and end <= e and (e - s) > (end - start)
                      for s, e, _ in hits)
        if not covered:
            out.add(family)
    return out


# Dates arrive as the source wrote them — "25 February 2016" as often as ISO.
# "Dec 30, 2025" is how most issue dates are stored, and it was missing: 22,390
# regulations read "the recorded date could not be read" for want of "%b %d, %Y".
_DATE_FORMATS = ("%Y-%m-%d", "%d %B %Y", "%d %b %Y", "%B %d, %Y", "%b %d, %Y", "%b %d %Y",
                 "%d %b, %Y", "%d-%b-%Y", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y")


def _parse_date(raw) -> date | None:
    txt = str(raw or "").strip()
    if not txt:
        return None
    try:
        return datetime.fromisoformat(txt[:10]).date()
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(txt, fmt).date()
        except ValueError:
            continue
    return None


def _jlist(raw) -> list[str]:
    if isinstance(raw, list):
        return [str(x) for x in raw]
    try:
        v = json.loads(raw or "[]")
        return [str(x) for x in v] if isinstance(v, list) else []
    except (TypeError, ValueError):
        return []


# A record that says what the company is licensed to do. The register a hospital
# ingests calls them License, Certificate, Registration, NOC — the word varies by
# source, the meaning does not.
_LICENCE_TYPE = re.compile(
    r"^(licen[cs]e|certificate|registration|permit|authorisation|authorization|"
    r"noc|accreditation)s?$", re.I)


def licence_records(con) -> list[str]:
    """
    The licences the company holds according to the records it has collected.

    A licence decides which regulations reach a company, and it can arrive two
    ways: typed into Company Setup, or ingested as a certificate register. This
    read only the profile field until 2026-09-26 — so a hospital that had
    ingested its clinical establishment registration, drug licence and PCPNDT
    registration still matched no entity family, and all 1,144 regulations
    carrying requirements came back REVIEW_REQUIRED.

    Expiry is deliberately ignored. Applicability is about what the company IS:
    a lapsed drug licence does not put a pharmacy outside the drug rules, it
    makes it non-compliant with them, and compliance is decided elsewhere.
    """
    try:
        rows = con.execute(
            "SELECT DISTINCT name, type FROM company_entities "
            "WHERE name IS NOT NULL AND type IS NOT NULL").fetchall()
    except Exception:                         # a database without the table yet
        return []
    out: list[str] = []
    for row in rows:
        name, typ = ((row["name"], row["type"]) if hasattr(row, "keys")
                     else (row[0], row[1]))
        if _LICENCE_TYPE.match(str(typ).strip()) and str(name).strip():
            out.append(str(name).strip())
    return out


def _merge_licences(*lists) -> list[str]:
    """Every licence once, in the order it was first seen."""
    seen, out = set(), []
    for lst in lists:
        for v in lst or []:
            k = _norm(v)
            if k and k not in seen:
                seen.add(k)
                out.append(v)
    return out


def company_facts(con) -> dict:
    """The company profile, as the facts an applicability check can use."""
    r = con.execute("SELECT * FROM company_profile ORDER BY id LIMIT 1").fetchone()
    if not r:
        return {}
    d = dict(r)
    return {
        "legalName": d.get("legal_name"),
        "entityType": d.get("entity_type"),
        "legalForm": d.get("legal_form"),
        "jurisdictions": _jlist(d.get("jurisdictions")),
        "sectors": _jlist(d.get("sectors")),
        # Typed into Company Setup AND collected as records — both are the
        # company's licences, and a verdict may rest on either.
        "licences": _merge_licences(_jlist(d.get("licences")), licence_records(con)),
        "employees": d.get("employees"),
        "turnoverCr": d.get("turnover_cr"),
        "beds": d.get("beds"),
        "customers": d.get("customers"),
        "listed": bool(d.get("listed")),
        "handlesPersonalData": bool(d.get("handles_personal_data")),
        "hqState": d.get("hq_state"),
    }


def _article(word: str) -> str:
    """"an employer", "a hospital" — the verdict is read by people."""
    return "an" if (word or "")[:1].lower() in "aeiou" else "a"


def _clause_text(excerpt: str | None) -> str | None:
    """
    The words the verdict rests on.

    A citation of "Section 2" is not a justification — a compliance officer has
    to defend the answer to an auditor, and cannot do that from a label. So the
    excerpt the extractor captured is returned alongside the label.

    It is deliberately NOT widened to the whole stored section. section_number
    is not unique in these documents: "Section 2" matches a dozen rows, and
    picking one that merely contains the phrase produced a citation pointing at
    the definition of "Control" to justify an NBFC entity match. A quote that
    looks authoritative and does not support the verdict is worse than none.
    The excerpt is the text that actually produced the match.
    """
    return re.sub(r"\s+", " ", excerpt).strip()[:1200] if excerpt else None


def _shows(rule: dict | None) -> bool:
    """Does this rule's excerpt actually contain the entity type it claims?"""
    if not rule:
        return False
    return (rule.get("entity_type") or "").lower() in (rule.get("applicability_rule") or "").lower()


def _check(name: str, result: str, expected, found, detail: str, clause: str | None = None,
           clause_text: str | None = None, quoted: str | None = None) -> dict:
    return {"name": name, "result": result, "expected": expected,
            "found": found, "detail": detail, "sourceClause": clause,
            # The source text, and the exact phrase inside it that was compared.
            "clauseText": clause_text, "quoted": quoted}


# ---- how much each check is worth ------------------------------------------
# The seven checks are not equal, and the screen used to say they were: "3 of 7
# checks match" gave a Sector tick the same weight as the Entity type tick that
# actually decides. Two kinds of check:
#
#   GATE     any one of these saying "no" rules the regulation out on its own
#   SUPPORT  can add confidence, can never decide anything
#
# The VERDICT never adds these numbers up. A sum would let five small matches
# outvote one jurisdiction mismatch, so the verdict stays a ladder of gates (see
# evaluate()). The weights only measure how much of the case for "this reaches
# us" is established: they feed the evidence bar on the page and the confidence
# label. They are starting values, to be agreed with the compliance lead.
GATE, SUPPORT = "gate", "support"
WEIGHTS: dict[str, tuple[float, str]] = {
    "Entity type": (35, GATE),
    "Jurisdiction": (20, GATE),
    "In force": (15, GATE),
    "Thresholds": (10, GATE),
    "Exemptions": (10, GATE),
    "Regulator licence": (5, SUPPORT),
    "Sector": (5, SUPPORT),
}
# A check whose input was never extracted is not "unknown", it was never run.
NOT_EXTRACTED = "not extracted"


def _licence_origin(entity: dict) -> str | None:
    """The licence an Entity-type match rests on, if a licence is all it rests on."""
    if entity.get("result") != MATCH:
        return None
    origin = str(entity.get("origin") or "")
    return origin if origin.startswith("licence") else None


def _derived_origin(entity: dict) -> str | None:
    """
    The company fact an Entity-type match rests on, when it is not the company's
    own declared type: a sector, a licence, the employee count, a profile flag.
    Such a match says "this reaches businesses like yours", not "this is you":
    the dry run turned "Honey Grading and Marking Rules" and an M.Pharm syllabus
    green for a hospital through its Laboratory and Pharmacy sectors.
    """
    if entity.get("result") != MATCH:
        return None
    origin = str(entity.get("origin") or "")
    return None if (not origin or origin.startswith(("entity type", "legal form"))) else origin


def weigh(checks: list[dict]) -> dict:
    """
    Give every check its weight and add up the evidence. Mutates the checks
    (weight, tier, counts, and weightNote where the weight was reduced) so each
    row on the page can say what it is worth.

    Two reductions, both about one fact being worth less than it looks:
      * An entity type that comes only from a licence counts half. A hospital
        kitchen's FSSAI licence makes the hospital a "food business operator",
        but the Food Recall rules are written for manufacturers and importers:
        the match is real, the reach is not proven.
      * The regulator-licence check counts nothing when that same licence
        already decided the entity type. One certificate, one tick.
    What a reduction takes off stays "to confirm", so the three parts always
    add up to 100.
    """
    entity = next((c for c in checks if c["name"] == "Entity type"), {})
    lic = _licence_origin(entity)
    confirmed = open_ = against = 0.0
    gates = {"met": 0, "total": 0}
    support = {"met": 0, "total": 0}
    not_checked: list[str] = []
    for c in checks:
        full, tier = WEIGHTS.get(c["name"], (0, SUPPORT))
        counts, note = float(full), None
        if c is entity and lic:
            counts = full / 2
            note = (f"Counts half: the company is this type only through its {lic}, "
                    "not by what it is. Confirm the regulation is written for businesses like this one.")
        elif c["name"] == "In force" and c.get("inferred") and c["result"] == MATCH:
            counts = full * 2 / 3
            note = (f"Counts {full * 2 / 3:g} of {full:g}: the text states no commencement, "
                    "so the date is taken from its publication.")
        elif (c["name"] == "Regulator licence" and lic and c["result"] == MATCH
              and str(c.get("expected") or "").strip().lower() in lic.lower()):
            counts = 0.0
            note = "Not counted again: the same licence already decided the entity type."
        c["weight"], c["tier"], c["counts"] = full, tier, counts
        if note:
            c["weightNote"] = note
        if c["result"] == MATCH:
            confirmed += counts
            open_ += full - counts
        elif c["result"] == NO_MATCH:
            against += full
        else:
            open_ += full
        group = gates if tier == GATE else support
        group["total"] += 1
        group["met"] += c["result"] == MATCH
        if c.get("expected") == NOT_EXTRACTED:
            not_checked.append(c["name"])
    return {
        "confirmed": round(confirmed, 1), "open": round(open_, 1), "against": round(against, 1),
        "total": round(confirmed + open_ + against, 1),
        "gates": gates, "support": support, "notChecked": not_checked,
        "method": "weighted evidence; the verdict itself is decided by the gates, never by this sum",
    }


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _confidence(verdict: str, decider: dict | None, strength: dict) -> str:
    """
    How far the verdict can be relied on, from what was actually established.

    It used to count matches, so a Sector tick lifted confidence as much as an
    Entity type tick. Now:
      * a "no" rests on the one gate that decided it. An explicit statement
        (the title says draft, the regulation excludes this type by name, the
        corpus records it as made for other states) is High; an inference from
        the vocabulary or from a model-extracted threshold is Medium.
      * a "yes" rests on the weighted evidence. Conditional stays capped at
        Medium, because exemptions and thresholds were never evaluated.
    """
    if verdict == REVIEW_REQUIRED:
        return "Low"
    if verdict == NOT_APPLICABLE:
        return "High" if decider and decider.get("explicit") else "Medium"
    have = strength["confirmed"]
    if verdict == CONDITIONAL:
        return "Medium" if have >= 50 else "Low"
    return "High" if have >= 80 else "Medium" if have >= 50 else "Low"


# A draft, a bill, a consultation paper: published, but not law. `status` cannot
# tell them apart — it reads "Active" on all 30,100 records — so the title is the
# only signal the corpus carries, and it is the drafter's own word.
_DRAFT_TITLE = re.compile(
    r"(^|\W)(draft|proposed)\W|\bbill\b(?=\s*[,(]|\s+\d{4}|\s*$)|"
    r"consultation paper|discussion paper|"
    r"exposure draft|for public comment", re.I)


def regulation_states(con, rid) -> tuple[set[str], bool]:
    """
    The states an instrument is made for, and whether it covers all of India.

    A state's rules under a central code bind employers IN THAT STATE. Without
    this the engine handed a Telangana hospital the Rajasthan, Tripura and
    Lakshadweep occupational-safety rules, because every one of them is an
    Indian instrument addressing employers.
    """
    if not rid:
        return set(), False
    try:
        rows = con.execute(
            "SELECT state_ut, coverage FROM regulation_regions WHERE regulation_id = ?",
            (rid,)).fetchall()
    except Exception:
        return set(), False
    states, all_india = set(), False
    for row in rows:
        st, cov = ((row["state_ut"], row["coverage"]) if hasattr(row, "keys")
                   else (row[0], row[1]))
        if (cov or "").upper() == "ALL_INDIA":
            all_india = True
        elif st:
            states.add(st)
    return states, all_india


def company_states(facts: dict) -> set[str]:
    """Where the company actually operates — its HQ state and any it recorded."""
    raw = [facts.get("hqState"), *(facts.get("jurisdictions") or [])]
    return {_norm(v) for v in raw if v and _norm(v) not in ("", "india")}


# ---- reading the regulation's own text ----------------------------------------
# "Not mentioned" means two different things, and the engine used to treat them
# as one: we READ the text and it says nothing (that is evidence), or we never
# read it (that is not). Every check below that relies on the text first asks
# whether the text was actually there.
READ_MIN_CHARS = 500          # below this the text is a stub, not a document
HEAD_SECTIONS = 6             # commencement lives in the opening sections


def regulation_text(con, rid) -> tuple[str, str, int]:
    """(opening sections, full text, characters) — empty when the text is not held."""
    if not rid:
        return "", "", 0
    try:
        rows = con.execute(
            "SELECT section_title, section_text FROM sections WHERE regulation_id = ? ORDER BY rowid",
            (rid,)).fetchall()
    except Exception:
        return "", "", 0
    parts = []
    for row in rows:
        title, text = ((row["section_title"], row["section_text"]) if hasattr(row, "keys")
                       else (row[0], row[1]))
        parts.append(f"{title or ''}. {text or ''}")
    full = "\n".join(parts)
    return "\n".join(parts[:HEAD_SECTIONS]), full, len(full)


def _sentence(text: str, at: int, end: int, limit: int = 360) -> str:
    """The sentence around a match, trimmed to something a person can read."""
    start = max(text.rfind(".", 0, at), text.rfind(";", 0, at), text.rfind("\n", 0, at)) + 1
    stops = [i for i in (text.find(".", end), text.find(";", end), text.find("\n", end)) if i != -1]
    stop = min(stops) if stops else len(text)
    return re.sub(r"\s+", " ", text[start:stop]).strip()[:limit]


# Commencement: when the instrument says it starts binding.
_COMMENCES = re.compile(r"\b(?:come|comes)\s+into\s+(?:force|effect|operation)\b([^.;]{0,220})", re.I)
_BY_NOTIFICATION = re.compile(
    r"such\s+date[^.;]{0,90}?government\s+may[^.;]{0,80}?(?:notification|appoint)", re.I)
_AFTER_PUBLICATION = re.compile(
    r"expiry\s+of\s+([a-z0-9-]+(?:\s+[a-z]+)?)\s+(day|month|year)s?\s+from\s+the\s+date\s+of\s+"
    r"(?:its\s+|their\s+|the\s+)?(?:final\s+)?publication", re.I)
_ON_PUBLICATION = re.compile(
    r"date\s+of\s+(?:its\s+|their\s+|the\s+)?(?:final\s+)?publication|immediate\s+effect|"
    r"\bat\s+once\b|\bforthwith\b|date\s+of\s+(?:its\s+|their\s+)?(?:issue|issuance)", re.I)
_SMALL_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
                  "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15,
                  "twenty": 20, "thirty": 30, "forty-five": 45, "sixty": 60, "ninety": 90,
                  "one hundred": 100, "one hundred and eighty": 180}
_MONTH_NAMES = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}
_STATED = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([a-z]+),?\s+((?:19|20)\d{2})\b|"
    r"\b([a-z]+)\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b", re.I)


def _stated_date(text: str) -> date | None:
    for m in _STATED.finditer(text):
        d, mon, y = (m.group(1), m.group(2), m.group(3)) if m.group(1) else (m.group(5), m.group(4), m.group(6))
        month = _MONTH_NAMES.get(mon.lower()) or _MONTH_NAMES.get(
            next((k for k in _MONTH_NAMES if k.startswith(mon.lower()[:3])), ""), 0)
        if month:
            try:
                return date(int(y), month, int(d))
            except ValueError:
                continue
    return None


def _add_period(start: date, amount: int, unit: str) -> date:
    unit = unit.lower()
    if unit == "day":
        from datetime import timedelta
        return start + timedelta(days=amount)
    months = amount * (12 if unit == "year" else 1)
    y, m = divmod(start.month - 1 + months, 12)
    import calendar
    day = min(start.day, calendar.monthrange(start.year + y, m + 1)[1])
    return date(start.year + y, m + 1, day)


def commencement(head: str, issued: date | None) -> dict:
    """
    What the opening of the text says about when it starts binding.
    kind: notification | after | publication | stated | silent
    """
    m = _COMMENCES.search(head or "")
    if not m:
        return {"kind": "silent"}
    tail, quote = m.group(1), _sentence(head, m.start(), m.end())
    if _BY_NOTIFICATION.search(tail):
        return {"kind": "notification", "quote": quote}
    a = _AFTER_PUBLICATION.search(tail)
    if a:
        word = a.group(1).lower().replace("(", "").replace(")", "")
        n = int(word) if word.isdigit() else _SMALL_NUMBERS.get(word)
        when = _add_period(issued, n, a.group(2)) if (issued and n) else None
        return {"kind": "after", "date": when, "quote": quote}
    if _ON_PUBLICATION.search(tail):
        return {"kind": "publication", "date": issued, "quote": quote}
    d = _stated_date(tail)
    if d:
        return {"kind": "stated", "date": d, "quote": quote}
    return {"kind": "silent", "quote": quote}


# Carve-outs: the instrument saying who it does NOT bind.
_CARVE_OUT = re.compile(
    r"\b(?:shall|does|do|will|would)\s+not\s+apply\s+(?:to|in\s+relation\s+to|in\s+respect\s+of)\b|"
    r"\bnothing\s+(?:in|contained\s+in)\s+th(?:is|ese)\b[^.;]{0,90}?\b(?:shall|does|do)\s+apply\s+to\b|"
    r"\b(?:is|are|shall\s+be)\s+(?:hereby\s+)?exempt(?:ed)?\s+from\s+(?:the\s+)?"
    r"(?:provisions|operation|application|requirements)\b|"
    r"\bexempt(?:s|ed)?\b[^.;]{0,90}?\bfrom\s+(?:the\s+)?(?:provisions|operation|application)\s+of\s+th(?:is|ese)\b",
    re.I)


def carve_outs(full: str, company_families: set[str]) -> list[dict]:
    """
    Every carve-out sentence, and whether it can be settled automatically.
      others  it names only entity types the company is not ("shall not apply to banks")
      us      it names a type the company is ("hospitals run by the Government"):
              a person must decide whether the qualifier covers this company
      open    it names no type we can recognise ("cases where…"): a person must read it
    It never concludes the company IS exempt: that is a judgement on the qualifier.
    """
    out, seen = [], set()
    for m in _CARVE_OUT.finditer(full or ""):
        s = _sentence(full, m.start(), m.end())
        if s in seen:
            continue
        seen.add(s)
        fams = _families(full[m.end():m.end() + 240].split(".")[0]) - UMBRELLA
        kind = "us" if fams & company_families else "others" if fams else "open"
        out.append({"sentence": s, "families": sorted(fams), "kind": kind})
    return out


# Size conditions: beds, turnover, headcount, capacity. Read broadly on purpose:
# a false "found" only asks a person to look; a false "none" would be a wrong yes.
_NUM = (r"(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|"
        r"twenty|twenty-five|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)")
_UNIT = (r"(?:beds?|bedded|crores?|lakhs?|employees?|workers?|workmen|persons?|staff|members|"
         r"turnover|tonnes?|tons?|kilo\s*litres?|kld|kw|mw|kva|square\s+met(?:re|er)s?|sq\.?\s*m|patients)")
_THRESHOLD = re.compile(
    r"\b(?:not\s+less\s+than|not\s+more\s+than|not\s+exceeding|more\s+than|less\s+than|fewer\s+than|"
    r"exceed(?:s|ing)?|above|below|up\s*to|at\s+least|minimum\s+of|maximum\s+of)\s+"
    rf"(?:rs\.?\s*|₹\s*|inr\s*)?{_NUM}(?:\s+[a-z]+){{0,2}}?\s+{_UNIT}\b|"
    rf"\b{_NUM}\s+(?:or\s+more|and\s+above|or\s+above)(?:\s+[a-z]+)?\s+{_UNIT}\b|"
    rf"\b(?:employ(?:s|ing|ed)?|engag(?:es|ing|ed))\s+(?:[a-z]+\s+){{0,2}}?{_NUM}\s+(?:or\s+more\s+)?"
    r"(?:persons?|workers?|employees?|workmen)\b", re.I)
_PENAL = re.compile(r"fine|penalt|punish|imprison|fee\b|fees\b|compensation|deposit", re.I)


def size_conditions(full: str) -> list[str]:
    """Sentences that set a size, turnover or headcount condition. Fines are not conditions."""
    out = []
    for m in _THRESHOLD.finditer(full or ""):
        if _PENAL.search(full[max(0, m.start() - 70):m.start()]):
            continue
        s = _sentence(full, m.start(), m.end())
        if s not in out:
            out.append(s)
        if len(out) >= 5:
            break
    return out


def evaluate(con, regulation: dict, rules: list[dict], facts: dict) -> dict:
    """
    Run every check and combine them into one defensible verdict.
    """
    checks: list[dict] = []

    # ---- entity type -------------------------------------------------------
    # entity_type, sectors and licences together — see company_families().
    company_families, family_origin = company_entity_families(facts)
    rule_families: set[str] = set()
    excluded_families: set[str] = set()
    excluded_rule = None
    named_clause = None
    named_rule = None
    umbrella_rule = None
    for r in rules:
        fam = _families(r.get("entity_type"))
        if not fam:
            continue

        # A mention is not applicability. Only rules whose entity type is the
        # ADDRESSEE of the document count towards "the regulation names this
        # type"; a counterparty mention ("loans granted to NBFC borrowers") is
        # evidence about somebody else's duty and is deliberately ignored here.
        # Rules written before the role test have role NULL and are skipped
        # rather than trusted — an unclassified rule is not a finding.
        role = (r.get("role") or "").upper()
        if role == "EXCLUDED":
            excluded_families |= fam
            if excluded_rule is None:
                excluded_rule = r
            continue
        if not role.startswith("ADDRESSEE"):
            continue

        rule_families |= fam
        # Prefer the rule that names the company's OWN family — "NBFCs" is a
        # better citation than "Regulated Entities", and it is the one an auditor
        # will ask to see. Among those, prefer one whose excerpt actually SHOWS
        # the words, so the quote can be read rather than taken on trust.
        if company_families & (fam - UMBRELLA):
            shows = (r.get("entity_type") or "").lower() in (r.get("applicability_rule") or "").lower()
            if named_rule is None or (shows and not _shows(named_rule)):
                named_rule, named_clause = r, r.get("source_clause")
        elif fam & UMBRELLA and umbrella_rule is None:
            umbrella_rule = r
    cite = named_rule or umbrella_rule
    cite_text = _clause_text((cite or {}).get("applicability_rule")) if cite else None

    company_desc = facts.get("entityType") or ", ".join(
        (facts.get("sectors") or []) + (facts.get("licences") or [])) or None

    if not company_desc:
        checks.append(_check("Entity type", UNKNOWN, sorted(rule_families) or "—",
                             "not set on the company profile",
                             "Complete Company Setup so entity type, sectors and licences "
                             "can be compared."))
    elif not rule_families and not excluded_families:
        checks.append(_check("Entity type", UNKNOWN, "not stated in the regulation",
                             company_desc,
                             "This regulation does not address any entity type in its scope "
                             "or obligation language. Mentions elsewhere in the text are not "
                             "treated as applicability."))
    elif company_families & (excluded_families - UMBRELLA):
        # The regulation carves this company's type out by name. That is a
        # stronger statement than any incidental match elsewhere in the text.
        checks.append({**_check("Entity type", NO_MATCH, sorted(rule_families) or "—",
                                company_desc,
                                "The regulation expressly excludes this company's entity type.",
                                (excluded_rule or {}).get("source_clause"),
                                _clause_text((excluded_rule or {}).get("applicability_rule")),
                                (excluded_rule or {}).get("entity_type")),
                       "explicit": True})
    else:
        overlap = company_families & rule_families
        strong = overlap - UMBRELLA
        if strong:
            fam = sorted(strong)[0]
            check = _check("Entity type", MATCH, sorted(rule_families),
                           company_desc,
                           f"The company is {_article(fam)} {fam} — "
                           f"from its {family_origin.get(fam, 'profile')} "
                           f"— and the regulation names that type.",
                           named_clause, cite_text,
                           (named_rule or {}).get("entity_type"))
            # The company fact that pulled this regulation in, kept as data and
            # not only inside the sentence: a screen answering "which of our
            # licences brings this on us" must not have to parse English.
            check["origin"] = family_origin.get(fam)
            check["family"] = fam
            checks.append(check)
        elif overlap:
            checks.append(_check("Entity type", MATCH, sorted(rule_families),
                                 company_desc,
                                 "The regulation addresses 'Regulated Entities' generally, which covers this company.",
                                 (umbrella_rule or {}).get("source_clause") or named_clause,
                                 cite_text, (umbrella_rule or {}).get("entity_type")))
        elif company_families:
            checks.append(_check("Entity type", NO_MATCH, sorted(rule_families),
                                 company_desc,
                                 f"The regulation names entity types this company is not one of "
                                 f"(the company is: {', '.join(sorted(company_families))})."))
        else:
            checks.append(_check("Entity type", UNKNOWN, sorted(rule_families),
                                 company_desc,
                                 "Nothing on the company profile — entity type, sectors or "
                                 "licences — matches a known entity family, so this check "
                                 "cannot be decided either way."))

    # ---- jurisdiction ------------------------------------------------------
    reg_j = _norm(regulation.get("jurisdiction"))
    comp_j = [_norm(j) for j in facts.get("jurisdictions", [])]
    made_for, all_india = regulation_states(con, regulation.get("id"))
    here = company_states(facts)
    if made_for and not all_india and here and not ({_norm(s) for s in made_for} & here):
        # Made for other states only. This is the one geographic statement the
        # corpus records precisely, so it is a NO_MATCH rather than a doubt.
        checks.append({**_check(
            "Jurisdiction", NO_MATCH, sorted(made_for), sorted(here),
            f"This instrument is made for {', '.join(sorted(made_for))}. The company "
            f"operates in {', '.join(sorted(here))} and has no presence recorded there."),
            "explicit": True})
    elif not reg_j:
        checks.append(_check("Jurisdiction", UNKNOWN, "not stated", comp_j or "—",
                             "The regulation record carries no jurisdiction."))
    elif not comp_j:
        checks.append(_check("Jurisdiction", UNKNOWN, regulation.get("jurisdiction"), "—",
                             "No jurisdictions recorded for the company."))
    else:
        hit = any(reg_j in c or c in reg_j or "india" in c and "india" in reg_j for c in comp_j)
        checks.append(_check("Jurisdiction", MATCH if hit else NO_MATCH,
                             regulation.get("jurisdiction"), facts["jurisdictions"],
                             "The company operates in this jurisdiction." if hit
                             else "The company records no presence in this jurisdiction."))

    # ---- regulator / licence ----------------------------------------------
    reg_short = (regulation.get("regulator_short") or "").strip()
    lic = facts.get("licences", [])
    if not reg_short:
        checks.append(_check("Regulator licence", UNKNOWN, "—", lic or "—",
                             "The regulation names no issuing authority."))
    elif not lic:
        checks.append(_check("Regulator licence", UNKNOWN, reg_short, "—",
                             "No licences recorded for the company."))
    else:
        hit = any(reg_short.lower() in l.lower() for l in lic)
        checks.append(_check("Regulator licence", MATCH if hit else UNKNOWN, reg_short, lic,
                             f"The company holds a licence issued by {reg_short}." if hit
                             else f"No {reg_short} licence recorded — this does not by itself exclude the regulation."))

    # ---- sector ------------------------------------------------------------
    reg_sec = _norm(regulation.get("sector"))
    comp_sec = [_norm(s) for s in facts.get("sectors", [])]
    if reg_sec and comp_sec:
        hit = any(reg_sec in c or c in reg_sec for c in comp_sec)
        checks.append(_check("Sector", MATCH if hit else UNKNOWN,
                             regulation.get("sector"), facts["sectors"],
                             "The company operates in this sector." if hit
                             else "Sector does not overlap — treated as inconclusive, not exclusionary."))
    else:
        checks.append(_check("Sector", UNKNOWN, regulation.get("sector") or "not stated",
                             facts.get("sectors") or "—", "Sector could not be compared."))

    # ---- effective period --------------------------------------------------
    # The text is read once and shared by in-force, exemptions and thresholds.
    head, full, text_chars = regulation_text(con, regulation.get("id"))
    text_read = text_chars >= READ_MIN_CHARS
    eff = regulation.get("effective_from")
    issued = _parse_date(regulation.get("issued_on"))
    if _DRAFT_TITLE.search(regulation.get("title") or ""):
        # Half of everything the engine reported as reaching this company was a
        # draft. A draft creates no duty until it is notified: it belongs on a
        # watch list, not on a compliance list.
        checks.append({**_check(
            "In force", NO_MATCH, "in force", "draft",
            "The title marks this a draft, bill or consultation paper. It creates no "
            "obligation until it is notified — worth watching, not complying with."),
            "explicit": True})
    elif eff:
        # The instrument's own commencement date, extracted earlier.
        d = _parse_date(eff)
        if d is None:
            checks.append(_check("In force", UNKNOWN, str(eff), "—",
                                 "The recorded date could not be read."))
        else:
            live = d <= date.today()
            checks.append(_check("In force", MATCH if live else UNKNOWN, d.isoformat(),
                                 "today" if live else "future",
                                 "In force today." if live else f"Not in force until {d.isoformat()}."))
    else:
        # No commencement date on the record: read what the text says, then fall
        # back to the publication date, then to "not known". Never a guess.
        c = commencement(head, issued)
        quote = c.get("quote")
        when = c.get("date")
        if c["kind"] == "notification":
            checks.append(_check(
                "In force", UNKNOWN, "a date the government notifies", "notification not found",
                "The text says it comes into force on a date the government appoints by "
                "notification. That notification is not in the library, so the start date is "
                "not known.", clause_text=quote))
        elif c["kind"] in ("after", "publication", "stated") and when:
            live = when <= date.today()
            how = {"after": "a fixed period after its publication",
                   "publication": "on its publication",
                   "stated": "on the date it names"}[c["kind"]]
            checks.append(_check(
                "In force", MATCH if live else UNKNOWN, when.isoformat(), "today" if live else "future",
                (f"The text says it comes into force {how}: in force since {when.isoformat()}."
                 if live else f"The text says it comes into force {how}: not until {when.isoformat()}."),
                clause_text=quote))
        elif c["kind"] in ("after", "publication"):
            checks.append(_check(
                "In force", UNKNOWN, "publication date", "—",
                "The text says it comes into force on publication, but the publication date is "
                "not recorded.", clause_text=quote))
        elif issued:
            # Silent text, known publication date: the legal default. A Central Act
            # with no date commences on assent (General Clauses Act, s.5); rules
            # and notifications commence on publication in the Gazette.
            live = issued <= date.today()
            check = _check(
                "In force", MATCH if live else UNKNOWN, issued.isoformat(),
                "inferred" if live else "future",
                (f"The text states no commencement, so it is taken as in force from its "
                 f"publication on {issued.isoformat()}. Confirm against the gazette."
                 if live else f"Published with a future date: not before {issued.isoformat()}."))
            if live:
                check["inferred"] = True
            checks.append(check)
        else:
            checks.append(_check("In force", UNKNOWN, "—", "—",
                                 "No effective or issue date recorded, and the text states no "
                                 "commencement."))

    # ---- exemptions — read from the full text -------------------------------
    # Silence in a text we actually read is evidence: a regulation binds everyone
    # in its scope unless it carves somebody out, and a carve-out has to be
    # written down. Silence in a text we do not hold is not.
    if company_families & (excluded_families - UMBRELLA):
        checks.append({**_check(
            "Exemptions", NO_MATCH, "carve-outs in the text", company_desc,
            "The regulation carves this company's entity type out by name.",
            (excluded_rule or {}).get("source_clause"),
            _clause_text((excluded_rule or {}).get("applicability_rule")),
            (excluded_rule or {}).get("entity_type")), "explicit": True})
    elif not text_read:
        checks.append(_check(
            "Exemptions", UNKNOWN, NOT_EXTRACTED, "—",
            "The regulation's text is not held, so it could not be read for exemptions. "
            "Any exemption must be confirmed against the source."))
    else:
        found = carve_outs(full, company_families)
        unsettled = [f for f in found if f["kind"] != "others"]
        if not found:
            checks.append(_check(
                "Exemptions", MATCH, "carve-outs in the text", "none",
                "The full text was read and carves nobody out. An exemption granted by a "
                "separate government notification would not appear here."))
        elif not unsettled:
            names = sorted({fam for f in found for fam in f["families"]})
            checks.append(_check(
                "Exemptions", MATCH, "carve-outs in the text", names,
                f"The text exempts only {', '.join(names)}, which this company is not.",
                clause_text=found[0]["sentence"]))
        else:
            first = unsettled[0]
            why = ("names businesses like this one, so whether its conditions cover this "
                   "company needs a person" if first["kind"] == "us"
                   else "could not be matched to an entity type, so a person must read it")
            checks.append(_check(
                "Exemptions", UNKNOWN, "carve-outs in the text",
                f"{len(unsettled)} to confirm",
                f"The text has {len(found)} exemption clause{'s' if len(found) != 1 else ''}. "
                f"The first one to check {why}.",
                clause_text=first["sentence"]))

    # ---- thresholds — evaluated from extracted predicates (conditions.py) ---
    # The predicates are extracted by the conditions layer (LLM) in a separate
    # pass and stored on applicability_rules.thresholds. Here we only READ and
    # COMPARE them to the company's facts — deterministic, no model in this path.
    from . import conditions as _cond
    _applies, _excludes = [], []
    for _row in _cond._rows(con, "SELECT thresholds FROM applicability_rules "
                                 "WHERE regulation_id=? AND thresholds IS NOT NULL",
                            (regulation.get("id"),)):
        try:
            _t = json.loads(_row["thresholds"] if isinstance(_row, dict) else _row[0])
        except (TypeError, ValueError, KeyError):
            continue
        _applies.extend(_t.get("applies_if") or [])
        _excludes.extend(_t.get("excludes_if") or [])
    if _applies or _excludes:
        _tev = _cond.evaluate({"applies_if": _applies, "excludes_if": _excludes}, facts)
        _tmap = {"APPLICABLE": MATCH, "NOT_APPLICABLE": NO_MATCH,
                 "CONDITIONAL": UNKNOWN, "NO_CONDITIONS": MATCH}
        _tres = _tmap.get(_tev["result"], UNKNOWN)
        _detail = "; ".join(f'{c.get("field")} {c.get("op")} {c.get("value")} '
                            f'vs company {c.get("fact")} → {c.get("outcome")}'
                            for c in _tev.get("checks", [])) or "—"
        _quote = "; ".join(p.get("basis", "") for p in (_applies + _excludes)
                           if p.get("basis"))[:400]
        checks.append(_check(
            "Thresholds", _tres, "size/turnover/employee conditions", _detail,
            ("A size/turnover/employee condition excludes this company."
             if _tres == NO_MATCH else
             "Every extracted size/turnover/employee condition is satisfied."
             if _tres == MATCH else
             "A condition depends on a company fact not yet on the profile."),
            quoted=_quote or None))
    elif not text_read:
        checks.append(_check(
            "Thresholds", UNKNOWN, NOT_EXTRACTED, "—",
            "The regulation's text is not held, so it could not be read for size or "
            "turnover conditions. If it sets one, it must be confirmed by a person.",
        ))
    else:
        # No extracted predicates: read the text for size conditions directly.
        sizes = size_conditions(full)
        if not sizes:
            checks.append(_check(
                "Thresholds", MATCH, "size/turnover/employee conditions", "none",
                "The full text was read and sets no size, turnover or headcount condition."))
        else:
            checks.append(_check(
                "Thresholds", UNKNOWN, "size/turnover/employee conditions",
                f"{len(sizes)} in the text",
                "The text sets a size, turnover or headcount condition that has not been "
                "compared with the company profile.", clause_text=sizes[0]))

    # ---- verdict -----------------------------------------------------------
    entity = next((c for c in checks if c["name"] == "Entity type"), None)
    juris = next((c for c in checks if c["name"] == "Jurisdiction"), None)
    matched = [c for c in checks if c["result"] == MATCH]
    contradicted = [c for c in checks if c["result"] == NO_MATCH]

    # Conditions that must be evaluated before an unqualified "Applicable" can be
    # claimed. Neither is modelled yet, so a positive entity match produces
    # CONDITIONAL rather than APPLICABLE: a green verdict that skipped the
    # threshold test is a stronger claim than the data supports, and it is
    # exactly the claim a compliance officer would be held to.
    mandatory_unevaluated = [c["name"] for c in checks
                             if c["name"] in ("Thresholds", "Exemptions")
                             and c["result"] == UNKNOWN]

    thresh = next((c for c in checks if c["name"] == "Thresholds"), None)
    force = next((c for c in checks if c["name"] == "In force"), None)
    decider = None          # the gate that ruled it out, when one did
    if force and force["result"] == NO_MATCH:
        verdict, why, decider = NOT_APPLICABLE, force["detail"], force
    elif entity and entity["result"] == NO_MATCH:
        verdict, why, decider = NOT_APPLICABLE, "The regulation names entity types this company is not.", entity
    elif juris and juris["result"] == NO_MATCH:
        verdict, why, decider = (NOT_APPLICABLE,
                                 "The company has no presence in the regulation's jurisdiction.", juris)
    elif thresh and thresh["result"] == NO_MATCH:
        decider = thresh
        # A size/turnover/employee condition positively excludes this company —
        # e.g. a "non-bedded facilities" rule against a 250-bed hospital, or a
        # ">250 crore turnover" rule against a 50-crore one. Stronger than a mere
        # entity-family match, so it decides the verdict.
        verdict, why = NOT_APPLICABLE, ("A size/turnover/employee condition excludes this "
                                        "company: " + thresh["detail"])
    elif entity and entity["result"] == MATCH and not contradicted:
        if _derived_origin(entity):
            # "The company holds an FSSAI licence" is not "the company is a food
            # manufacturer", and a Pharmacy sector is not a pharmacy college. Only
            # the company's own type can carry an unqualified yes; anything else
            # is reported as conditional until a person confirms it.
            mandatory_unevaluated.append("Entity type")
        if mandatory_unevaluated:
            verdict = CONDITIONAL
            why = ("The regulation names companies of this kind and nothing rules this company out. "
                   "It is not reported as unqualified until "
                   + _and([n.lower() for n in mandatory_unevaluated])
                   + (" are" if len(mandatory_unevaluated) > 1 else " is")
                   + " confirmed against the source.")
        else:
            verdict, why = APPLICABLE, ("The regulation names companies of this kind, and its full text "
                                        "was read: no exemption and no size condition rules this company out.")
    elif matched:
        verdict, why = REVIEW_REQUIRED, ("Some signals match but entity type could not be confirmed. "
                                         "A human must decide.")
    else:
        verdict, why = REVIEW_REQUIRED, ("Not enough information to decide. This is deliberately not "
                                         "reported as inapplicable.")

    # Confidence comes from what was actually established, weighted: an Entity
    # type match is worth seven Sector matches. See weigh() and _confidence().
    strength = weigh(checks)
    lic = _licence_origin(entity or {})
    derived = _derived_origin(entity or {})
    if lic and verdict in (APPLICABLE, CONDITIONAL):
        why += (f" The entity type rests only on the company's {lic}, so it counts half"
                " until someone confirms the regulation is written for businesses like this one.")
    elif derived and verdict in (APPLICABLE, CONDITIONAL):
        why += (f" The entity type comes from {derived}, not from the company's own type, so "
                "confirm the regulation is written for businesses like this one.")
    confidence = _confidence(verdict, decider, strength)

    return {
        "verdict": verdict,
        "confidence": confidence,
        "why": why,
        "checks": checks,
        "matched": len(matched),
        "contradicted": len(contradicted),
        "unknown": len([c for c in checks if c["result"] == UNKNOWN]),
        "strength": strength,
        "company": facts,
        # Stated so the UI never implies more rigour than was applied.
        "method": "deterministic rule comparison — no model was consulted",
        "limits": [
            "Exemptions and size conditions are read from the regulation's own text; one granted "
            "by a separate government notification is not seen here.",
            "A carve-out that names this kind of company is never settled automatically.",
            "Repeals are not tracked yet, so a repealed instrument can still read as in force.",
        ],
    }
