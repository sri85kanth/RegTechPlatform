"""Company Brain matching engine (spec §14-§18).
Matches extracted obligations to REAL Company Brain entities only — combining
exact-name, keyword-ontology and graph (approved mapping) signals. Never invents."""
import json
import re
from contextlib import contextmanager
from pathlib import Path

BRAIN = Path(__file__).parent.parent / "input" / "company_brain.json"

# controlled vocabulary: regulatory concept → company-brain search terms (spec §18)
ONTOLOGY = {
    "KYC": ["kyc", "customer onboarding", "customer identification"],
    "AML": ["aml", "transaction monitoring", "money laundering", "fraud"],
    "DATA_RETENTION": ["retention", "customer data", "kyc documents"],
    "REPORTING": ["regulatory reporting", "transaction monitoring"],
    "RECORD_KEEPING": ["kyc documents", "customer data", "evidence", "log"],
    "MONITORING": ["transaction monitoring", "fraud monitoring"],
    "CYBERSECURITY": ["information security", "mfa", "encryption", "access"],
    "RISK_MANAGEMENT": ["risk"],
    "POLICY": ["policy"],
    "TRAINING": ["training"],
    "AUDIT": ["audit", "access review", "evidence"],
    "GOVERNANCE": ["ciso", "compliance"],
    "NOTIFICATION": ["regulatory reporting"],
    "DOCUMENTATION": ["kyc documents", "evidence"],
}
COMPANY_DOMAINS = {"people", "processes", "systems", "data", "policies", "controls", "risks", "evidence"}


def load_brain(con=None) -> dict:
    """
    Load the Company Brain from the DATABASE.

    This used to read input/company_brain.json — a static seed whose ids share
    ZERO overlap with company_entities. Every impact relationship it produced
    pointed at a record that does not exist (123,020 orphaned rows), so the
    impact graph was matching obligations against a company that was never real.

    The database is the only source of truth for what this company actually has.
    """
    import sqlite3
    if con is None:
        from .db import connect
        con = connect()
    con.row_factory = sqlite3.Row

    ents = [
        {"id": r["id"], "name": r["name"], "domain": r["domain"],
         "type": r["type"] or "", "description": r["description"] or "",
         "criticality": r["criticality"] or ""}
        for r in con.execute(
            f"""SELECT id,name,domain,type,description,criticality FROM company_entities
                WHERE domain IN ({','.join('?' * len(COMPANY_DOMAINS))})""",
            tuple(COMPANY_DOMAINS))
    ]
    rels = []
    try:
        rels = [dict(r) for r in con.execute(
            "SELECT source_id, type, target_id FROM entity_relationships")]
    except sqlite3.OperationalError:
        pass
    maps = []
    try:
        maps = [dict(r) for r in con.execute(
            "SELECT obligation_id, target_id, status, confidence FROM company_mappings")]
    except sqlite3.OperationalError:
        pass
    # The precision gate is measured here, once, so that EVERY caller gets it.
    # It lived only in run_matcher.py, which meant the ingest pipeline matched
    # without it — and the ingest pipeline is what produced the rows in the
    # database. A gate that only one entry point applies is not a gate.
    generic: set[str] = set()
    try:
        generic = _generic_names_cached(con, [e["name"] for e in ents])
    except Exception:
        pass          # no obligations yet — nothing to measure against

    return {"entities": ents, "by_id": {e["id"]: e for e in ents},
            "relationships": rels, "mappings": maps, "generic": generic}


# The precision gate is a CORPUS statistic, not a per-document one: it asks how
# common each entity name is across all obligations. pipeline.process() calls
# load_brain() once per document, so without this the same full scan ran again
# for every document in a batch — seven documents meant seven scans of a 110 MB
# table against 1,143 names.
#
# The key is deliberately COARSE. Keying on the exact obligation count looked
# right and was useless: ingesting a document adds obligations, so the key moved
# on every document and the 14-minute scan ran again each time — the very thing
# the cache exists to stop.
#
# What the gate measures is how common a name is across the corpus, against a
# 15% threshold. Adding 400 obligations to 105,765 (0.4%) cannot move a name
# across that line. So it is recomputed when the corpus moves MATERIALLY —
# 2,500 obligations or 25 regulations — and the exact corpus size is still used
# for the ratio itself, so the arithmetic is never approximated.
#
# Not a time-based TTL: a stale precision gate silently changes which matches
# are allowed, and "it expired" is not a reason anyone can audit. "The corpus
# has not materially changed" is.
_OBL_BUCKET, _REG_BUCKET = 2500, 25
_GENERIC_CACHE: dict[tuple, set[str]] = {}
_FROZEN: set[str] | None = None


@contextmanager
def frozen_precision_gate(con, names: list[str], precomputed: set[str] | None = None):
    """Judge a whole batch against ONE gate, computed before the batch starts.

    Two reasons, and the second is the important one.

    Cost: the scan takes minutes on the deployment, and the buckets above are
    deliberately tight — 25 regulations out of 1,533 — so a hundred-document
    ingest crosses four boundaries and pays for it four times.

    Correctness: those four recomputes mean document 1 and document 100 of the
    same batch are judged by different gates, and which side of the line a
    borderline name falls on depends on where it sat in the queue. A batch that
    is re-run in a different order then produces different matches. Freezing the
    gate at the corpus as it stood when the batch began makes the batch
    reproducible, and is the honest reading of the question the gate asks: how
    common was this name in the corpus we are matching against.

    The gate still moves between runs — it is recomputed on the next batch.

    `precomputed` takes a set produced elsewhere — see gate_offboard.py, which
    runs the identical arithmetic on a machine with a CPU and checks that the
    corpus it was computed against is still the corpus being matched.
    """
    global _FROZEN
    was, _FROZEN = _FROZEN, None
    try:
        _FROZEN = precomputed if precomputed is not None else _generic_names_cached(con, names)
        yield _FROZEN
    finally:
        _FROZEN = was


