"""
Source watcher endpoints — re-checking official sources for change.

A check is the ONLY thing that can justify CHECKED_UNCHANGED, and the only way
CHANGE_DETECTED can ever be reached. Without it the five-state model can never
leave its two weakest states.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from .api_auth import require

from . import watcher as W
from .db import connect

router = APIRouter(prefix="/api/watcher", tags=["watcher"],
                   # every route here served company data to anyone —
                   # the login page gated the UI, not the API
                   dependencies=[Depends(require("read"))])


@router.get("/status")
def status():
    con = W.init(connect())
    rows = con.execute(
        """SELECT outcome, COUNT(*) FROM source_checks GROUP BY 1""").fetchall()
    last = con.execute(
        "SELECT regulation_id, checked_at, outcome, note FROM source_checks ORDER BY id DESC LIMIT 10").fetchall()
    return {
        "totalChecks": sum(r[1] for r in rows),
        "byOutcome": {r[0]: r[1] for r in rows},
        "dueNow": len(W.due(con, limit=500)),
        "recent": [dict(r) for r in last],
        "changesDetected": con.execute("SELECT COUNT(*) FROM section_changes").fetchone()[0],
        "note": "A recorded UNCHANGED check is what allows the UI to say 'verified unchanged', "
                "rather than the much weaker 'no change detected'.",
    }


@router.get("/discoveries")
def discoveries(status: str | None = None, limit: int = 100):
    """Leads found on regulator listing pages — not yet regulations."""
    from . import discovery as D
    con = connect()
    items = D.listing(con, status=status, limit=min(limit, 500))
    counts = {r["status"]: r["n"] for r in
              (dict(x) for x in con.execute(
                  "SELECT status, COUNT(*) AS n FROM discovered_regulations GROUP BY status").fetchall())}
    return {"items": items, "counts": counts,
            "note": "A listing entry is a lead, not a regulation — nothing is ingested automatically."}


@router.post("/check/{rid}", dependencies=[Depends(require("propose"))])
def check_one(rid: str):
    return W.check(connect(), rid)


@router.post("/run", dependencies=[Depends(require("propose"))])
def run(background: BackgroundTasks,
        limit: int = Query(25, ge=1, le=200),
        delay: float = Query(3.0, ge=0.5, le=30),
        max_age_hours: int = Query(24, ge=1),
        wait: bool = Query(False, description="run inline instead of in the background")):
    """
    Kick a watcher pass. Defaults to background because a full pass makes many
    slow network calls to servers that rate-limit.
    """
    con = connect()
    if wait:
        return W.run(con, limit=limit, delay=delay, max_age_hours=max_age_hours, progress=lambda *_: None)
    background.add_task(lambda: W.run(connect(), limit=limit, delay=delay,
                                      max_age_hours=max_age_hours, progress=lambda *_: None))
    return {"started": True, "limit": limit, "delay": delay,
            "note": "Running in the background. Poll /api/watcher/status for results."}


@router.get("/changes")
def changes(limit: int = 50):
    """Real computed section-level changes — never footnote mentions."""
    con = connect()
    rows = con.execute(
        """SELECT c.regulation_id, r.title, c.section_number, c.change_type,
                  c.words_added, c.words_removed, c.detected_at
           FROM section_changes c LEFT JOIN regulations r ON r.id = c.regulation_id
           ORDER BY c.id DESC LIMIT ?""", (limit,)).fetchall()
    return {"items": [dict(r) for r in rows], "total": len(rows),
            "note": "These are computed diffs between two captured versions, "
                    "not amendments a document mentions about itself."}
