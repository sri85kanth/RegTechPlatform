"""
The impact agent as a LangGraph state graph.

Same four stages as engine.py — applicability, impacts, actions, critique — and
the same guard-rails, now as nodes: the grounding validator, the deterministic
fallback, the confidence floor. What the graph adds is everything between the
stages: a budget check before every model call, one re-prompt when the validator
drops everything, a real human gate (interrupt) instead of a note, checkpoints
so a run resumes from the last good node, and a trace for every hop.

Persistence is byte-compatible: `persist` builds the dict engine._persist has
always written, so impact_runs and the UI do not change.
"""
from __future__ import annotations
import json
import os
import time
from typing import Any, Literal, TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command, RetryPolicy
from langgraph.checkpoint.memory import MemorySaver

from . import grounding as G
from . import engine as E
from . import llm_lc
from . import models as M
from . import tracing
from .memory import get_memory
from .tools import TOOLS
from langgraph.prebuilt import ToolNode
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage, ToolMessage

MAX_TOOL_CALLS = int(os.environ.get("AGENT_MAX_TOOL_CALLS", "6"))

MAX_TOKENS_RUN = int(os.environ.get("AGENT_MAX_TOKENS_RUN", "120000"))   # a 6-tool run peaks near 93k
MAX_USD_DAY = float(os.environ.get("AGENT_MAX_USD_DAY", "10"))
PRICE_IN = float(os.environ.get("AGENT_PRICE_IN_PER_M", "0"))     # $/M input; 0 = tokens-only budget
PRICE_OUT = float(os.environ.get("AGENT_PRICE_OUT_PER_M", "0"))
FLOOR = E.CONFIDENCE_FLOOR
RETRY = RetryPolicy(max_attempts=3, initial_interval=1.0, backoff_factor=2.0)


class ImpactState(TypedDict, total=False):
    regulation_id: str
    persist: bool
    use_memory: bool
    started: str
    # grounding
    ctx: dict
    comp: dict
    passages: list
    recalled: list
    base_prompt: str
    # stages
    applicability: dict
    impacts: list
    dropped: list
    reprompted: bool
    actions: list
    critique: dict
    # routing / accounting
    route: Literal["model", "deterministic", "none"]
    model_rung: str
    tokens_in: int
    tokens_out: int
    cost_usd: float
    over_budget: str
    notes: list
    trace: list
    status: str
    # research (tool use before the impacts stage)
    research_notes: str
    tool_calls_made: int
    # human gate
    pending_review: list
    decisions: list
    # output
    result: dict
    persisted: dict


# ------------------------------------------------------------------ helpers
_CON = None


def _con():
    global _CON
    if _CON is None:
        from ..db import connect
        _CON = connect()
    return _CON


def _cost(tin: int, tout: int) -> float:
    return (tin * PRICE_IN + tout * PRICE_OUT) / 1_000_000


def _spent_today(con) -> float:
    try:
        rows = con.execute(
            "SELECT payload FROM impact_runs WHERE ran_at >= ? AND route='model'",
            (time.strftime("%Y-%m-%dT00:00:00"),)).fetchall()
        return sum((json.loads(r[0]).get("cost_usd") or 0) for r in rows)
    except Exception:
        return 0.0


def _stage(name: str, rung: str, tin: int, tout: int, ok: bool, err: str = "") -> dict:
    return {"stage": name, "model": rung, "ok": ok, "error": err,
            "usage": {"input_tokens": tin, "output_tokens": tout}, "at": E._now()}


def _call(state: ImpactState, schema, name: str, user: str) -> tuple[Any, ImpactState]:
    """One structured model call: fallbacks, usage accounting, trace, budget."""
    ch = llm_lc.chain(schema)
    if ch is None:
        raise RuntimeError("NO_MODEL")
    res = ch.invoke([("system", E.SYSTEM), ("user", user + llm_lc.schema_hint(schema))])
    parsed = res.get("parsed") if isinstance(res, dict) else res
    tin, tout = llm_lc.usage_of(res)
    raw = res.get("raw") if isinstance(res, dict) else None
    rung = getattr(raw, "response_metadata", {}).get("model_name", "") or (llm_lc.rung_names() or [""])[0]
    upd: ImpactState = {
        "tokens_in": state.get("tokens_in", 0) + tin,
        "tokens_out": state.get("tokens_out", 0) + tout,
        "model_rung": rung,
        "trace": state.get("trace", []) + [_stage(name, rung, tin, tout, parsed is not None)],
    }
    upd["cost_usd"] = _cost(upd["tokens_in"], upd["tokens_out"])
    if parsed is None:
        raise RuntimeError(f"{name}: model returned nothing parseable")
    return parsed, upd


