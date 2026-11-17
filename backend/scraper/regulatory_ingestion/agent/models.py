"""
Stage contracts as Pydantic models — the same four shapes schemas.py describes
in prose, now enforced by the model call itself (with_structured_output) rather
than checked after the fact. Anything the schema does not allow cannot arrive.

Grounding is still a separate step: a well-formed entity_id is not a real one.
"""
from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field, conint

Confidence = conint(ge=0, le=100)


class Trigger(BaseModel):
    fact: str = Field(description="which company fact")
    clause: str = Field(description="section number or obligation id")
    effect: str = Field(description="what it triggers")


class Applicability(BaseModel):
    applies: Literal["YES", "NO", "PARTIAL", "INSUFFICIENT_EVIDENCE"]
    confidence: Confidence
    reasoning: str = Field(description="why, referencing the company profile facts that decide it")
    triggers: list[Trigger] = []
    exclusions: list[str] = Field(default_factory=list,
                                  description="clauses that expressly do NOT apply, and why")
    citations: list[str] = Field(default_factory=list,
                                 description="section numbers or obligation ids from THIS regulation that ground the verdict")


class Impact(BaseModel):
    entity_id: str = Field(description="MUST be an id from the provided entity list — never invented")
    obligation_id: Optional[str] = Field(None, description="an obligation id of this regulation, or null")
    section_number: Optional[str] = None
    impact_type: Literal["requires_change", "requires_evidence", "already_compliant", "needs_review"]
    severity: Literal["critical", "high", "medium", "low"]
    confidence: Confidence
    rationale: str = Field(description="one or two sentences, grounded in the clause text provided")
    citations: list[str] = Field(default_factory=list,
                                 description="section numbers or obligation ids from THIS regulation that ground this impact")


class Impacts(BaseModel):
    impacts: list[Impact] = []


class Action(BaseModel):
    title: str = Field(description="imperative, specific")
    entity_id: str = Field(description="the entity that must change, from the provided list")
    action_type: Literal["update_policy", "change_process", "add_control", "collect_evidence", "assess"]
    priority: Literal["P0", "P1", "P2"]
    rationale: str
    clause: str = Field(description="section number or obligation id this derives from")


class Actions(BaseModel):
    actions: list[Action] = []


class Verdict(BaseModel):
    entity_id: str
    supported: bool
    problem: Optional[str] = None


class Critique(BaseModel):
    verdicts: list[Verdict] = []
    overall: Literal["sound", "partially_sound", "unsound"]
    missing_evidence: list[str] = []


class Drop(BaseModel):
    """A grounding rejection, kept so the model can be told what it invented."""
    item: dict
    reason: str


class Decision(BaseModel):
    """What a reviewer said at the human gate."""
    entity_id: str
    outcome: Literal["approve", "edit", "reject"]
    note: Optional[str] = None
    edited: Optional[Impact] = None
