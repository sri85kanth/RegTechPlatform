"""
Read a folder of documents against a collection context, and return the things
the company actually has.

WHAT REPLACED THE DOMAIN DROPDOWN
---------------------------------
The folder connector asked "which domain does this populate?" and then filed
every document in that one domain by filename. A real folder is not one domain:
"Biomedical Department" holds the equipment register, the calibration SOP, the
AMC contracts, the radiation-safety policy and the people who own each. Picking
"policies" from a list files four of those five wrongly and mines none of them.

So the caller supplies a CONTEXT in its own words — "Biomedical Department" —
and this reads the files against it. The context is not a filter. It is
provenance carried on every record, the tie-break when a document could sit in
two places, and the label under which the whole collection can later be found or
undone.

NO MODEL IS CALLED HERE, AND THAT IS THE HONEST CONSTRAINT
----------------------------------------------------------
There is no language model configured on this deployment. An extractor that
claimed to "understand" these documents would be inventing, so this reads what
the documents literally say:

  - a labelled line ("Document Owner: …", "Vendor: …", "Version: 2.1") is the
    single highest-yield structure in corporate documents, and it is unambiguous;
  - a register is a table, and its rows are records already;
  - a cross-reference ("in accordance with the Information Security Policy") is
    a relationship stated in the text;
  - a document's own type is what its title says it is.

EVERY record carries the file it came from and the phrase that produced it.
Nothing is emitted without one. A record whose evidence you can read is a record
you can argue with; a record without it is a guess wearing a confidence score.

WHEN A MODEL ARRIVES
--------------------
It becomes another producer of the same Record shape, with `method` saying so.
Nothing downstream changes, and a run with the model can be diffed against a run
without it because both kept their evidence.
"""
from __future__ import annotations

import json
import pathlib
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

MAX_TEXT = 400_000           # per document; beyond this the tail is boilerplate
MAX_VALUE = 160              # a captured value longer than this is a paragraph
MIN_NAME = 3
MAX_RECORDS_PER_FILE = 400   # a runaway pattern must not flood the brain


# --------------------------------------------------------------------- model
@dataclass
class Evidence:
    file: str
    phrase: str
    where: str = ""          # sheet, page or section when known

    def as_dict(self) -> dict:
        return {"file": self.file, "phrase": self.phrase[:300], "where": self.where}


@dataclass
class Record:
    kind: str                # person | vendor | policy | process | control | risk | evidence | system | data | document
    name: str
    attrs: dict = field(default_factory=dict)
    evidence: list[Evidence] = field(default_factory=list)
    confidence: int = 60
    method: str = "labelled line"

    @property
    def key(self) -> tuple[str, str]:
        return (self.kind, norm_name(self.name))


@dataclass
class Edge:
    source: str              # record key text
    kind: str                # owned_by | approved_by | supplied_by | references | governed_by
    target: str
    evidence: Evidence
    confidence: int = 60


def norm_name(s: str) -> str:
    s = re.sub(r"\s+", " ", (s or "")).strip().lower()
    s = re.sub(r"^(the|a|an)\s+", "", s)
    return re.sub(r"[^\w\s&/-]", "", s).strip()


# ------------------------------------------------------------------ patterns
# A labelled line is `Label: value`. The label decides both what kind of thing
# the value is and what attribute it fills on the document that stated it.
LABEL = re.compile(
    r"(?im)^[ \t\-\*•]*"
    r"(?P<label>[A-Za-z][A-Za-z /&'\-]{2,40}?)"
    r"\s*[:–—\-]\s*"
    r"(?P<value>[^\r\n]{2,300})$")

