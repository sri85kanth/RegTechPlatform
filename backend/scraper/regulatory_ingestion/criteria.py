"""
Guidebook assessment criteria are not requirements of their own.

NABH scores the objective element (OE), nothing below it. The guidebook's
interpretation of each OE was split into numbered criteria so each could be
checked against the hospital's documents (requirement ids ending -gb1, -gb2 …,
derivation nabh6-guidebook). Loading them also gave each one a requirement
instance and a finding of its own, so the 639 OEs read as 2,021 requirements
and 1,150 of the open findings were criteria, not duties.

Lists and counts therefore skip them. They are shown under their OE — the
obligation they share — as that OE's assessment criteria.
"""
from __future__ import annotations

import re

CRITERION_PATTERN = "-gb[0-9]+$"


def criterion_id(requirement_id: str | None) -> bool:
    """True when this requirement id is a guidebook criterion."""
    return bool(re.search(CRITERION_PATTERN, requirement_id or ""))


def not_criterion(col: str) -> str:
    """SQL predicate: the requirement id in `col` is a requirement, not a guidebook criterion."""
    return f"{col} !~ '{CRITERION_PATTERN}'"


def is_criterion(col: str) -> str:
    return f"{col} ~ '{CRITERION_PATTERN}'"


def finding_not_criterion(alias: str = "f") -> str:
    """SQL predicate: the finding `alias` belongs to a requirement, not to a guidebook criterion."""
    return (f"NOT EXISTS (SELECT 1 FROM company_requirement_instances ci "
            f"WHERE ci.id = {alias}.cri_id AND {is_criterion('ci.requirement_id')})")