# -------------------------------------------------------------------- nodes
def ground(state: ImpactState) -> ImpactState:
    con = _con(); rid = state["regulation_id"]
    ctx = G.regulation_context(con, rid)
    if not ctx:
        return {"status": "NO_REGULATION", "route": "none", "notes": [E.EDGE_CASES["NO_REGULATION"]]}
    comp = G.company_context(con)
    if comp["entityCount"] == 0:
        return {"status": "NO_COMPANY_DATA", "route": "none", "notes": [E.EDGE_CASES["NO_COMPANY_DATA"]]}
    notes = []
    if not ctx["obligations"]:
        notes.append(E.EDGE_CASES["NO_OBLIGATIONS"])
    cs = ctx.get("changeStatus") or {}
    if (cs.get("amendmentsMentioned") or 0) > 0 and not (cs.get("computedChanges") or 0):
        notes.append(E.EDGE_CASES["MENTION_NOT_DETECTION"])
    passages = G.retrieval_context(ctx["regulation"]["title"] or rid, rid, k=6)
    recalled = get_memory(con).search(ctx["regulation"]["title"] or rid, scope=rid, limit=5) \
        if state.get("use_memory", True) else []
    return {"ctx": ctx, "comp": comp, "passages": passages, "recalled": recalled,
            "base_prompt": E._prompt_context(ctx, comp, passages, recalled),
            "notes": notes, "trace": [], "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0,
            "dropped": [], "impacts": [], "actions": [], "reprompted": False}


def route(state: ImpactState) -> ImpactState:
    if llm_lc.chain() is None:
        return {"route": "deterministic", "notes": state["notes"] + [E.EDGE_CASES["NO_MODEL"]]}
    return {"route": "model"}


def budget(state: ImpactState) -> ImpactState:
    """Before every model call. Halting is a recorded outcome, not an exception."""
    if state.get("tokens_in", 0) >= MAX_TOKENS_RUN:
        return {"over_budget": f"run exceeded {MAX_TOKENS_RUN} input tokens"}
    if PRICE_IN and _spent_today(_con()) + state.get("cost_usd", 0.0) >= MAX_USD_DAY:
        return {"over_budget": f"daily ceiling ${MAX_USD_DAY} reached"}
    return {"over_budget": ""}


def deterministic(state: ImpactState) -> ImpactState:
    """engine._deterministic, as a node: real rules, clearly labelled."""
    con = _con(); rid = state["regulation_id"]
    impacts = E.apply_severity(con, rid, E.deterministic_candidates(state["ctx"]))
    v = G.validate_impacts(con, rid, impacts)
    return {"impacts": v["kept"], "dropped": v["dropped"], "route": "deterministic",
            "applicability": {"applies": "PARTIAL" if v["kept"] else "INSUFFICIENT_EVIDENCE",
                              "confidence": 40,
                              "reasoning": "Derived from keyword/IDF matching only. No model reasoning was applied."},
            "status": "ANALYSED" if v["kept"] else "INSUFFICIENT_EVIDENCE"}


def applicability(state: ImpactState) -> ImpactState:
    parsed, upd = _call(state, M.Applicability, "applicability",
                        state["base_prompt"] + "\n\nTASK: Decide whether this regulation applies to this firm. "
                        "Ground the verdict: put the section numbers or obligation ids you relied on in citations[].")
    a = parsed.model_dump()
    upd["applicability"] = a
    if a["applies"] == "NO":
        upd["status"] = "NOT_APPLICABLE"; upd["notes"] = state["notes"] + [E.EDGE_CASES["NOT_APPLICABLE"]]
    elif a["applies"] == "INSUFFICIENT_EVIDENCE":
        upd["status"] = "INSUFFICIENT_EVIDENCE"; upd["notes"] = state["notes"] + [E.EDGE_CASES["INSUFFICIENT_EVIDENCE"]]
    return upd


