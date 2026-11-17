"""
Deterministic context assembly and answer validation.

The engine's core safety property is that the model is never the authority on
what exists. Everything it is shown comes from the company_brain database, and everything it
returns is checked back against the company_brain database. A cited entity id, obligation id or
section number that does not exist is DROPPED and counted — not repaired, not
softened, not passed through with a caveat.

This is what makes the difference between "the agent thinks Process X is hit"
and "the agent invented a Process X that we do not have".
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any


def _rows(con, q, *p) -> list[dict]:
    return [dict(r) for r in con.execute(q, p)]


def regulation_context(con: sqlite3.Connection, rid: str, max_sections: int = 12) -> dict:
    """Everything known about a regulation, from the database only."""
    reg = con.execute("SELECT * FROM regulations WHERE id=?", (rid,)).fetchone()
    if not reg:
        return {}
    reg = dict(reg)

    from ..change_status import status_for
    change = status_for(con, rid)

    return {
        "regulation": {k: reg.get(k) for k in
                       ("id", "title", "regulator", "regulator_short", "regulation_type",
                        "sector", "issued_on", "status", "source_url", "ingestion_status")},
        # The five-state status travels with the context so the model cannot
        # describe a mere footnote mention as a detected change.
        "changeStatus": {k: change.get(k) for k in
                         ("status", "explanation", "versionsCaptured", "computedChanges",
                          "amendmentsMentioned")},
        "obligations": _rows(con,
            """SELECT id, title, description, obligation_type, mandatory_action,
                      responsible_entity, frequency
               FROM obligations WHERE regulation_id=? LIMIT 40""", rid),
        "sections": _rows(con,
            f"""SELECT id, section_number, section_title, substr(section_text,1,900) AS text
                FROM sections WHERE regulation_id=? AND length(section_text)>80
                LIMIT {max_sections}""", rid),
        "amendments": _rows(con,
            """SELECT reference, amended_on, raw, url FROM regulation_amendments
               WHERE regulation_id=? ORDER BY amended_on DESC LIMIT 10""", rid),
        "computedChanges": _rows(con,
            """SELECT section_number, change_type, words_added, words_removed
               FROM section_changes WHERE regulation_id=? LIMIT 30""", rid),
        "existingMappings": _rows(con,
            """SELECT m.obligation_id, m.target_id, m.target_domain, m.status,
                      m.confidence, m.reason, ce.name AS target_name
               FROM company_mappings m
               JOIN obligations o ON o.id = m.obligation_id
               LEFT JOIN company_entities ce ON ce.id = m.target_id
               WHERE o.regulation_id=?""", rid),
        # what failing this regulation costs, verbatim from its own text
        "penalties": _rows(con,
            """SELECT section_number, kind, amount_min, amount_max, per_day_amount,
                      multiplier, multiplier_basis, imprisonment_months, basis_text
               FROM penalty_provisions WHERE regulation_id=?
               ORDER BY amount_max DESC NULLS LAST LIMIT 6""", rid),
        # the rule engine's own matches (matcher-db/2): confidence is 0-1 here
        "ruleMatches": _rows(con,
            """SELECT obligation_id, company_brain_entity_id AS target_id,
                      entity_domain AS target_domain, confidence,
                      match_reason AS reason, entity_name AS target_name
               FROM impact_relationships
               WHERE regulation_id=? ORDER BY confidence DESC, id LIMIT 60""", rid),
    }


def company_context(con: sqlite3.Connection, limit_per_domain: int = 40) -> dict:
    """
    The company side. Entities are listed with their ids because the model must
    CHOOSE from this list — it is never asked to name an entity freehand.
    """
    profile = con.execute("SELECT * FROM company_profile LIMIT 1").fetchone()
    ents = _rows(con,
        """SELECT id, domain, type, name, substr(COALESCE(description,''),1,160) AS description,
                  criticality
           FROM company_entities ORDER BY domain, name""")
    by_domain: dict[str, list] = {}
    for e in ents:
        by_domain.setdefault(e["domain"], [])
        if len(by_domain[e["domain"]]) < limit_per_domain:
            by_domain[e["domain"]].append(e)
    return {
        "profile": {k: (json.loads(v) if k in ("jurisdictions", "sectors", "licences")
                        and isinstance(v, str) and v.startswith("[") else v)
                    for k, v in (dict(profile).items() if profile else [])},
        "entitiesByDomain": by_domain,
        "entityCount": len(ents),
    }


def retrieval_context(query: str, rid: str | None, k: int = 6) -> list[dict]:
    """Passages from the RAG index. Optional — retrieval being down is survivable."""
    try:
        from .. import rag
        hits = rag.search(query, k=k, regulation_id=rid)
        return [{"title": h["title"], "content": h["content"][:700],
                 "source": f"{h['source_table']}#{h['source_id']}", "url": h.get("url")}
                for h in hits]
    except Exception:
        return []


# ------------------------------------------------------------------ validation
def known_ids(con: sqlite3.Connection) -> dict[str, set]:
    return {
        "entities": {r[0] for r in con.execute("SELECT id FROM company_entities")},
        "obligations": {r[0] for r in con.execute("SELECT id FROM obligations")},
        "regulations": {r[0] for r in con.execute("SELECT id FROM regulations")},
    }


def citation_targets(con: sqlite3.Connection, rid: str) -> set:
    """Everything a model may cite for THIS regulation: its section numbers,
    section ids and obligation ids. Anything else is an invented citation."""
    t: set = set()
    for (n,) in con.execute("SELECT section_number FROM sections WHERE regulation_id=?", (rid,)):
        t.add(str(n)); t.add(f"§{n}"); t.add(f"s.{n}")
    for (i,) in con.execute("SELECT id FROM sections WHERE regulation_id=?", (rid,)):
        t.add(i)
    for (i,) in con.execute("SELECT id FROM obligations WHERE regulation_id=?", (rid,)):
        t.add(i)
    return t


def scrub_citations(items: list[dict], targets: set) -> tuple[list[dict], int]:
    """Keep the item, drop its invented citations — a claim loses its footnote,
    never its hearing; the count makes the model's citation honesty measurable."""
    dropped = 0
    for it in items:
        cited = it.get("citations") or []
        kept = [c for c in cited if str(c).strip() in targets]
        dropped += len(cited) - len(kept)
        it["citations"] = kept
    return items, dropped