# label (lowercased, punctuation stripped) -> (record kind | None, attribute)
# None means "this is an attribute of the document, not a thing in its own right".
LABELS: dict[str, tuple[str | None, str]] = {}
for _labels, _kind, _attr in [
    (["owner", "document owner", "policy owner", "process owner", "control owner",
      "risk owner", "system owner", "data owner", "asset owner", "responsible",
      "responsible person", "accountable", "custodian"], "person", "owner"),
    (["approved by", "approver", "authorised by", "authorized by", "signed off by"], "person", "approver"),
    (["prepared by", "author", "written by", "drafted by"], "person", "author"),
    (["reviewed by", "reviewer", "checked by", "verified by"], "person", "reviewer"),
    (["vendor", "supplier", "service provider", "contractor", "third party",
      "manufacturer", "oem", "outsourced to", "amc vendor", "amc provider"], "vendor", "vendor"),
    (["department", "business unit", "function", "division", "section"], None, "department"),
    (["version", "document version", "revision", "rev", "issue"], None, "version"),
    (["effective date", "effective from", "date of issue", "issue date",
      "date", "valid from"], None, "effectiveDate"),
    (["review date", "next review", "next review date", "due for review"], None, "reviewDate"),
    (["last reviewed", "date reviewed", "last updated", "last revised"], None, "lastReviewed"),
    (["reference", "document number", "document no", "doc id", "policy number",
      "sop number", "reference number"], None, "reference"),
    (["classification", "confidentiality", "sensitivity"], None, "classification"),
    (["frequency", "periodicity", "how often"], None, "frequency"),
    (["retention", "retention period", "retain for"], None, "retention"),
    (["location", "stored at", "stored in", "repository"], None, "location"),
    (["criticality", "severity", "priority", "risk rating", "rating"], None, "criticality"),
    (["status", "state", "approval status"], None, "status"),
    (["contract", "agreement", "contract number", "po number"], None, "contract"),
    (["licence", "license", "licence number", "registration number", "certificate"], None, "licence"),
    (["scope", "applies to", "applicability"], None, "scope"),
    (["purpose", "objective"], None, "purpose"),
]:
    for _l in _labels:
        LABELS[_l] = (_kind, _attr)

# A cross-reference names another instrument. The suffix is what makes it a
# reference rather than a sentence — "in accordance with the plan" names nothing.
REFERENCE = re.compile(
    r"(?i)\b(?:in accordance with|as required (?:by|under)|pursuant to|governed by|"
    r"in line with|as per|as laid down in|refer to|see|under|per)\s+"
    r"(?:the\s+)?(?P<name>[A-Z][A-Za-z0-9&,'()\- ]{5,80}?"
    r"\s(?:Policy|Procedure|Standard|Guideline|Guidelines|Framework|Manual|SOP|"
    r"Act|Rules|Regulations|Regulation|Code|Charter|Directive|Circular))\b")

# Names that are labels rather than people. "Owner: Head of Biomedical" is a
# role and is kept, but "Owner: TBD" is not a person.
NOT_A_VALUE = re.compile(
    r"(?i)^\s*(?:n/?a|na|tbd|tba|nil|none|not applicable|-+|\.+|refer|as above|"
    r"see above|xxx+|\?+)\s*$")

# Words that mean the captured value is a sentence continuing, not a value.
SENTENCE_TAIL = re.compile(r"(?i)\b(?:shall|should|must|will be|is responsible for|means)\b")


def clean_value(v: str) -> str:
    """
    One captured value, with the next label on the same line cut off.

    The cut has to happen BEFORE whitespace is collapsed. "Owner: Priya Sharma
    <tab>Version: 2.1" is one line to the regex, and the run of whitespace is
    the only thing separating the value from the label after it — collapse it
    first and the boundary is gone, so the person is recorded as "Priya Sharma
    Version: 2.1".
    """
    v = v or ""
    for m in re.finditer(r"[ \t]{2,}|\t", v):
        if re.match(r"[A-Z][A-Za-z /&'\-]{1,30}\s*[:\u2013\u2014]", v[m.end():]):
            v = v[:m.start()]
            break
    v = re.sub(r"\s+", " ", v).strip(" \t.;,")
    return v[:MAX_VALUE].strip()


def usable_value(v: str) -> bool:
    """Good enough to store as an attribute. "2.1" and "5 years" qualify."""
    if not v or len(v) < 1 or NOT_A_VALUE.match(v):
        return False
    return not SENTENCE_TAIL.search(v)


def usable(v: str) -> bool:
    """
    Good enough to be the NAME of a record, which is stricter.

    A name needs letters and needs length: "2.1" is a perfectly good version and
    a nonsensical person. Splitting this from usable_value is what stopped the
    extractor dropping every numeric attribute it found.
    """
    if not usable_value(v) or len(v) < MIN_NAME:
        return False
    return bool(re.search(r"[A-Za-z]", v))