def research(state: ImpactState) -> ImpactState:
    """
    Let the model ask before it asserts. A tool-bound chain may call entity /
    clause / search / threshold / company_fact / prior_runs up to MAX_TOOL_CALLS
    times; what it learns is appended to the prompt the impacts stage sees.
    Read-only by construction, and a confused model cannot loop up the bill.
    """
    ch = llm_lc.tool_chain(TOOLS)
    if ch is None:
        return {"research_notes": "", "tool_calls_made": 0}
    node = ToolNode(TOOLS)
    msgs = [SystemMessage(E.SYSTEM),
            HumanMessage(state["base_prompt"] + f"\n\nApplicability decided: {json.dumps(state['applicability'])[:800]}"
                         + "\n\nBefore listing impacts, look up anything you are unsure of with the tools "
                         "(an entity's owner, the exact clause text, a threshold). When you have what you need, "
                         "reply with a short plain-text summary of what you verified and stop calling tools.")]
    made, tin, tout, notes, rung = 0, 0, 0, [], state.get("model_rung", "")
    while True:
        ai = ch.invoke(msgs)
        u = getattr(ai, "usage_metadata", None) or {}
        tin += int(u.get("input_tokens") or 0); tout += int(u.get("output_tokens") or 0)
        rung = getattr(ai, "response_metadata", {}).get("model_name", rung) or rung
        msgs.append(ai)
        calls = getattr(ai, "tool_calls", None) or []
        if not calls or made >= MAX_TOOL_CALLS:
            if calls:
                notes.append(f"[tool budget of {MAX_TOOL_CALLS} reached; {len(calls)} request(s) not executed]")
            break
        out = node.invoke({"messages": msgs})
        results = [m for m in out["messages"] if isinstance(m, ToolMessage)]
        msgs.extend(results)
        made += len(results)
        for c, r in zip(calls, results):
            notes.append(f"{c['name']}({json.dumps(c.get('args', {}))[:120]}) -> {str(r.content)[:300]}")
    summary = (ai.content if isinstance(ai.content, str) else json.dumps(ai.content))[:1500]
    return {"research_notes": "\n".join(notes + [f"MODEL SUMMARY: {summary}"])[:6000],
            "tool_calls_made": made, "model_rung": rung,
            "tokens_in": state.get("tokens_in", 0) + tin, "tokens_out": state.get("tokens_out", 0) + tout,
            "cost_usd": _cost(state.get("tokens_in", 0) + tin, state.get("tokens_out", 0) + tout),
            "trace": state.get("trace", []) + [_stage("research", rung, tin, tout, True) | {"tool_calls": made}]}


def impacts(state: ImpactState) -> ImpactState:
    research_block = (f"\n\nWHAT YOU VERIFIED WITH TOOLS:\n{state['research_notes']}" if state.get("research_notes") else "")
    user = (state["base_prompt"] + research_block + f"\n\nApplicability decided: {json.dumps(state['applicability'])[:1200]}"
            + "\n\nTASK: List the concrete impacts on OUR entities. Cite only ids from the list; "
              "in each impact's citations[] name the section numbers or obligation ids that ground it.")
    if state.get("dropped") and not state.get("reprompted"):
        user += ("\n\nYOUR PREVIOUS ANSWER WAS REJECTED. These items referenced ids that do not exist:\n"
                 + json.dumps(state["dropped"][:10], indent=1)[:2000]
                 + "\nAnswer again using only ids from the list above.")
    parsed, upd = _call(state, M.Impacts, "impacts", user)
    upd["impacts"] = [i.model_dump() for i in parsed.impacts]
    if state.get("dropped"):
        upd["reprompted"] = True
    return upd


def validate(state: ImpactState) -> ImpactState:
    con = _con(); rid = state["regulation_id"]
    v = G.validate_impacts(con, rid, state["impacts"])
    notes = list(state["notes"])
    if v["dropped"]:
        notes.append(f"{len(v['dropped'])} impact(s) dropped by grounding — invented or foreign ids")
    kept, bad_cites = G.scrub_citations(E.apply_severity(con, rid, v["kept"]),
                                        G.citation_targets(con, rid))
    if bad_cites:
        notes.append(f"{bad_cites} invented citation(s) removed — the claim stays, its footnote does not")
    return {"impacts": kept, "dropped": v["dropped"], "notes": notes}


