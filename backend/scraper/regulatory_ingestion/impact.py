"""Transparent impact scoring (spec §16) — every factor stored, nothing hardcoded."""
import json

WEIGHTS = {"departments": 8, "people": 3, "processes": 10, "systems": 8, "data": 7,
           "policies": 6, "controls": 8, "risks": 9, "evidence": 3}
CRIT_BONUS = {"Critical": 12, "High": 8, "Medium": 4, "Low": 1}


# The verdicts that mean this regulation reaches the company. Anything else
# cannot carry a business impact ON THIS COMPANY, whatever its obligation count.
_REACHES = {"APPLICABLE", "CONDITIONAL"}

# company_entities.criticality holds more than one vocabulary. The business
# scale below is what CRIT_BONUS is defined against; the hospital entity set
# brought an equipment scale — NON_CRITICAL / CRITICAL / LIFE_SUPPORT — and
# scoring crashed on it: order.index("NON_CRITICAL") raises ValueError, so every
# regulation matching one of those entities died at the impact step, mid-ingest,
# and was recorded FAILED. 22 documents were lost that way before it was found.
#
# Both vocabularies map onto the one scale the weights are written for.
# LIFE_SUPPORT sits at the top of the equipment scale, so it maps to Critical.
#
# An unrecognised value scores Low rather than raising. A conservative score is
# worth more than a crash, and an entity whose criticality nobody has set should
# not be able to inflate a regulation's impact — but it is recorded, so a new
# vocabulary shows up in the factors rather than passing silently.
CRIT_SCALE = ["Low", "Medium", "High", "Critical"]
CRIT_ALIAS = {
    "LOW": "Low", "MEDIUM": "Medium", "HIGH": "High", "CRITICAL": "Critical",
    "NON_CRITICAL": "Low", "NONCRITICAL": "Low",
    "LIFE_SUPPORT": "Critical", "LIFESUPPORT": "Critical",
}


def criticality(value: str | None) -> tuple[str, bool]:
    """(criticality on CRIT_SCALE, whether the input was recognised)."""
    raw = (value or "").strip()
    if not raw:
        return "Low", True
    mapped = CRIT_ALIAS.get(raw.upper().replace("-", "_").replace(" ", "_"))
    return (mapped, True) if mapped else ("Low", False)


def score(relationships: list[dict], obligations: list[dict],
          verdict: str | None, brain_by_id: dict) -> dict:
    """
    Business impact of one regulation ON THIS COMPANY.

    `verdict` is the materialised applicability from regulations.applicability —
    the same value the badge and the filter use. It used to be re-derived here
    from raw applicability_rules, and that is how 274 of 410 stored scores ended
    up on regulations that do not apply: the rules said "Applies" because an
    entity type was MENTIONED, while the engine's own verdict said
    NOT_APPLICABLE. One number on screen contradicting another is worse than
    either being missing, so there is now a single source for it.

    A regulation that does not reach this company scores 0 and is labelled
    NOT_APPLICABLE rather than being handed a Critical badge for obligations
    that bind somebody else.
    """
    ents = {}
    for r in relationships:
        ents[r["company_brain_entity_id"]] = r
    by_domain: dict[str, int] = {}
    max_crit = "Low"
    unknown_crit: set[str] = set()
    for eid in ents:
        e = brain_by_id.get(eid, {})
        d = e.get("domain", "other")
        # people domain: departments are type=Department
        key = "departments" if (d == "people" and e.get("type") == "Department") else d
        by_domain[key] = by_domain.get(key, 0) + 1
        c, known = criticality(e.get("criticality"))
        if not known:
            unknown_crit.add(str(e.get("criticality"))[:40])
        if CRIT_SCALE.index(c) > CRIT_SCALE.index(max_crit):
            max_crit = c

    s = 0
    for dom, n in by_domain.items():
        s += WEIGHTS.get(dom, 2) * min(n, 5)
    s += min(len(obligations), 15) * 2
    s += CRIT_BONUS[max_crit]
    v = (verdict or "").upper()
    reaches = v in _REACHES

    if v and not reaches and v != "REVIEW_REQUIRED":
        # Positively excluded. Not "low impact" — no impact on this company.
        s, level = 0, "None"
    else:
        if reaches:
            s = int(s * 1.15)
        s = min(100, s)
        level = "Critical" if s >= 80 else "High" if s >= 55 else "Medium" if s >= 30 else "Low"
    factors = {
        "affected_by_domain": by_domain,
        "obligations": len(obligations),
        "max_entity_criticality": max_crit,
        # criticality values this scale does not know, scored as Low. Present
        # only when there are some, so a vocabulary change is visible in the
        # stored factors instead of silently flattening every entity to Low.
        **({"unrecognised_criticality": sorted(unknown_crit)} if unknown_crit else {}),
        # The verdict this score was computed against, so a score can be spotted
        # as stale the moment applicability is recomputed.
        "applicability": v or "NOT_ASSESSED",
        "reachesCompany": reaches,
        "weights": WEIGHTS,
        "formula": "sum(domain_weight × min(count,5)) + 2×min(obligations,15) "
                   "+ criticality_bonus, ×1.15 if it reaches the company, capped 100; "
                   "0 when the regulation is positively not applicable",
    }
    return {"score": s, "level": level, "factors": json.dumps(factors)}