def validate_impacts(con: sqlite3.Connection, rid: str, impacts: list[dict]) -> dict:
    """
    Drop anything the model invented.

    Returns kept/dropped plus the reason for each drop, so hallucination rate is
    a measurable number rather than an impression.
    """
    ids = known_ids(con)
    valid_obl = {r[0] for r in con.execute(
        "SELECT id FROM obligations WHERE regulation_id=?", (rid,))}
    sections = {str(r[0]) for r in con.execute(
        "SELECT section_number FROM sections WHERE regulation_id=?", (rid,))}

    kept, dropped = [], []
    for it in impacts if isinstance(impacts, list) else []:
        if not isinstance(it, dict):
            dropped.append({"item": str(it)[:120], "reason": "not an object"})
            continue
        eid = (it.get("entity_id") or "").strip()
        if not eid:
            dropped.append({"item": it, "reason": "no entity_id"})
            continue
        if eid not in ids["entities"]:
            dropped.append({"item": it, "reason": f"entity_id '{eid}' does not exist in company_entities"})
            continue
        oid = (it.get("obligation_id") or "").strip()
        if oid and oid not in valid_obl:
            dropped.append({"item": it, "reason": f"obligation_id '{oid}' is not an obligation of {rid}"})
            continue
        sec = str(it.get("section_number") or "").strip()
        if sec and sections and sec not in sections:
            dropped.append({"item": it, "reason": f"section {sec} does not exist in {rid}"})
            continue
        kept.append(it)

    return {
        "kept": kept, "dropped": dropped,
        "hallucinationRate": round(len(dropped) / max(len(impacts or []), 1), 3),
    }
