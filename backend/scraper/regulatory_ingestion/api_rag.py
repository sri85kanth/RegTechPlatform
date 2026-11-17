"""
Retrieval endpoints.

This is RETRIEVAL, not generation. It returns passages with citations; it does
not compose an answer. That boundary is deliberate — the product rule is
"AI proposes, human approves", and an unsourced generated paragraph about a
regulation is exactly the kind of thing that must never look official.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from .api_auth import require

router = APIRouter(prefix="/api/rag", tags=["rag"],
                   # every route here served company data to anyone —
                   # the login page gated the UI, not the API
                   dependencies=[Depends(require("read"))])


def _rag():
    from . import rag
    return rag


@router.get("/search")
def search(q: str = Query(..., min_length=2),
           k: int = Query(8, ge=1, le=50),
           corpus: str | None = Query(None, pattern="^(regulatory|company)$"),
           regulation_id: str | None = None):
    """Hybrid retrieval over the indexed corpora. Every hit carries its source."""
    rag = _rag()
    try:
        hits = rag.search(q, k=k, corpus=corpus, regulation_id=regulation_id)
    except Exception as e:
        # a missing/unreachable index must say so, not return an empty list that
        # reads as "nothing matches your question"
        raise HTTPException(503, f"retrieval index unavailable: {type(e).__name__}: {e}")
    return {
        "query": q, "count": len(hits), "items": hits,
        "provenance": {
            "index": "postgres/pgvector (derived)",
            "source_of_truth": "postgresql/company_brain",
            "model": rag.MODEL_NAME,
            "retrieval": "hybrid: cosine + full-text, fused with RRF",
        },
    }


@router.get("/answer")
def rag_answer(q: str, k: int = 8, corpus: str | None = None, regulation_id: str | None = None):
    """An answer with citations — extractive by default, model-synthesised when a key exists."""
    from . import answers
    if not (q or "").strip():
        raise HTTPException(400, "q is required")
    return answers.answer(q.strip(), k=min(k, 20), corpus=corpus, regulation_id=regulation_id)


@router.get("/visual")
def visual(q: str = Query(..., min_length=2),
           k: int = Query(5, ge=1, le=20),
           regulation_id: str | None = None):
    """
    Page-level visual retrieval (ColSmol, late interaction).

    Returns PAGES, not text — this route reads the page picture, so it works on
    scanned documents the text pipeline could never extract. It cannot tell you
    what the page says; open the source to read it.
    """
    from . import visual_rag as V
    ok, why = V.available()
    if not ok:
        raise HTTPException(503, why)
    try:
        hits = V.search(q, k=k, regulation_id=regulation_id)
    except Exception as e:
        raise HTTPException(503, f"visual retrieval failed: {type(e).__name__}: {e}")
    return {
        "query": q, "count": len(hits), "items": hits,
        "provenance": {
            "model": V.MODEL_NAME, "scoring": "late interaction (MaxSim)",
            "note": "Retrieves pages from the page image. No OCR involved, and no text is produced.",
        },
    }


@router.get("/status")
def status():
    """Is the index there, how big, how fresh — so staleness is visible."""
    rag = _rag()
    try:
        con = rag.connect_pg()
        total = con.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        by_corpus = dict(con.execute(
            "SELECT corpus, COUNT(*) FROM chunks GROUP BY 1").fetchall())
        by_table = dict(con.execute(
            "SELECT source_table, COUNT(*) FROM chunks GROUP BY 1").fetchall())
        runs = [dict(zip(
            ["corpus", "model", "chunks_seen", "chunks_written", "chunks_skipped",
             "started_at", "finished_at"], r))
            for r in con.execute(
                """SELECT corpus, model, chunks_seen, chunks_written, chunks_skipped,
                          started_at, finished_at
                   FROM index_runs ORDER BY id DESC LIMIT 5""").fetchall()]
        vis = {"pages": 0, "patches": 0, "available": False}
        try:
            from . import visual_rag as V
            ok, why = V.available()
            vis = {
                "available": ok, "reason": None if ok else why, "model": V.MODEL_NAME,
                "pages": con.execute("SELECT COUNT(*) FROM visual_pages").fetchone()[0],
                "patches": con.execute("SELECT COUNT(*) FROM visual_patches").fetchone()[0],
                "documents": con.execute(
                    "SELECT COUNT(DISTINCT regulation_id) FROM visual_pages").fetchone()[0],
            }
        except Exception as e:
            vis = {"available": False, "reason": f"{type(e).__name__}: {e}"}
        return {"available": True, "chunks": total, "byCorpus": by_corpus,
                "bySourceTable": by_table, "model": rag.MODEL_NAME, "recentRuns": runs,
                "visual": vis}
    except Exception as e:
        return {"available": False, "reason": f"{type(e).__name__}: {e}",
                "hint": "Run: python -c 'from regulatory_ingestion import rag; rag.index()'"}
