"""
Turn a risk register into library templates (design §14.2).

Pure: takes the register's rows as dicts, returns templates. The CLI
build_risk_library.py reads the xlsx and writes rulebooks/library.yaml.

What a row becomes:
  - a template bound to a graph NODE TYPE (not a sector), with an applies_when
    predicate on graph facts — the mapping below is data, reviewed like a rulebook;
  - the register's ratings become a BENCHMARK, never a score (decision D1);
  - impact seeds and a base-likelihood class are DRAFT values derived from the
    risk type and CIA columns only, marked seed_status: draft until a person
    reviews them (they cost confidence until then);
  - the mitigation text becomes typical controls, with the review interval it
    names ("half yearly" → 180 days) so evidence freshness can be judged;
  - treatment labels take their ISO 31000 meaning (decision D3). The sample
    register's legend has Accepted and Avoidance interchanged; rows whose
    numbers contradict their label are flagged, never reinterpreted.
"""
from __future__ import annotations

import re
from typing import Any

# column order of the register layout this reads (header names checked by the CLI)
COLUMNS = ("sr", "risk_type", "date_logged", "division", "control_area", "process", "description", "cia",
           "consequence", "likelihood_label", "likelihood", "impact", "impact_label", "score", "level",
           "owner", "actions", "treatment", "post_likelihood", "post_impact", "post_score", "post_level")

DIVISION_ALIASES = {
    "it-security": "IT Security", "it security": "IT Security",
    "it-operations": "IT Operations", "it operations": "IT Operations",
    "pes - bu": "Engineering BU", "pes bu": "Engineering BU", "pes bu / ses bu": "Engineering BU",
}

ALWAYS: dict = {}
_IT = ("CYBER", "system", {"org.has_systems": True})
# division → (theme, node type, applies_when)
DIVISION_MAP: dict[str, tuple[str, str, dict]] = {
    "General IT": _IT, "Information Technology": _IT, "IT Security": _IT, "IT Operations": _IT,
    "Engineering BU": ("CYBER", "process", {"org.develops_software": True}),
    "Engineering": ("OPS", "product", {"org.develops_products": True}),
    "Human Resources": ("PEOPLE", "organisation", {"org.employees": {"gt": 0}}),
    "Finance": ("FIN", "organisation", ALWAYS),
    "Enterprise Risk": ("GOV", "organisation", ALWAYS),
    "Sales and Marketing": ("CUST", "organisation", {"org.markets_to_customers": True}),
    "Customer Service": ("CUST", "organisation", {"org.markets_to_customers": True}),
    "Legal": ("LEGAL", "organisation", ALWAYS),
    "Compliance": ("LEGAL", "organisation", ALWAYS),
    "Administration": ("OPS", "organisation", ALWAYS),
    "Privacy": ("DATA", "data_asset", {"node.personal_data": True}),
    "Business Continuity": ("BCP", "organisation", ALWAYS),
    "Procurement": ("THIRD", "third_party", ALWAYS),
    "Third Party": ("THIRD", "third_party", ALWAYS),
    "Supply Chain": ("THIRD", "product", {"org.physical_goods": True}),
    "Inventory": ("OPS", "product", {"org.physical_goods": True}),
    "Operations": ("OPS", "process", {"node.criticality": {"in": ["Critical", "High"]}}),
    "Facilities": ("FAC", "site", ALWAYS),
    "Health and Safety": ("FAC", "site", ALWAYS),
    "Project Management": ("GOV", "organisation", {"org.runs_projects": True}),
    "Product Management": ("OPS", "product", {"org.develops_products": True}),
}
# control area → (theme, node type, applies_when); wins over the division
AREA_MAP: dict[str, tuple[str, str, dict]] = {
    "cloud security": ("CYBER", "system", {"node.hosting": "cloud"}),
    "artificial intelligence": ("CYBER", "system", {"node.uses_ai": True}),
    "physical security": ("FAC", "site", ALWAYS),
    "software licensing": ("CYBER", "organisation", {"org.has_systems": True}),
    "governance & organization risk management": ("GOV", "organisation", {"org.has_systems": True}),
    "esg and climate": ("ESG", "organisation", ALWAYS),
    "esg reporting": ("ESG", "organisation", {"org.listed": True}),
    "website": ("CUST", "organisation", {"org.has_website": True}),
    "sanctions and export controls": ("LEGAL", "organisation", {"org.imports_exports": True}),
    "cross-border transfer": ("DATA", "data_asset", {"all": [{"node.personal_data": True},
                                                             {"node.residency_outside_india": True}]}),
    "remote work": ("PEOPLE", "organisation", {"org.remote_work": True}),
    "disaster recovery": ("BCP", "system", {"node.criticality": {"in": ["Critical", "High"]}}),
    "natural hazards": ("BCP", "site", ALWAYS),
    "pandemic and workforce": ("BCP", "organisation", ALWAYS),
    "concentration": ("THIRD", "organisation", {"org.has_vendors": True}),
    "budget": ("FIN", "organisation", ALWAYS),
}
RARE_AREAS = {"natural hazards", "pandemic and workforce"}

TREATMENTS = {"mitigation": "MITIGATE", "acceptance": "ACCEPT", "accepted": "ACCEPT",
              "avoidance": "AVOID", "transfer": "TRANSFER"}