# ------------------------------------------------------------------- reading
def read_any(path: pathlib.Path) -> str:
    """Text for any format this system can already open. Unreadable → ''."""
    ext = path.suffix.lower()
    try:
        if ext == ".pdf":
            import sys
            root = str(pathlib.Path(__file__).resolve().parent.parent)
            if root not in sys.path:
                sys.path.insert(0, root)
            import io
            from pypdf import PdfReader
            rd = PdfReader(io.BytesIO(path.read_bytes()))
            return "\n".join((p.extract_text() or "") for p in rd.pages)[:MAX_TEXT]
        import sys
        root = str(pathlib.Path(__file__).resolve().parent.parent)
        if root not in sys.path:
            sys.path.insert(0, root)
        import derive_company_profile as D
        return (D.read_text(path) or "")[:MAX_TEXT]
    except Exception:                      # noqa: BLE001 — an unreadable file is skipped, not fatal
        return ""


# Only the title block, not the whole document. A contract that says "…under
# the Biomedical Equipment Maintenance Policy" in its third line is a contract;
# searching 1,500 characters of body found "policy" and typed it as one. Two
# passes, name first, because what a document calls ITSELF beats what it
# mentions.
TITLE_BLOCK = 400


def document_kind(name: str, text: str) -> tuple[str, int]:
    """What the document says it is. Unclassified when it does not say."""
    from . import documents as DOC
    lname = (name or "").lower()
    for kind, words in DOC.TYPES.items():
        if any(re.search(rf"\b{re.escape(w)}\b", lname) for w in words):
            return kind, 85
    # EARLIEST wins, not first-in-the-dict. The title block of a contract reads
    # "ANNUAL MAINTENANCE CONTRACT … under the Maintenance Policy": both words
    # are present, and iterating TYPES in declaration order returned whichever
    # type happened to be declared first. Position is the signal — a document
    # announces itself at the top and refers to others further down.
    head = (text or "")[:TITLE_BLOCK].lower()
    best: tuple[int, str] | None = None
    for kind, words in DOC.TYPES.items():
        for w in words:
            m = re.search(rf"\b{re.escape(w)}\b", head)
            if m and (best is None or m.start() < best[0]):
                best = (m.start(), kind)
    if best:
        return best[1], 60
    return "Unclassified", 40


# The document type decides which Company Brain domain a mined record belongs
# to. This is the ONE place the mapping lives, so a new document type needs one
# line here rather than a change in three branches of the sync.
KIND_DOMAIN = {
    "person": "people", "vendor": "systems", "policy": "policies",
    "process": "processes", "control": "controls", "risk": "risks",
    "evidence": "evidence", "system": "systems", "data": "data",
}
# documents.TYPES is the vocabulary; this says which Company Brain domain each
# one lands in. A type missing here falls to evidence, which is where an
# unclassified artefact belongs — it is a thing you hold, not a thing you do.
TYPE_DOMAIN = {
    "Policy": "policies",
    "Procedure": "processes",
    "Control Evidence": "evidence",
    "Register": "evidence",
    "Report": "evidence",
    "Minutes": "evidence",
    "Agreement": "systems",          # a contract binds a third party; vendors live here too
    "Filing": "evidence",
    "Unclassified": "evidence",
}


