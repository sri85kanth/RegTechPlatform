"""
Impact Engine endpoints.

Everything returned here is a PROPOSAL. The engine never approves anything, and
the response says so on every path, because a screen that omits it invites the
reader to treat model output as a compliance decision.
"""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from .api_auth import require

from .db import connect

router = APIRouter(prefix="/api/impact-engine", tags=["impact-engine"], dependencies=[Depends(require("read"))])


@router.get("/status")
def status():
    """What the engine can actually do right now — models, memory, past runs."""
    from .agent import llm as L
    from .agent import memory as M
    con = connect()
    con.executescript("""CREATE TABLE IF NOT EXISTS impact_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, regulation_id TEXT NOT NULL, status TEXT,
      route TEXT, model TEXT, impacts INTEGER, actions INTEGER,
      hallucination_rate REAL, payload TEXT NOT NULL, ran_at TEXT NOT NULL);""")
    con.commit()
    from .agent.engine import CONFIDENCE_FLOOR, EDGE_CASES
    return {
        "models": L.status(),
        "memory": M.status(con),
        "confidenceFloor": CONFIDENCE_FLOOR,
        "edgeCases": EDGE_CASES,
        "runs": con.execute("SELECT COUNT(*) FROM impact_runs").fetchone()[0],
        "orchestration": "deterministic typed pipeline: ground → applicability → impacts "
                         "→ actions → critique → validate → persist",
    }


import os as _os
ENGINE = _os.environ.get("AGENT_ENGINE", "langgraph")      # "legacy" is the escape hatch


def _engine():
    if ENGINE == "legacy":
        from .agent import engine as E
        return E.analyse
    from .agent import graph as GR
    return GR.analyse


@router.post("/analyse/{rid}", dependencies=[Depends(require("propose"))])   # spends model budget, writes a run
def analyse_regulation(rid: str, persist: bool = Query(True), use_memory: bool = Query(True)):
    con = connect()
    try:
        return _engine()(con, rid, persist=persist, use_memory=use_memory)
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")


@router.post("/resume/{thread_id}", dependencies=[Depends(require("approve"))])
def resume_run(thread_id: str, decisions: list[dict] = Body(...)):
    """A reviewer's decisions for a run paused at the human gate: [{entity_id, outcome, note?, edited?}]."""
    from .agent import graph as GR
    con = connect()
    try:
        return GR.resume(con, thread_id, decisions)
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")


@router.get("/pending")
def pending_runs():
    """Runs waiting on a person."""
    from .agent import graph as GR
    return {"items": GR.pending(connect())}


@router.get("/stream/{rid}")
def stream_run(rid: str, persist: bool = Query(False), use_memory: bool = Query(True)):
    """Server-sent events, one per graph node, while a regulation is analysed."""
    import json
    from fastapi.responses import StreamingResponse
    from .agent import graph as GR
    con = connect()

    def gen():
        try:
            for ev in GR.stream(con, rid, persist=persist, use_memory=use_memory):
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'event': 'error', 'error': f'{type(e).__name__}: {e}'})}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/runs/{rid}")
def runs(rid: str, limit: int = 10):
    import json
    con = connect()
    rows = con.execute(
        """SELECT id, status, route, model, impacts, actions, hallucination_rate, ran_at
           FROM impact_runs WHERE regulation_id=? ORDER BY id DESC LIMIT ?""",
        (rid, limit)).fetchall()
    return {"items": [dict(r) for r in rows]}


@router.get("/run/{run_id}")
def run_detail(run_id: int):
    import json
    con = connect()
    r = con.execute("SELECT payload FROM impact_runs WHERE id=?", (run_id,)).fetchone()
    if not r:
        raise HTTPException(404, "no such run")
    return json.loads(r["payload"])


@router.post("/memory", dependencies=[Depends(require("propose"))])
def add_memory(payload: dict[str, Any] = Body(...)):
    """
    Record a reviewer's verdict so the next run weighs it.

    This is the loop that makes 'AI proposes, human approves' improve over time
    rather than repeat itself.
    """
    from .agent.memory import get_memory
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    con = connect()
    m = get_memory(con)
    return m.add(text, scope=payload.get("scope") or "global",
                 kind=payload.get("kind") or "decision",
                 metadata=payload.get("metadata"), actor=payload.get("actor") or "human")


@router.get("/memory")
def list_memory(scope: str | None = None, limit: int = 50):
    from .agent.memory import get_memory
    con = connect()
    return {"items": get_memory(con).all(scope, limit)}


@router.post("/evals", dependencies=[Depends(require("administer"))])
def run_evals():
    """Run the safety suite on demand. Key-free cases always run."""
    from .agent.evals import run
    return run(verbose=False)
