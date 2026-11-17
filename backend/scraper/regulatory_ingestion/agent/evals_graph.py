"""
Property checks for the LangGraph engine. Run without an API key.

    python3 -m regulatory_ingestion.agent.evals_graph

Every case injects fakes for the database, the model chain and the tool chain,
then asserts a property of the GRAPH — how it routes, stops, resumes, drops and
accounts — not whether a model "sounds right". The eleven legacy cases in
evals.py still cover grounding on real data; these cover the machinery around it.
"""
from __future__ import annotations
import json, os, sys, traceback

os.environ.setdefault("AGENT_CHECKPOINTER", "memory")
for k in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY", "TRACE_SINKS"):
    os.environ.pop(k, None)

from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from . import graph as GR, grounding as G, engine as E, llm_lc, models as M


# ------------------------------------------------------------------ fakes
class Row(dict):
    def __getitem__(self, k): return dict.get(self, k)

class FakeCon:
    def __init__(self): self.rows = []
    def execute(self, q, *a):
        rows = self.rows
        class R:
            def fetchall(s): return []
            def fetchone(s):
                if "company_entities" in q: return Row(id="imp-process-kyc", name="KYC onboarding", type="process", domain="processes", owner="Karan", criticality="High", description="")
                return None
            lastrowid = 1
        if "INSERT INTO impact_runs" in q: rows.append(a[0] if len(a) == 1 else a)   # params arrive as one tuple
        return R()
    def executescript(self, *a): pass
    def commit(self): pass

def usage(i, o): return {"input_tokens": i, "output_tokens": o, "total_tokens": i + o}

class Raw:
    usage_metadata = usage(1000, 100); response_metadata = {"model_name": "fake-model"}

def structured(impact_conf=88, applies="YES", impacts_entity="imp-process-kyc", invent_first=False):
    calls = {"impacts": 0}
    class S:
        def __init__(self, s): self.s = s
        def invoke(self, msgs):
            if self.s is M.Applicability: p = M.Applicability(applies=applies, confidence=90, reasoning="r")
            elif self.s is M.Impacts:
                calls["impacts"] += 1
                eid = "ghost-entity" if (invent_first and calls["impacts"] == 1) else impacts_entity
                p = M.Impacts(impacts=[{"entity_id": eid, "obligation_id": "o1", "impact_type": "requires_change",
                                        "severity": "high", "confidence": impact_conf, "rationale": "r"}])
            elif self.s is M.Actions: p = M.Actions(actions=[{"title": "Update SOP", "entity_id": impacts_entity, "action_type": "change_process", "priority": "P1", "rationale": "r", "clause": "s.1"}])
            else: p = M.Critique(verdicts=[{"entity_id": impacts_entity, "supported": True}], overall="sound")
            return {"parsed": p, "raw": Raw()}
    return S, calls

class ToolChain:
    def __init__(self, always=False): self.always, self.n = always, 0
    def invoke(self, msgs):
        self.n += 1
        if self.n == 1 or self.always:
            return AIMessage(content="", tool_calls=[{"name": "entity", "args": {"entity_id": "imp-process-kyc"}, "id": f"c{self.n}"}],
                             usage_metadata=usage(300, 20), response_metadata={"model_name": "fake-model"})
        return AIMessage(content="Verified.", usage_metadata=usage(300, 40), response_metadata={"model_name": "fake-model"})


def world(with_mappings=True):
    con = FakeCon(); GR._CON = con; GR._checkpointer = lambda: MemorySaver(); GR._GRAPH = None
    GR.MAX_TOKENS_RUN = 120000; GR.MAX_TOOL_CALLS = 6
    G.regulation_context = lambda c, rid, **kw: None if rid == "missing" else {
        "regulation": {"id": rid, "title": "T"}, "changeStatus": {}, "obligations": [{"id": "o1"}], "sections": [],
        "existingMappings": ([{"target_id": "imp-process-kyc", "obligation_id": "o1", "confidence": 62, "reason": "name"},
                              {"target_id": "ghost-entity", "obligation_id": "o1", "confidence": 40, "reason": "invented"}] if with_mappings else [])}
    G.company_context = lambda c, **kw: {"entityCount": 1, "entitiesByDomain": {"processes": [{"id": "imp-process-kyc", "name": "KYC", "type": "process"}]}, "profile": {}}
    G.retrieval_context = lambda q, rid, k=6: []
    G.validate_impacts = lambda c, rid, items: {"kept": [i for i in items if i["entity_id"] != "ghost-entity"],
                                               "dropped": [{"item": i, "reason": "no such entity"} for i in items if i["entity_id"] == "ghost-entity"],
                                               "hallucinationRate": 0.0}
    class Mem:
        def search(self, *a, **k): return []
        def add(self, *a, **k): pass
    GR.get_memory = lambda c: Mem()
    G.citation_targets = lambda c, rid: {"o1", "s.1", "1"}
    E.apply_severity = lambda c, rid, impacts: impacts
    E._persist = lambda c, rid, out: {"runId": 1, "proposalsWritten": len(out["impacts"])}
    return con

def model_route(S, tools=None):
    llm_lc.chain = lambda schema=None: S(schema) if schema else object()
    llm_lc.tool_chain = lambda t: tools if tools is not None else ToolChain()