# ---------------------------------------------------------------- extraction
def from_text(text: str, rel: str, *, context: str = "") -> tuple[list[Record], list[Edge]]:
    """
    Mine one document. Returns records and the edges between them.

    The document itself is always the first record — it is the thing that exists
    for certain — and everything else found inside it is attached to that.
    """
    records: list[Record] = []
    edges: list[Edge] = []
    if not (text or "").strip():
        return records, edges

    stem = pathlib.Path(rel).stem.replace("_", " ").replace("-", " ").strip()
    if len(stem) < MIN_NAME:
        stem = pathlib.Path(rel).name          # "a.docx" is a worse name than nothing, but it is real
    dtype, dconf = document_kind(stem, text)
    doc = Record(kind="document", name=stem, confidence=dconf, method="document title",
                 attrs={"documentType": dtype, "file": rel,
                        "format": pathlib.Path(rel).suffix.lstrip(".").lower()},
                 evidence=[Evidence(rel, stem)])
    if context:
        doc.attrs["collectionContext"] = context
    records.append(doc)

    seen_labels: set[tuple[str, str]] = set()
    for m in LABEL.finditer(text):
        if len(records) >= MAX_RECORDS_PER_FILE:
            break
        label = re.sub(r"[^a-z ]", "", m.group("label").lower()).strip()
        spec = LABELS.get(label)
        if not spec:
            continue
        value = clean_value(m.group("value"))
        if not usable_value(value):
            continue
        kind, attr = spec
        phrase = re.sub(r"\s+", " ", m.group(0)).strip()

        # Every labelled line becomes an attribute of the document that stated
        # it — including the ones that also become records of their own, so the
        # document keeps its owner even after the owner exists separately.
        if (label, value) not in seen_labels:
            seen_labels.add((label, value))
            doc.attrs.setdefault(attr, value)
            doc.evidence.append(Evidence(rel, phrase))

        if kind:
            for part in split_people(value) if kind == "person" else [value]:
                part = clean_value(part)
                if not usable(part):
                    continue
                rec = Record(kind=kind, name=part, confidence=75,
                             attrs={"role": attr} if kind == "person" else {},
                             evidence=[Evidence(rel, phrase)])
                if context:
                    rec.attrs["collectionContext"] = context
                records.append(rec)
                edges.append(Edge(source=doc.name, kind=f"{attr}_by" if kind == "person" else "supplied_by",
                                  target=part, evidence=Evidence(rel, phrase), confidence=75))

    for m in REFERENCE.finditer(text):
        target = clean_value(m.group("name"))
        if not usable(target) or norm_name(target) == norm_name(doc.name):
            continue
        edges.append(Edge(source=doc.name, kind="references", target=target,
                          evidence=Evidence(rel, re.sub(r"\s+", " ", m.group(0)).strip()),
                          confidence=65))

    return records, edges


def split_people(v: str) -> list[str]:
    """"Priya Sharma, Rahul Menon and A. Khan" is three people, not one name."""
    parts = re.split(r"\s*(?:,|;|/|\band\b|&)\s*", v)
    return [p for p in parts if p and len(p.strip()) >= MIN_NAME][:8]


# --------------------------------------------------------------- aggregation
def aggregate(records: list[Record]) -> list[Record]:
    """
    One record per real thing, evidence from every file that mentioned it.

    Deduplication is on the NORMALISED NAME within a kind, never across kinds —
    a vendor and a person can share a name and are not the same record. Attrs
    merge rather than overwrite: the first file to state a value keeps it and
    later files add what they alone knew, so nothing collected is lost to a
    later file that happened to be quieter.
    """
    merged: dict[tuple[str, str], Record] = {}
    for r in records:
        if not usable(r.name):
            continue
        cur = merged.get(r.key)
        if cur is None:
            merged[r.key] = Record(kind=r.kind, name=r.name, attrs=dict(r.attrs),
                                   evidence=list(r.evidence), confidence=r.confidence,
                                   method=r.method)
            continue
        for k, v in r.attrs.items():
            if k not in cur.attrs or not cur.attrs[k]:
                cur.attrs[k] = v
            elif cur.attrs[k] != v:
                # Two files disagree. Keep both rather than picking — a
                # contradiction is a fact about the corpus and is exactly what a
                # reviewer needs to see.
                other = cur.attrs.setdefault(f"{k}__alternatives", [])
                if isinstance(other, list) and v not in other:
                    other.append(v)
        cur.evidence.extend(r.evidence)
        cur.confidence = min(95, max(cur.confidence, r.confidence) +
                             (5 if len({e.file for e in cur.evidence}) > 1 else 0))
    return list(merged.values())


def analyse(base: pathlib.Path, *, context: str = "", max_files: int = 2000,
            include: set[str] | None = None) -> dict:
    """
    Read every readable file under `base` against `context`.

    Returns records, edges and a per-file account — including the files that
    produced nothing, because "we opened it and it said nothing we recognise" is
    a different fact from "we never opened it".
    """
    base = pathlib.Path(base)
    records: list[Record] = []
    edges: list[Edge] = []
    files: list[dict] = []

    for f in sorted(base.rglob("*"))[:max_files]:
        if not f.is_file() or f.name.startswith("."):
            continue
        rel = str(f.relative_to(base))
        # A register is a table and its rows are records already — those go
        # through the row parser, which keeps 200 risks instead of collapsing
        # them into one "Risk Register" document.
        if include is not None and rel not in include:
            continue
        text = read_any(f)
        if not text.strip():
            files.append({"file": rel, "read": False, "records": 0,
                          "reason": "no text could be read from this format"})
            continue
        rs, es = from_text(text, rel, context=context)
        records.extend(rs)
        edges.extend(es)
        files.append({"file": rel, "read": True, "records": len(rs), "edges": len(es),
                      "chars": len(text)})

    agg = aggregate(records)
    by_kind: dict[str, int] = defaultdict(int)
    for r in agg:
        by_kind[r.kind] += 1
    return {
        "context": context,
        "analysed_at": _now(),
        "files": files,
        "files_read": sum(1 for f in files if f["read"]),
        "files_unreadable": sum(1 for f in files if not f["read"]),
        "records": agg,
        "edges": edges,
        "by_kind": dict(by_kind),
    }


