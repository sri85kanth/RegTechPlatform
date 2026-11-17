"""
The Impact Engine.

ORCHESTRATION CHOICE
--------------------
A deterministic typed pipeline, not a free-running ReAct agent.

For a compliance product this is not a stylistic preference. A regulator-facing
conclusion has to be reproducible and auditable: the same input must produce the
same stages, each stage must be inspectable, and a failure has to be attributable
to a named step. A loop that decides its own next action gives up all three, and
buys autonomy this task does not need — the steps are known in advance.

    0 GROUND      deterministic   assemble verified context from the company_brain database
    1 APPLICABILITY  llm          does this reach us at all, and on what facts
    2 IMPACT         llm          which of OUR entities are hit
    3 ACTIONS        llm          what has to change
    4 CRITIQUE       llm          adversarial pass: what here is unsupported
    5 VALIDATE     deterministic  drop anything citing ids that do not exist
    6 PERSIST      deterministic  write as PROPOSALS awaiting human approval

Stage 0, 5 and 6 never call a model. If every model rung is unavailable, the
engine still returns a real answer from the deterministic matcher/scorer,
labelled DETERMINISTIC_FALLBACK.

EDGE CASES ARE FIRST-CLASS
--------------------------
Handled explicitly rather than left to the model's discretion — see EDGE_CASES.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from . import grounding as G
from . import llm as L
from . import schemas as S
from .memory import get_memory

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

SYSTEM = """You are a regulatory impact analyst for an Indian financial services firm.

Rules you must not break:
- You may ONLY reference company entities by the exact ids given to you. Never invent an id.
- Every claim must be traceable to a clause or obligation provided in the context.
- If the evidence provided does not settle a question, say INSUFFICIENT_EVIDENCE. Do not guess.
- An amendment MENTIONED in a document's footnotes is not a change DETECTED by comparing
  versions. Never describe the former as the latter.
