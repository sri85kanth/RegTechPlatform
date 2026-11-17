"""
The risk library: templates bound to graph node types (design §14.2).

A template applies to every node of its type whose facts satisfy its
applies_when predicate. Unknown facts make it a CANDIDATE for review (gate G9),
never a silent drop (decision D1: the widest scope).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import yaml

from . import predicates as P
from .rulebook import RULEBOOK_DIR, Rulebook, RulebookError

NODE_TYPES = ("organisation", "site", "process", "system", "data_asset", "third_party", "product", "role", "licence")
SEED_DIMENSIONS = ("regulatory", "operational", "financial", "reputational", "safety")


@dataclass(frozen=True)
class Library:
    name: str
    version: str
    templates: tuple
    ref: dict

    def get(self, template_id: str) -> dict | None:
        return next((t for t in self.templates if t["id"] == template_id), None)


def load(rb: Rulebook, name: str = "library", directory: Path | str | None = None) -> Library:
    path = Path(directory or RULEBOOK_DIR) / f"{name}.yaml"
    raw = path.read_bytes()
    data = yaml.safe_load(raw)
    if not isinstance(data, dict) or "templates" not in data:
        raise RulebookError(f"{path.name}: needs library, version and templates")
    validate(data, rb)
    ref = {"name": data["library"], "version": data["version"], "hash": "sha256:" + hashlib.sha256(raw).hexdigest()}
    return Library(name=data["library"], version=data["version"], templates=tuple(data["templates"]), ref=ref)


def validate(data: dict, rb: Rulebook) -> None:
    fallback = set((rb.data["likelihood"]["base"].get("fallback") or {}).get("map", {}))
    seen: set[str] = set()
    for i, t in enumerate(data["templates"]):
        where = f"templates[{i}] {t.get('id')}"
        if not t.get("id") or t["id"] in seen:
            raise RulebookError(f"{where}: missing or duplicate id")
        seen.add(t["id"])
        if t.get("node_type") not in NODE_TYPES:
            raise RulebookError(f"{where}: unknown node_type {t.get('node_type')!r}")
        if not rb.theme(t.get("theme")):
            raise RulebookError(f"{where}: theme {t.get('theme')!r} is not in rulebook {rb.ref['name']}")
        P.validate(t.get("applies_when") or {}, f"{where}.applies_when")
        for dim, v in (t.get("seeds") or {}).items():
            if dim not in SEED_DIMENSIONS or not (isinstance(v, int) and 1 <= v <= 5):
                raise RulebookError(f"{where}: seed {dim}={v!r} must be a known dimension scored 1..5")
        if t.get("base_likelihood") not in fallback:
            raise RulebookError(f"{where}: base_likelihood must be one of {sorted(fallback)}")


def applies(template: dict, facts: dict) -> tuple[bool | None, set[str]]:
    """True: applies. False: does not. None: a fact is unknown → candidate for review (G9)."""
    return P.evaluate(template.get("applies_when") or {}, facts)


def exposure(template: dict, node: dict, org: dict) -> dict | None:
    """The engine exposure for a template on one graph node, or None when it does not apply.

    `node` carries the graph node's id, label and facts (criticality, hosting, …);
    `org` the organisation's facts (has_systems, employees, …).
    """
    state, missing = applies(template, {"org": org, "node": node})
    if state is False:
        return None
    return {
        "id": f"{template['id']}@{node.get('id', 'org')}",
        "kind": "template",
        "label": f"{template['title']} — {node.get('label') or node.get('id') or 'organisation'}",
        "theme": template["theme"],
        "applicability": "APPLICABLE" if state else "REVIEW_REQUIRED",
        "applicability_missing": sorted(missing),
        "facts": {
            "template": {"id": template["id"], "seeds": template.get("seeds") or {},
                         "seed_status": template.get("seed_status"), "base_likelihood": template.get("base_likelihood"),
                         "cia": template.get("cia") or []},
            "node": {k: v for k, v in node.items() if k not in ("id", "label")},
        },
        "controls": [],
    }
