"""Stage contracts. Each is enforced after the model replies, never assumed."""

APPLICABILITY = """{
  "applies": "YES" | "NO" | "PARTIAL" | "INSUFFICIENT_EVIDENCE",
  "confidence": 0-100,
  "reasoning": "why, referencing the company profile facts that decide it",
  "triggers": [{"fact": "which company fact", "clause": "section number or obligation id", "effect": "what it triggers"}],
  "exclusions": ["any clause that expressly does NOT apply, and why"]
}"""

IMPACTS = """{
  "impacts": [{
    "entity_id": "MUST be an id from the provided entity list — never invented",
    "obligation_id": "an obligation id of this regulation, or null",
    "section_number": "section number, or null",
    "impact_type": "requires_change" | "requires_evidence" | "already_compliant" | "needs_review",
    "severity": "critical" | "high" | "medium" | "low",
    "confidence": 0-100,
    "rationale": "one or two sentences, grounded in the clause text provided"
  }]
}"""

ACTIONS = """{
  "actions": [{
    "title": "imperative, specific",
    "entity_id": "the entity that must change, from the provided list",
    "action_type": "update_policy" | "change_process" | "add_control" | "collect_evidence" | "assess",
    "priority": "P0" | "P1" | "P2",
    "rationale": "why this is required by the clause",
    "clause": "section number or obligation id this derives from"
  }]
}"""

CRITIQUE = """{
  "verdicts": [{
    "entity_id": "the entity being judged",
    "supported": true | false,
    "problem": "what is unsupported by the provided evidence, or null"
  }],
  "overall": "sound" | "partially_sound" | "unsound",
  "missing_evidence": ["what would be needed to decide properly"]
}"""