- Your output is a PROPOSAL for a human reviewer, never a decision and never official text.
- Return only JSON. No prose outside it."""

EDGE_CASES = {
    "NO_REGULATION": "regulation id not in the database",
    "NO_COMPANY_DATA": "no company entities ingested — nothing to assess impact against",
    "NO_OBLIGATIONS": "regulation has no extracted obligations; impact would be speculation",
    "NOT_APPLICABLE": "applicability stage concluded the regulation does not reach this firm",
    "INSUFFICIENT_EVIDENCE": "model could not decide on the evidence available",
    "MENTION_NOT_DETECTION": "status is AMENDMENT_MENTIONED — no version comparison exists",
    "NO_MODEL": "no API key configured; deterministic path used",
    "MODEL_FAILED": "every model rung failed; deterministic path used",
    "LOW_CONFIDENCE": "below the confidence floor — routed to a human rather than proposed",
}

CONFIDENCE_FLOOR = int(__import__("os").environ.get("IMPACT_CONFIDENCE_FLOOR", "55"))


def _extract(res: "L.LLMResult", key: str) -> tuple[list, bool]:
    """
    Pull a list out of a stage reply, reporting whether the shape was as asked.

    Accepts either {"key": [...]} or a bare [...] — models do both — but a reply
    that is neither is a FAILURE, not an empty answer.
    """
    if not res.ok:
        return [], False
    d = res.data
    if isinstance(d, dict) and isinstance(d.get(key), list):
        return d[key], True
    if isinstance(d, list):
        return d, True
    return [], False


def _stage(name: str, res: L.LLMResult) -> dict:
    return {"stage": name, "ok": res.ok, "model": res.model, "provider": res.provider,
            "attempts": res.attempts, "latency_s": res.latency_s,
            "error": res.error or None,
            "reasoningChars": len(res.reasoning or "")}


def analyse(con: sqlite3.Connection, rid: str, *, persist: bool = True,
            use_memory: bool = True) -> dict:
    """Run the pipeline for one regulation. Always returns a result, never raises."""
    started = _now()
    notes: list[str] = []
    trace: list[dict] = []

    # ---- stage 0: ground -------------------------------------------------
    ctx = G.regulation_context(con, rid)
    if not ctx:
        return _fail(rid, "NO_REGULATION", started)
    comp = G.company_context(con)
    if comp["entityCount"] == 0:
        return _fail(rid, "NO_COMPANY_DATA", started)
    if not ctx["obligations"]:
        notes.append(EDGE_CASES["NO_OBLIGATIONS"])
    cs = ctx["changeStatus"]
    if (cs.get("amendmentsMentioned") or 0) > 0 and not (cs.get("computedChanges") or 0):
        # Say this whenever the source records amendments and we have computed no
        # diff — not only when it happens to be the winning status. A re-check can
        # move the status to CHECKED_UNCHANGED while the footnotes still describe
        # amendments, and that distinction must not silently disappear.
        notes.append(
            f"{cs['amendmentsMentioned']} amendment(s) are mentioned in the source document's "
            f"own footnotes. {EDGE_CASES['MENTION_NOT_DETECTION']}")

    mem = get_memory(con)
    recalled = mem.search(ctx["regulation"]["title"] or rid, scope=rid, limit=5) if use_memory else []
    passages = G.retrieval_context(ctx["regulation"]["title"] or rid, rid, k=5)

    # ---- no model? deterministic path ------------------------------------
    st = L.status()
    if not st["available"]:
        notes.append(EDGE_CASES["NO_MODEL"])
        return _deterministic(con, rid, ctx, started, notes, "NO_MODEL", persist=persist)

    base = _prompt_context(ctx, comp, passages, recalled)

    # ---- stage 1: applicability -----------------------------------------
    r1 = L.complete(SYSTEM, base + "\n\nTASK: Decide whether this regulation applies to this firm.",
                    schema_hint=S.APPLICABILITY, prefer_reasoning=True)
    trace.append(_stage("applicability", r1))
    if not r1.ok:
        notes.append(EDGE_CASES["MODEL_FAILED"] + f" ({r1.error})")
        return _deterministic(con, rid, ctx, started, notes, "MODEL_FAILED", trace, persist=persist)
    applic = r1.data if isinstance(r1.data, dict) else {}

    if applic.get("applies") == "NO":
        notes.append(EDGE_CASES["NOT_APPLICABLE"])
        out = _result(rid, "NOT_APPLICABLE", started, applic, [], [], None, notes, trace, "llm")
        if persist:
            out["persisted"] = _persist(con, rid, out)
        return out
    if applic.get("applies") == "INSUFFICIENT_EVIDENCE":
        notes.append(EDGE_CASES["INSUFFICIENT_EVIDENCE"])
        out = _result(rid, "INSUFFICIENT_EVIDENCE", started, applic, [], [], None, notes, trace, "llm")
        if persist:
            out["persisted"] = _persist(con, rid, out)
        return out

    # ---- stage 2: impacts ------------------------------------------------
    r2 = L.complete(SYSTEM, base + f"\n\nApplicability decided: {json.dumps(applic)[:1200]}"
                    "\n\nTASK: Identify which of OUR entities this affects. Use only ids from the list.",
                    schema_hint=S.IMPACTS, prefer_reasoning=True)
    trace.append(_stage("impacts", r2))
    # A reply can parse as JSON and still be the wrong shape. Treating that as
    # "no impacts found" would report a silent failure as a clean result.
    raw_impacts, shape_ok = _extract(r2, "impacts")
    if r2.ok and not shape_ok:
        notes.append("impacts stage returned an unexpected shape — treated as no result, not as 'none found'")
        trace[-1]["shapeError"] = True

    # ---- stage 5a: validate before spending more tokens on invented ids ---
    v = G.validate_impacts(con, rid, raw_impacts)
    v["kept"], bad_cites = G.scrub_citations(apply_severity(con, rid, v["kept"]),
                                             G.citation_targets(con, rid))
    if bad_cites:
        notes.append(f"{bad_cites} invented citation(s) removed")
    impacts = v["kept"]
    if v["dropped"]:
        notes.append(f"{len(v['dropped'])} impact(s) dropped for citing ids that do not exist")

    low = [i for i in impacts if (i.get("confidence") or 0) < CONFIDENCE_FLOOR]
    if low:
        notes.append(f"{len(low)} impact(s) below the confidence floor ({CONFIDENCE_FLOOR}) — flagged for review")
        for i in low:
            i["needs_human_review"] = True

    # ---- stage 3: actions ------------------------------------------------
    actions = []
    if impacts:
        r3 = L.complete(SYSTEM, base + f"\n\nConfirmed impacts: {json.dumps(impacts)[:2500]}"
                        "\n\nTASK: Propose the concrete actions required.",
                        schema_hint=S.ACTIONS)
        trace.append(_stage("actions", r3))
        actions, a_ok = _extract(r3, "actions")
        if r3.ok and not a_ok:
            notes.append("actions stage returned an unexpected shape")
            trace[-1]["shapeError"] = True
        va = G.validate_impacts(con, rid, actions)
        actions = va["kept"]
        if va["dropped"]:
            notes.append(f"{len(va['dropped'])} action(s) dropped for citing ids that do not exist")

    # ---- stage 4: adversarial critique -----------------------------------
    critique = None
    if impacts:
        r4 = L.complete(SYSTEM,
                        base + f"\n\nProposed impacts: {json.dumps(impacts)[:2500]}"
                        "\n\nTASK: Argue AGAINST these. For each, say whether the evidence "
                        "provided actually supports it. Default to unsupported when unsure.",
                        schema_hint=S.CRITIQUE, prefer_reasoning=True)
        trace.append(_stage("critique", r4))
        critique = r4.data if r4.ok else None
        if isinstance(critique, dict):
            bad = {x.get("entity_id") for x in critique.get("verdicts", [])
                   if x.get("supported") is False}
            for i in impacts:
                if i.get("entity_id") in bad:
                    i["disputed_by_critique"] = True
                    i["needs_human_review"] = True
            if bad:
                notes.append(f"{len(bad)} impact(s) disputed by the critique pass — flagged, not removed")

    out = _result(rid, "ANALYSED", started, applic, impacts, actions, critique, notes, trace, "llm")
    out["validation"] = {"dropped": v["dropped"], "hallucinationRate": v["hallucinationRate"]}
    out["memoryUsed"] = [r.get("text", "")[:160] for r in recalled]
    if persist:
        out["persisted"] = _persist(con, rid, out)
    return out


def _prompt_context(ctx, comp, passages, recalled) -> str:
    """What the model sees. Entity ids are listed so it can only choose, not invent."""
    ents = {d: [{"id": e["id"], "name": e["name"], "type": e["type"]} for e in v]
            for d, v in comp["entitiesByDomain"].items()}
    parts = [
        "REGULATION:\n" + json.dumps(ctx["regulation"], indent=1),
        "CHANGE STATUS (a mention is not a detection):\n" + json.dumps(ctx["changeStatus"], indent=1),
        "OBLIGATIONS:\n" + json.dumps(ctx["obligations"][:25], indent=1)[:6000],
        "CLAUSE TEXT:\n" + json.dumps(ctx["sections"][:8], indent=1)[:7000],
        "OUR COMPANY PROFILE:\n" + json.dumps(comp["profile"], indent=1)[:1500],
        "OUR ENTITIES — you may only cite ids from here:\n" + json.dumps(ents, indent=1)[:9000],
        "EXISTING MAPPINGS (already proposed previously):\n" + json.dumps(ctx["existingMappings"][:20], indent=1)[:2000],
    ]
    if ctx.get("penalties"):
        parts.append("PENALTY EXPOSURE (statutory, from this regulation's own text — "
                     "cite when judging severity):\n" + json.dumps(ctx["penalties"], indent=1)[:1200])
    if passages:
        parts.append("RETRIEVED PASSAGES:\n" + json.dumps(passages, indent=1)[:4000])
    if recalled:
        parts.append("PRIOR HUMAN DECISIONS (weigh these; they are corrections from reviewers):\n"
                     + json.dumps([r.get("text") for r in recalled], indent=1)[:2000])
    return "\n\n".join(parts)


_SEV_ORDER = ["low", "medium", "high", "critical"]


def apply_severity(con, rid: str, impacts: list[dict]) -> list[dict]:
    """
    Severity by arithmetic, not model vibes: the regulation's own statutory
    ceiling caps how bad failure CAN be, and the entity's criticality says how
    much of that reaches us. The model's opinion is preserved as
    model_severity; the number a reviewer defends is computed.
    """
    row = con.execute(
        """SELECT MAX(amount_max) AS mx,
                  MAX(per_day_amount) AS pd,
                  COUNT(*) FILTER (WHERE kind='MULTIPLIER_OF_SUM') AS mult,
                  COUNT(*) FILTER (WHERE kind='IMPRISONMENT') AS prison
           FROM penalty_provisions WHERE regulation_id=?""", (rid,)).fetchone()
    mx = (row["mx"] or 0) if row else 0
    heavy = bool(row and (row["mult"] or row["prison"] or (row["pd"] or 0) >= 10_000))
    if heavy or mx >= 10_000_000:
        ceiling = "critical"
    elif mx >= 100_000:
        ceiling = "high"
    elif mx > 0:
        ceiling = "medium"
    else:
        ceiling = "medium"          # no extracted ceiling is unknown, not harmless
    crit = {r["id"]: (r["criticality"] or "Medium")
            for r in con.execute("SELECT id, criticality FROM company_entities")}
    bump = {"Critical": 1, "High": 0, "Medium": -1, "Low": -2}
    cap = _SEV_ORDER.index(ceiling)
    for i in impacts:
        if i.get("severity") and "model_severity" not in i:
            i["model_severity"] = i["severity"]
        rank = max(0, min(cap, cap + bump.get(crit.get(i.get("entity_id"), "Medium"), -1)))
        i["severity"] = _SEV_ORDER[rank]
        i["severity_basis"] = f"ceiling={ceiling} × entity criticality={crit.get(i.get('entity_id'), 'Medium')}"
    return impacts


def deterministic_candidates(ctx) -> list[dict]:
    """
    Everything the rules already know about this regulation: human-reviewed
    mappings first, then the matcher's own impact_relationships (whose
    confidence is stored 0-1), deduplicated on (obligation, entity).
    """
    out, seen = [], set()
    for label, items in (("mapping", ctx.get("existingMappings") or []),
                         ("rule", ctx.get("ruleMatches") or [])):
        for m in items:
            key = (m.get("obligation_id"), m.get("target_id"))
            if not m.get("target_id") or key in seen:
                continue
            seen.add(key)
            conf = m.get("confidence") or 50
            if conf <= 1:
                conf = round(conf * 100)
            reason = m.get("reason") or "Proposed by the deterministic matching engine."
            if label == "rule":
                reason = f"Rule-engine match: {reason}"
            out.append({
                "entity_id": m["target_id"], "obligation_id": m.get("obligation_id"),
                "impact_type": "needs_review", "severity": "medium",
                "confidence": int(conf), "rationale": reason,
                "needs_human_review": True,
            })
    return out


def _deterministic(con, rid, ctx, started, notes, reason, trace=None, persist=True) -> dict:
    """
    No model. Fall back to the existing rule-based matcher and scorer.

    This is a real answer from real rules, clearly labelled — not a stub, and not
    an LLM result pretending to be one.
    """
    impacts = apply_severity(con, rid, deterministic_candidates(ctx))
    v = G.validate_impacts(con, rid, impacts)
    res = _result(rid, "ANALYSED" if v["kept"] else "INSUFFICIENT_EVIDENCE", started,
                  {"applies": "PARTIAL" if v["kept"] else "INSUFFICIENT_EVIDENCE",
                   "confidence": 40,
                   "reasoning": "Derived from keyword/IDF matching only. No model reasoning was applied."},
                  v["kept"], [], None, notes, trace or [], "deterministic")
    res["fallbackReason"] = reason
    res["validation"] = {"dropped": v["dropped"], "hallucinationRate": v["hallucinationRate"]}
    if persist:
        res["persisted"] = _persist(con, rid, res)
    return res


def _result(rid, status, started, applic, impacts, actions, critique, notes, trace, route) -> dict:
    return {
        "regulation_id": rid, "status": status, "route": route,
        "engine": "impact-engine/1", "startedAt": started, "finishedAt": _now(),
        "applicability": applic, "impacts": impacts, "actions": actions,
        "critique": critique, "notes": notes, "trace": trace,
        "disclaimer": "AI-generated proposal. Not official text and not a compliance decision. "
                      "Every item requires human approval before it means anything.",
    }


def _fail(rid, code, started) -> dict:
    return {"regulation_id": rid, "status": code, "route": "none",
            "reason": EDGE_CASES.get(code, code), "startedAt": started, "finishedAt": _now(),
            "impacts": [], "actions": [], "notes": [EDGE_CASES.get(code, code)]}


def _persist(con: sqlite3.Connection, rid: str, out: dict) -> dict:
    """
    Write impacts as PROPOSALS. Never as approved mappings — the standing rule is
    that a human approves, so nothing here may enter an approved state.
    """
    con.executescript("""
    CREATE TABLE IF NOT EXISTS impact_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      regulation_id TEXT NOT NULL, status TEXT, route TEXT, model TEXT,
      impacts INTEGER, actions INTEGER, hallucination_rate REAL,
      payload TEXT NOT NULL, ran_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_iruns_reg ON impact_runs(regulation_id);
    """)
    model = next((t["model"] for t in out.get("trace", []) if t.get("model")), "")
    cur = con.execute(
        """INSERT INTO impact_runs (regulation_id,status,route,model,impacts,actions,
                                    hallucination_rate,payload,ran_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (rid, out["status"], out["route"], model, len(out["impacts"]), len(out["actions"]),
         (out.get("validation") or {}).get("hallucinationRate"), json.dumps(out), _now()))
    run_id = cur.lastrowid

    written = 0
    for i in out["impacts"]:
        if not i.get("obligation_id"):
            continue
        exists = con.execute(
            "SELECT 1 FROM company_mappings WHERE obligation_id=? AND target_id=?",
            (i["obligation_id"], i["entity_id"])).fetchone()
        if exists:
            continue
        dom = con.execute("SELECT domain FROM company_entities WHERE id=?",
                          (i["entity_id"],)).fetchone()
        # id has no default in Postgres; mint it the way the matcher does
        # (map-<obligation>-<entity>) — idempotent with the exists-check above
        con.execute(
            """INSERT INTO company_mappings
               (id, obligation_id, target_id, target_domain, status, confidence, reason, source, created_by, created_at)
               VALUES (?,?,?,?,'Proposed',?,?,?,?,?)""",
            (f"map-{i['obligation_id']}-{i['entity_id']}"[:200],
             i["obligation_id"], i["entity_id"], dom["domain"] if dom else None,
             i.get("confidence") or 0, (i.get("rationale") or "")[:500],
             "impact-engine", out["route"], _now()))
        written += 1
    con.commit()
    return {"runId": run_id, "proposalsWritten": written,
            "note": "Written with status='Proposed'. Nothing is approved by the engine."}