def _generic_names_cached(con, names: list[str]) -> set[str]:
    from .precision import document_frequency, generic_names
    if _FROZEN is not None:
        return _FROZEN
    n_obl, corpus = con.execute(
        "SELECT COUNT(*), COUNT(DISTINCT regulation_id) FROM obligations").fetchone()
    key = (n_obl // _OBL_BUCKET, corpus // _REG_BUCKET, len(names))
    if key not in _GENERIC_CACHE:
        _GENERIC_CACHE.clear()          # only the current corpus is worth holding
        _GENERIC_CACHE[key] = generic_names(document_frequency(con, names), corpus)
    return _GENERIC_CACHE[key]


def tokens(s: str) -> set[str]:
    return {t for t in re.findall(r"[a-z]{3,}", s.lower()) if t not in ("the", "and", "for", "with")}


# The ontology says "this obligation is ABOUT anti-money-laundering". It does
# not say which of our entities is affected — every AML obligation matches every
# entity with "aml" in its name. Treated as a standalone signal it produced
# 109,191 of 206,649 relationships, 53% of the graph, on no name evidence at
# all. It is now corroboration: it can strengthen a name match, never stand in
# for one.
KEYWORD_BOOST = 0.04

# Half the words of a two-word name is ONE word. That is not a name match.
MIN_TOKEN_OVERLAP = 2 / 3
MIN_TOKEN_HITS = 2


def match_obligation(obl: dict, brain: dict) -> list[dict]:
    """Return impact relationships for one obligation — real entities only."""
    from .precision import accept, is_boilerplate

    raw = f"{obl.get('title') or ''} {obl.get('description') or ''}"
    if is_boilerplate(raw):
        # Short title, commencement, repeal. These bind nobody in particular, so
        # anything they appear to match is an artefact of the words used.
        return []
    text = raw.lower()
    ttoks = tokens(text)
    generic = brain.get("generic") or set()
    results = {}

    for e in brain["entities"]:
        name = e["name"].lower()
        signals = {}
        # exact-name signal: full entity name appears in obligation text
        if name in text:
            signals["exact"] = 1.0
        # token-overlap signal — enough of the name, and more than one word of it
        etoks = tokens(name)
        if etoks:
            hits = etoks & ttoks
            ov = len(hits) / len(etoks)
            if ov >= MIN_TOKEN_OVERLAP and (len(hits) >= MIN_TOKEN_HITS or ov == 1.0):
                signals["name_tokens"] = round(0.6 + 0.3 * ov, 2)
        # ontology/keyword signal via obligation type — corroborating only
        for term in ONTOLOGY.get(obl["obligation_type"], []):
            if term in name:
                signals["keyword"] = max(signals.get("keyword", 0), 0.87)

        # NAME EVIDENCE IS REQUIRED. Without it there is nothing tying this
        # clause to this entity rather than to any other entity of its kind.
        named = [v for k, v in signals.items() if k in ("exact", "name_tokens")]
        if not named:
            continue

        conf = round(min(0.99, max(named) + (KEYWORD_BOOST if "keyword" in signals else 0)), 2)
        if conf < 0.6:
            continue

        ok, _why = accept({"signals": signals}, e["name"], raw, generic)
        if not ok:
            continue
        reason = f"{obl['obligation_type']} obligation ({obl['source_reference']}) matches {e['domain']} entity '{e['name']}'"
        results[e["id"]] = {
            "obligation_id": obl["id"],
            "company_brain_entity_id": e["id"],
            "entity_name": e["name"],
            "entity_domain": e["domain"],
            "relationship_type": "affects",
            "match_reason": reason,
            "match_signals": json.dumps(signals),
            "confidence": conf,
            "regulation_clause_id": obl["source_reference"],
            "source": "matching-engine (deterministic signals)",
        }

    # graph signal: approved human mappings for this regulation's seed obligations
    return list(results.values())


def graph_mappings(reg_entity_ids: list[str], brain: dict) -> list[dict]:
    """
    Existing human-approved obligation→entity mappings (highest-trust signal).

    The keys are snake_case because load_brain() reads company_mappings from the
    database. They were camelCase while it read input/company_brain.json, and
    were not updated when that seed was retired — so this raised KeyError on the
    first mapping row and took the whole ingest with it, silently removing the
    one signal a human had actually confirmed.
    """
    out = []
    for m in brain["mappings"]:
        if m["obligation_id"] in reg_entity_ids:
            e = brain["by_id"].get(m["target_id"])
            if not e:
                continue
            out.append({
                "obligation_id": m["obligation_id"],
                "company_brain_entity_id": e["id"],
                "entity_name": e["name"],
                "entity_domain": e["domain"],
                "relationship_type": "maps to",
                "match_reason": m.get("reason", "human-approved mapping"),
                "match_signals": json.dumps({"graph": 0.95, "status": m.get("status")}),
                "confidence": (m.get("confidence", 90)) / 100,
                "regulation_clause_id": None,
                "source": f"Company Brain mapping ({m.get('status')})",
            })
    return out