def no_model():
    llm_lc.chain = lambda schema=None: None
    llm_lc.tool_chain = lambda t: None


# ------------------------------------------------------------------ cases
def case_no_key_takes_deterministic_route():
    world(); no_model()
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    assert r["route"] == "deterministic" and r["status"] == "ANALYSED", r["status"]
    assert len(r["impacts"]) == 1 and len(r["validation"]["dropped"]) == 1, "grounding must drop the invented mapping"

def case_missing_regulation_fails_cleanly():
    world(); no_model()
    r = GR.analyse(GR._CON, "missing", persist=False)
    assert r["status"] == "NO_REGULATION" and r["route"] == "none" and r["impacts"] == []

def case_applies_no_stops_before_impacts():
    world(); S, _ = structured(applies="NO"); model_route(S)
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    assert r["status"] == "NOT_APPLICABLE" and [t["stage"] for t in r["trace"]] == ["applicability"]

def case_invented_id_triggers_one_reprompt_then_stops():
    world(); S, calls = structured(invent_first=True); model_route(S)
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    assert calls["impacts"] == 2, f"impacts stage should run exactly twice, ran {calls['impacts']}"
    assert r["impacts"] and r["impacts"][0]["entity_id"] == "imp-process-kyc"

def case_low_confidence_interrupts_and_resume_completes():
    world(); S, _ = structured(impact_conf=30); model_route(S)
    r = GR.analyse(GR._CON, "reg-1", persist=False, thread_id="t-gate")
    assert r["status"] == "AWAITING_REVIEW" and len(r["pending"]) == 1 and "resume" in r
    r2 = GR.resume(GR._CON, "t-gate", [{"entity_id": "imp-process-kyc", "outcome": "approve", "note": "ok"}])
    assert r2["status"] == "ANALYSED" and len(r2["impacts"]) == 1 and len(r2["actions"]) == 1

def case_reviewer_reject_removes_impact():
    world(); S, _ = structured(impact_conf=30); model_route(S)
    GR.analyse(GR._CON, "reg-1", persist=False, thread_id="t-rej")
    r = GR.resume(GR._CON, "t-rej", [{"entity_id": "imp-process-kyc", "outcome": "reject", "note": "not us"}])
    assert r["impacts"] == [] and any("rejected" in n for n in r["notes"])

def case_budget_halts_with_a_recorded_reason():
    world(); S, _ = structured(); model_route(S); GR.MAX_TOKENS_RUN = 500; GR._GRAPH = None
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    assert r["status"] == "BUDGET_HALTED" and [t["stage"] for t in r["trace"]] == ["applicability"]
    assert any("halted" in n for n in r["notes"])

def case_tools_run_and_findings_reach_impacts():
    world(); S, _ = structured(); model_route(S, ToolChain())
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    res = next(t for t in r["trace"] if t["stage"] == "research")
    assert res["tool_calls"] == 1 and r["status"] == "ANALYSED"

def case_runaway_tool_use_is_capped():
    world(); S, _ = structured(); model_route(S, ToolChain(always=True))
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    res = next(t for t in r["trace"] if t["stage"] == "research")
    assert res["tool_calls"] == GR.MAX_TOOL_CALLS, res["tool_calls"]

def case_tokens_are_accounted_across_stages():
    world(); S, _ = structured(); model_route(S)
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    stages = [t["stage"] for t in r["trace"]]
    assert stages == ["applicability", "research", "impacts", "actions", "critique"], stages
    assert r["tokens"]["input"] == 4 * 1000 + 600 and r["model_rung"] == "fake-model", r["tokens"]

def case_critique_withdraws_unsupported():
    world(); S, _ = structured(); 
    class S2(S):
        def invoke(self, msgs):
            if self.s is M.Critique:
                return {"parsed": M.Critique(verdicts=[{"entity_id": "imp-process-kyc", "supported": False, "problem": "no clause"}], overall="unsound"), "raw": Raw()}
            return super().invoke(msgs)
    model_route(S2)
    r = GR.analyse(GR._CON, "reg-1", persist=False)
    assert r["impacts"] == [] and any("withdrew" in n for n in r["notes"])

def case_interrupted_run_is_listed_as_pending():
    con = world(); S, _ = structured(impact_conf=30); model_route(S)
    GR.analyse(con, "reg-1", persist=True, thread_id="t-pend")
    assert con.rows and con.rows[-1][1] == "AWAITING_REVIEW", con.rows

CASES = [v for k, v in sorted(globals().items()) if k.startswith("case_")]


def run() -> dict:
    passed, failed = 0, []
    for c in CASES:
        try:
            c(); passed += 1; print(f"  ✓ {c.__name__}")
        except Exception as e:  # noqa: BLE001
            failed.append(c.__name__); print(f"  ✗ {c.__name__}: {type(e).__name__}: {e}")
            if os.environ.get("EVALS_VERBOSE"): traceback.print_exc()
    print(f"\n  {passed} passed, {len(failed)} failed of {len(CASES)}")
    return {"passed": passed, "failed": failed, "total": len(CASES)}


if __name__ == "__main__":
    sys.exit(0 if not run()["failed"] else 1)
