"""
Observability sinks, chosen by TRACE_SINKS (comma list: langfuse, langsmith).

Both are LangChain callbacks, so a single config decides what is on. They are
NOT meant to run together everywhere: Langfuse (self-hosted on the VPS) is the
production sink because every trace carries the company profile, named people
and clause text; LangSmith is US-hosted SaaS and stays a development tool.
"""
from __future__ import annotations
import os


def sinks() -> set[str]:
    return {s.strip().lower() for s in os.environ.get("TRACE_SINKS", "").split(",") if s.strip()}


def callbacks() -> list:
    out = []
    if "langfuse" in sinks() and os.environ.get("LANGFUSE_PUBLIC_KEY"):
        try:
            from langfuse.langchain import CallbackHandler
            out.append(CallbackHandler())          # reads LANGFUSE_* from the environment
        except Exception as e:                     # noqa: BLE001
            print(f"[agent] langfuse handler unavailable: {type(e).__name__}: {e}")
    # LangSmith traces automatically when LANGSMITH_TRACING=true; make the env
    # switch the single source of truth so it cannot be on by accident.
    os.environ["LANGSMITH_TRACING"] = "true" if "langsmith" in sinks() and os.environ.get("LANGSMITH_API_KEY") else "false"
    return out


def score(trace_id: str | None, name: str, value: float, comment: str = "") -> None:
    """Attach a quality score to a Langfuse trace (validator rate, reviewer decision)."""
    if not trace_id or "langfuse" not in sinks() or not os.environ.get("LANGFUSE_PUBLIC_KEY"):
        return
    try:
        from langfuse import Langfuse
        Langfuse().create_score(trace_id=trace_id, name=name, value=value, comment=comment or None)
    except Exception as e:                         # noqa: BLE001
        print(f"[agent] langfuse score failed: {type(e).__name__}: {e}")