def confidence_floor(state: ImpactState) -> ImpactState:
    low = [i for i in state["impacts"] if (i.get("confidence") or 0) < FLOOR]
    if not low:
        return {"pending_review": []}
    return {"pending_review": low,
            "notes": state["notes"] + [f"{len(low)} impact(s) below the confidence floor ({FLOOR}) — held for a reviewer"]}


def human_review(state: ImpactState) -> ImpactState:
    """The run stops here. A person decides; resume carries their decisions in."""
    decisions = interrupt({
        "regulation_id": state["regulation_id"],
        "pending": state["pending_review"],
        "instructions": "For each entity_id return outcome approve | edit | reject (edit carries a replacement impact).",
    })
    return {"decisions": decisions if isinstance(decisions, list) else []}


def apply_decisions(state: ImpactState) -> ImpactState:
    by = {d.get("entity_id"): d for d in state.get("decisions", []) if isinstance(d, dict)}
    kept, notes = [], list(state["notes"])
    for i in state["impacts"]:
        d = by.get(i["entity_id"])
        if d is None or d.get("outcome") == "approve":
            kept.append(i)
        elif d.get("outcome") == "edit" and d.get("edited"):
            kept.append({**i, **d["edited"], "reviewer_edited": True})
        else:
            notes.append(f"reviewer rejected impact on {i['entity_id']}")
    return {"impacts": kept, "notes": notes}


def actions(state: ImpactState) -> ImpactState:
    if not state["impacts"]:
        return {"actions": []}
    parsed, upd = _call(state, M.Actions, "actions",
                        state["base_prompt"] + f"\n\nConfirmed impacts: {json.dumps(state['impacts'])[:2500]}"
                        + "\n\nTASK: Propose the concrete actions these impacts require.")
    upd["actions"] = [a.model_dump() for a in parsed.actions]
    return upd


def validate_actions(state: ImpactState) -> ImpactState:
    va = G.validate_impacts(_con(), state["regulation_id"], state["actions"])
    notes = list(state["notes"])
    if va["dropped"]:
        notes.append(f"{len(va['dropped'])} action(s) dropped by grounding")
    return {"actions": va["kept"], "notes": notes}


def critique(state: ImpactState) -> ImpactState:
    if not state["impacts"]:
        return {"critique": None}
    parsed, upd = _call(state, M.Critique, "critique",
                        state["base_prompt"] + f"\n\nProposed impacts: {json.dumps(state['impacts'])[:2500]}"
                        + "\n\nTASK: Judge each impact strictly against the clause text provided.")
    upd["critique"] = parsed.model_dump()
    return upd


def drop_unsupported(state: ImpactState) -> ImpactState:
    c = state.get("critique") or {}
    bad = {v["entity_id"] for v in c.get("verdicts", []) if v.get("supported") is False}
    if not bad:
        return {}
    return {"impacts": [i for i in state["impacts"] if i["entity_id"] not in bad],
            "notes": state["notes"] + [f"critique withdrew {len(bad)} unsupported impact(s)"]}


def persist(state: ImpactState) -> ImpactState:
    rid = state["regulation_id"]
    status = state.get("status") or ("BUDGET_HALTED" if state.get("over_budget") else "ANALYSED")
    if state.get("over_budget"):
        state = {**state, "notes": state.get("notes", []) + [f"halted: {state['over_budget']}"]}
    out = E._result(rid, status, state.get("started") or E._now(),
                    state.get("applicability"), state.get("impacts", []), state.get("actions", []),
                    state.get("critique"), state.get("notes", []), state.get("trace", []), state.get("route", "none"))
    out["validation"] = {"dropped": state.get("dropped", []),
                         "hallucinationRate": round(len(state.get("dropped", [])) /
                                                    max(len(state.get("impacts", [])) + len(state.get("dropped", [])), 1), 3)}
    out["engine"] = "impact-engine/2-langgraph"
    out["tokens"] = {"input": state.get("tokens_in", 0), "output": state.get("tokens_out", 0)}
    out["cost_usd"] = state.get("cost_usd", 0.0)
    out["model_rung"] = state.get("model_rung", "")
    persisted = E._persist(_con(), rid, out) if state.get("persist", True) else {"skipped": True}
    return {"result": out, "persisted": persisted, "status": status}


def memorise(state: ImpactState) -> ImpactState:
    if state.get("use_memory", True) and state.get("decisions"):
        mem = get_memory(_con())
        for d in state["decisions"]:
            if isinstance(d, dict) and d.get("note"):
                mem.add(f"{d.get('outcome')}: {d['note']}", scope=state["regulation_id"], kind="decision")
    return {}