_INTERVALS = [  # most specific first
    (re.compile(r"half[\s-]*year|semi[\s-]*annual|bi[\s-]*annual|every\s+six\s+months", re.I), 180),
    (re.compile(r"quarter", re.I), 90),
    (re.compile(r"month", re.I), 30),
    (re.compile(r"week", re.I), 7),
    (re.compile(r"\bdaily\b|every\s+day", re.I), 1),
    (re.compile(r"\byear|annual", re.I), 365),
]
_CIA = (("confidentiality", re.compile(r"co?n?fid", re.I)),        # also the register's "Cofidentiality"
        ("integrity", re.compile(r"integ", re.I)),
        ("availability", re.compile(r"avail", re.I)))


def _s(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v)).strip() if v not in (None, "") else ""


def _int(v: Any) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def division(raw: Any) -> str:
    d = _s(raw)
    return DIVISION_ALIASES.get(d.lower(), d)


def cia(raw: Any) -> list[str]:
    """'Cofidentiality\\nIntegrity' → ['confidentiality', 'integrity'] (typos forgiven)."""
    text = _s(raw)
    return [name for name, rx in _CIA if rx.search(text)]


def intervals(text: Any) -> list[int]:
    """Review intervals a mitigation sentence names, in days ("VA half yearly and PT yearly" → [180, 365])."""
    t = _s(text)
    found: list[int] = []
    for rx, days in _INTERVALS:
        if rx.search(t):
            found.append(days)
            t = rx.sub(" ", t)        # "half yearly" must not also count as "yearly"
    return sorted(set(found))


def placement(div: str, area: str) -> tuple[str, str, dict, str]:
    """(theme, node type, applies_when, how it was decided)."""
    if area.lower() in AREA_MAP:
        theme, node, cond = AREA_MAP[area.lower()]
        return theme, node, cond, f"control area {area!r}"
    if div in DIVISION_MAP:
        theme, node, cond = DIVISION_MAP[div]
        return theme, node, cond, f"division {div!r}"
    return "GOV", "organisation", ALWAYS, "no mapping: defaulted, needs review"


def seeds(risk_type: str, cia_list: list[str]) -> dict[str, int]:
    """Draft impact seeds from the risk type and CIA only — never from the register's own ratings."""
    rt = risk_type.lower()
    return {
        "operational": 4 if "availability" in cia_list else 3,
        "regulatory": 4 if rt == "regulatory" else 3 if "confidentiality" in cia_list else 2,
        "financial": 4 if rt == "financial" else 3 if rt == "strategic" else 2,
        "reputational": 3 if rt == "strategic" or "confidentiality" in cia_list else 2,
    }


def base_likelihood(theme: str, area: str) -> str:
    if area.lower() in RARE_AREAS:
        return "rare"
    return "frequent" if theme == "CYBER" else "occasional"


def template(row: dict, source: str) -> dict:
    sr = _int(row.get("sr"))
    div, area = division(row.get("division")), _s(row.get("control_area"))
    theme, node, cond, how = placement(div, area)
    rt = _s(row.get("risk_type"))
    c = cia(row.get("cia"))
    label = _s(row.get("treatment"))
    treatment = TREATMENTS.get(label.lower())
    prior, post = _int(row.get("score")), _int(row.get("post_score"))
    flags = []
    if prior is not None and post is not None:
        if post > prior:
            flags.append("risk_rises_after_treatment")
        elif post == prior and treatment == "AVOID":
            flags.append("avoidance_without_reduction")      # D3: avoiding should remove the risk
        elif post == prior and treatment == "MITIGATE":
            flags.append("mitigation_without_reduction")
    if treatment is None and label:
        flags.append("unknown_treatment_label")
    if how.startswith("no mapping"):
        flags.append("unmapped_division")
    actions = _s(row.get("actions"))
    return {
        "id": f"LIB-{sr:03d}" if sr is not None else None,
        "title": _s(row.get("description")),
        "theme": theme,
        "node_type": node,
        "applies_when": cond,
        "placed_by": how,
        "risk_type": rt,
        "division": div,
        "control_area": area,
        "process": _s(row.get("process")),
        "cia": c,
        "consequence": _s(row.get("consequence")),
        "typical_controls": [{"text": actions, "intervals_days": intervals(actions)}] if actions else [],
        "seeds": seeds(rt, c),
        "seed_status": "draft",
        "base_likelihood": base_likelihood(theme, area),
        "benchmark": {
            "prior": {"likelihood": _int(row.get("likelihood")), "impact": _int(row.get("impact")),
                      "score": prior, "level": _s(row.get("level"))},
            "post": {"likelihood": _int(row.get("post_likelihood")), "impact": _int(row.get("post_impact")),
                     "score": post, "level": _s(row.get("post_level"))},
            "treatment_label": label,
            "treatment": treatment,
        },
        "flags": flags,
        "source": {"register": source, "row": sr},
    }


def build(rows: list[dict], source: str) -> list[dict]:
    out = [template(r, source) for r in rows if _int(r.get("sr")) is not None and _s(r.get("description"))]
    ids = [t["id"] for t in out]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(f"duplicate Sr. No. in the register: {sorted(dupes)}")
    return out