# ------------------------------------------------------- Company Brain shape
def to_entities(result: dict, source: str) -> list[dict]:
    """
    Company Brain entities, with everything unmapped preserved in `attrs`.

    The domain column still exists and the UI still navigates by it, so each
    record is given one — but the CALLER no longer chooses it for the whole
    folder. It follows from what the record is.
    """
    context = result.get("context") or ""
    out = []
    for r in result["records"]:
        if r.kind == "document":
            domain = TYPE_DOMAIN.get(r.attrs.get("documentType", ""), "evidence")
            etype = r.attrs.get("documentType") or "Document"
        else:
            domain = KIND_DOMAIN.get(r.kind, "evidence")
            etype = {"person": "Person", "vendor": "Vendor", "policy": "Policy",
                     "process": "Process", "control": "Control", "risk": "Risk",
                     "evidence": "Evidence", "system": "System",
                     "data": "Data Asset"}.get(r.kind, "Document")
        attrs = dict(r.attrs)
        attrs["evidence"] = [e.as_dict() for e in r.evidence[:12]]
        attrs["evidenceCount"] = len(r.evidence)
        attrs["extraction"] = r.method
        if context:
            attrs["collectionContext"] = context
        out.append({
            "id": f"{domain[:3]}-{_slug(r.name)}",
            "domain": domain,
            "name": r.name[:200],
            "type": etype,
            "description": _describe(r, context),
            "criticality": r.attrs.get("criticality") or None,
            # Collected, not confirmed. A mined record is a proposal until a
            # person accepts it, and the lifecycle is where that is visible.
            "lifecycle": "Discovered",
            "verification": "Pending",
            "attrs": attrs,
            "provenance": {"source": source,
                           "sourceReference": r.evidence[0].file if r.evidence else ""},
        })
    return out


def _describe(r: Record, context: str) -> str:
    files = sorted({e.file for e in r.evidence})
    where = files[0] if len(files) == 1 else f"{len(files)} files"
    if r.kind == "person" and r.attrs.get("role"):
        return f"Named as {r.attrs['role']} in {where}"
    if r.kind == "vendor":
        return f"Named as a vendor in {where}"
    if r.kind == "document":
        return f"{r.attrs.get('documentType', 'Document')} collected from {where}"
    return f"Found in {where}"


def _slug(s: str) -> str:
    keep = "".join(c if c.isalnum() else "-" for c in (s or "").lower())
    return "-".join(p for p in keep.split("-") if p)[:60] or "record"


def to_relationships(result: dict, entities: list[dict]) -> list[dict]:
    """
    Edges between the entities that were actually created.

    An edge naming something no record exists for is dropped, not invented into
    a placeholder entity — a relationship to a thing that does not exist is how
    a graph fills with nodes nobody can explain.
    """
    by_name = {}
    for e in entities:
        by_name.setdefault(norm_name(e["name"]), e["id"])
    out, seen = [], set()
    for edge in result["edges"]:
        s = by_name.get(norm_name(edge.source))
        t = by_name.get(norm_name(edge.target))
        if not s or not t or s == t:
            continue
        key = (s, edge.kind, t)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id": f"rel-{_slug(edge.source)}-{edge.kind}-{_slug(edge.target)}"[:90],
            "sourceId": s, "type": edge.kind, "targetId": t,
            "confidence": edge.confidence,
            # Proposed, never asserted: the same rule the obligation mappings keep.
            "status": "Pending",
            "evidence": json.dumps(edge.evidence.as_dict()),
        })
    return out