# ------------------------------------------------------------------- edges
def after_ground(s): return "persist" if s.get("status") in ("NO_REGULATION", "NO_COMPANY_DATA") else "route"
def after_route(s): return "deterministic" if s["route"] == "deterministic" else "budget_1"
def after_budget(nxt): return lambda s: "persist" if s.get("over_budget") else nxt
def after_applicability(s): return "persist" if s.get("status") in ("NOT_APPLICABLE", "INSUFFICIENT_EVIDENCE") else "budget_2"
def after_validate(s):
    if not s["impacts"] and s["dropped"] and not s.get("reprompted"):
        return "impacts"                                  # one more try, told what it invented
    return "confidence_floor"
def after_floor(s): return "human_review" if s.get("pending_review") else "budget_3"


def build(checkpointer=None):
    g = StateGraph(ImpactState)
    for name, fn in (("ground", ground), ("route", route), ("deterministic", deterministic),
                     ("budget_1", budget), ("budget_2", budget), ("budget_r", budget), ("budget_3", budget), ("budget_4", budget),
                     ("research", research),
                     ("applicability", applicability), ("impacts", impacts), ("validate", validate),
                     ("confidence_floor", confidence_floor), ("human_review", human_review),
                     ("apply_decisions", apply_decisions), ("actions", actions),
                     ("validate_actions", validate_actions), ("critique", critique),
                     ("drop_unsupported", drop_unsupported), ("persist", persist), ("memorise", memorise)):
        g.add_node(name, fn, retry=RETRY if name in ("applicability", "research", "impacts", "actions", "critique") else None)
    g.add_edge(START, "ground")
    g.add_conditional_edges("ground", after_ground, ["persist", "route"])
    g.add_conditional_edges("route", after_route, ["deterministic", "budget_1"])
    g.add_edge("deterministic", "persist")
    g.add_conditional_edges("budget_1", after_budget("applicability"), ["persist", "applicability"])
    g.add_conditional_edges("applicability", after_applicability, ["persist", "budget_2"])
    g.add_conditional_edges("budget_2", after_budget("research"), ["persist", "research"])
    g.add_edge("research", "budget_r")
    g.add_conditional_edges("budget_r", after_budget("impacts"), ["persist", "impacts"])
    g.add_edge("impacts", "validate")
    g.add_conditional_edges("validate", after_validate, ["impacts", "confidence_floor"])
    g.add_conditional_edges("confidence_floor", after_floor, ["human_review", "budget_3"])
    g.add_edge("human_review", "apply_decisions")
    g.add_edge("apply_decisions", "budget_3")
    g.add_conditional_edges("budget_3", after_budget("actions"), ["persist", "actions"])
    g.add_edge("actions", "validate_actions")
    g.add_edge("validate_actions", "budget_4")
    g.add_conditional_edges("budget_4", after_budget("critique"), ["persist", "critique"])
    g.add_edge("critique", "drop_unsupported")
    g.add_edge("drop_unsupported", "persist")
    g.add_edge("persist", "memorise")
    g.add_edge("memorise", END)
    return g.compile(checkpointer=checkpointer or _checkpointer())


def _checkpointer():
    kind = os.environ.get("AGENT_CHECKPOINTER", "postgres")
    if kind == "memory":
        return MemorySaver()
    # from_conn_string() is a context manager whose connection closes with its
    # scope — fine for a script, wrong for a server. Own the connection: a small
    # pool with the settings the checkpointer requires, alive for the process.
    from langgraph.checkpoint.postgres import PostgresSaver
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool
    dsn = os.environ.get("COMPANY_BRAIN_DSN", "postgresql:///company_brain")
    pool = ConnectionPool(dsn, min_size=1, max_size=4, open=True,
                          kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row})
    import atexit
    atexit.register(pool.close)        # scripts and tests exit cleanly; the API keeps it for life
    saver = PostgresSaver(pool)
    saver.setup()                      # creates checkpoint tables if absent; idempotent
    return saver


_GRAPH = None


def graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build()
    return _GRAPH


