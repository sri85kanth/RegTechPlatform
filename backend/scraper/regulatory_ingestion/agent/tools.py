"""
What the model may look up for itself — six read-only tools.

Until now the model received one fixed 6.5k-token blob and could ask for nothing
else. These let it pull the exact entity, clause or threshold it is reasoning
about. None of them writes; the standing rule that only a person changes state
holds inside the agent too.
"""
from __future__ import annotations
import json
from langchain_core.tools import tool


def _con():
    from . import graph
    return graph._con()


def _j(x) -> str:
    return json.dumps(x, ensure_ascii=False, default=str)[:4000]


@tool
def entity(entity_id: str) -> str:
    """One company entity by exact id — name, type, domain, owner, criticality, description."""
    r = _con().execute(
        "SELECT id, name, type, domain, owner_id, criticality, description FROM company_entities WHERE id=?",
        (entity_id,)).fetchone()
    return _j(dict(r)) if r else _j({"error": f"no entity with id {entity_id!r} — ids must come from the provided list"})


@tool
def clause(regulation_id: str, section_number: str) -> str:
    """The exact text of one numbered section of a regulation."""
    r = _con().execute(
        "SELECT section_number, section_title, section_text FROM sections WHERE regulation_id=? AND section_number=?",
        (regulation_id, str(section_number))).fetchone()
    return _j(dict(r)) if r else _j({"error": f"no section {section_number} in {regulation_id}"})


@tool
def search(query: str, regulation_id: str | None = None) -> str:
    """Semantic + keyword search over all regulatory text; optionally within one regulation. Returns up to 6 passages."""
    from .. import rag
    res = rag.search(query, k=6, regulation_id=regulation_id)
    return _j([{"regulation_id": r.get("regulation_id"), "source": r.get("source_id"),
                "section": r.get("section_number"), "text": (r.get("content") or "")[:600]} for r in res])


@tool
def threshold(obligation_id: str) -> str:
    """Any numeric limit attached to an obligation — metric, operator, value, unit, condition — or 'not evaluated'."""
    rows = _con().execute(
        "SELECT metric, operator, value, unit, currency, condition, source_text FROM thresholds WHERE obligation_id=?",
        (obligation_id,)).fetchall()
    return _j([dict(r) for r in rows]) if rows else _j({"status": "not evaluated", "obligation_id": obligation_id})


@tool
def company_fact(key: str) -> str:
    """A fact about our company: entity_type, licences, sectors, jurisdictions, hq_state, employees, listed, customers, handles_personal_data."""
    r = _con().execute("SELECT * FROM company_profile LIMIT 1").fetchone()
    if not r:
        return _j({"error": "no company profile"})
    d = dict(r)
    return _j({key: d.get(key, f"unknown fact {key!r}; known: {sorted(d)}")})


@tool
def prior_runs(regulation_id: str) -> str:
    """What the engine decided about this regulation before — status, route, impact count, when."""
    rows = _con().execute(
        "SELECT id, status, route, model, impacts, actions, ran_at FROM impact_runs WHERE regulation_id=? ORDER BY id DESC LIMIT 5",
        (regulation_id,)).fetchall()
    return _j([dict(r) for r in rows])


TOOLS = [entity, clause, search, threshold, company_fact, prior_runs]