# --------------------------------------------------------------- entrypoints
def analyse(con, rid: str, *, persist: bool = True, use_memory: bool = True, thread_id: str | None = None) -> dict:
    """Same signature the API has always called. Returns the result, or AWAITING_REVIEW."""
    global _CON
    _CON = con
    thread_id = thread_id or f"{rid}:{int(time.time())}"
    cfg = {"configurable": {"thread_id": thread_id}, "callbacks": tracing.callbacks(),
           "run_name": f"impact:{rid}", "tags": ["impact-engine/2"], "metadata": {"regulation_id": rid}}
    state: ImpactState = {"regulation_id": rid, "persist": persist, "use_memory": use_memory, "started": E._now()}
    out = graph().invoke(state, cfg)
    if out.get("__interrupt__"):
        intr = out["__interrupt__"][0]
        if persist:
            # a paused run must be findable: /pending lists these until resume flips them
            con.execute(
                """INSERT INTO impact_runs (regulation_id,status,route,model,impacts,actions,hallucination_rate,payload,ran_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (rid, "AWAITING_REVIEW", out.get("route", "model"), out.get("model_rung", ""),
                 len(out.get("impacts", [])), 0, None,
                 json.dumps({"thread_id": thread_id, "pending": intr.value.get("pending", []),
                             "notes": out.get("notes", []), "tokens": {"input": out.get("tokens_in", 0), "output": out.get("tokens_out", 0)}}),
                 E._now()))
            con.commit()
        return {"regulation_id": rid, "status": "AWAITING_REVIEW", "thread_id": thread_id,
                "pending": intr.value.get("pending", []), "instructions": intr.value.get("instructions"),
                "route": out.get("route"), "notes": out.get("notes", []),
                "trace": out.get("trace", []), "tokens": {"input": out.get("tokens_in", 0), "output": out.get("tokens_out", 0)},
                "resume": f"POST /api/impact-engine/resume/{thread_id} with [{{entity_id, outcome, note?, edited?}}]"}
    res = out.get("result", {}); res["thread_id"] = thread_id; res["persisted"] = out.get("persisted")
    return res


def resume(con, thread_id: str, decisions: list[dict]) -> dict:
    global _CON
    _CON = con
    cfg = {"configurable": {"thread_id": thread_id}, "callbacks": tracing.callbacks(),
           "run_name": f"impact:resume", "tags": ["impact-engine/2", "resume"]}
    out = graph().invoke(Command(resume=decisions), cfg)
    con.execute("UPDATE impact_runs SET status='RESUMED' WHERE status='AWAITING_REVIEW' AND payload LIKE ?",
                (f'%"thread_id": "{thread_id}"%',))
    con.commit()
    res = out.get("result", {}); res["thread_id"] = thread_id; res["persisted"] = out.get("persisted")
    return res


def pending(con) -> list[dict]:
    """Runs stopped at the human gate and not yet resumed."""
    rows = con.execute(
        "SELECT id, regulation_id, route, model, payload, ran_at FROM impact_runs WHERE status='AWAITING_REVIEW' ORDER BY id DESC").fetchall()
    out = []
    for r in rows:
        p = json.loads(r["payload"])
        out.append({"run_id": r["id"], "regulation_id": r["regulation_id"], "thread_id": p.get("thread_id"),
                    "pending": p.get("pending", []), "route": r["route"], "model": r["model"], "since": r["ran_at"]})
    return out


def stream(con, rid: str, *, persist: bool = False, use_memory: bool = True):
    """Node-by-node updates as they happen — for a live progress view."""
    global _CON
    _CON = con
    thread_id = f"{rid}:{int(time.time())}"
    cfg = {"configurable": {"thread_id": thread_id}, "callbacks": tracing.callbacks(),
           "run_name": f"impact:{rid}", "tags": ["impact-engine/2", "stream"]}
    state: ImpactState = {"regulation_id": rid, "persist": persist, "use_memory": use_memory, "started": E._now()}
    yield {"event": "start", "thread_id": thread_id}
    for update in graph().stream(state, cfg, stream_mode="updates"):
        for node, delta in update.items():
            if node == "__interrupt__":
                yield {"event": "interrupt", "thread_id": thread_id, "pending": delta[0].value.get("pending", [])}
                continue
            summary = {k: (len(v) if isinstance(v, list) else v) for k, v in (delta or {}).items()
                       if k in ("status", "route", "impacts", "dropped", "actions", "tokens_in", "over_budget", "pending_review", "model_rung")}
            yield {"event": "node", "node": node, **summary}
    yield {"event": "end", "thread_id": thread_id}
