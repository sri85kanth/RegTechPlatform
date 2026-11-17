"""
The model chain as LangChain runnables.

Built from the SAME ModelSpec list llm.py uses — deepseek-v4-flash with thinking,
deepseek-v4-flash without, then gpt-4o-mini — so the fallback order, base URLs,
key names and per-rung request shape live in one place. What changes: structured output is enforced by the
call, retries and fallbacks are declarative, and every invocation reports its
token usage into graph state so the budget node can see it.
"""
from __future__ import annotations
import json
import os
from typing import Any

from langchain_openai import ChatOpenAI
from . import llm as L


def _client(spec: "L.ModelSpec", schema=None):
    kw: dict[str, Any] = dict(model=spec.model, base_url=spec.base_url,
                              api_key=os.environ.get(spec.api_key_env, ""), timeout=120, max_retries=0)
    if not spec.reasoning:                 # thinking mode rejects temperature/top_p
        kw["temperature"] = 0
    if spec.extra_body():                  # DeepSeek V4: thinking on/off, optional reasoning_effort
        kw["extra_body"] = spec.extra_body()
    llm = ChatOpenAI(**kw)
    if schema is not None:
        # OpenAI enforces the schema server-side (json_schema); DeepSeek offers
        # json_object only, so its schema travels in the prompt — see schema_hint.
        llm = llm.with_structured_output(schema, method=spec.structured, include_raw=True)
    return llm


def schema_hint(schema) -> str:
    """
    Appended to every structured prompt. json_mode rungs have no other way to
    learn the schema, and DeepSeek requires the literal word "json" in the prompt;
    json_schema rungs simply see it twice.
    """
    return ("\n\nReturn ONLY a json object matching this schema, no prose:\n"
            + json.dumps(schema.model_json_schema(), separators=(",", ":")))


def configured_specs() -> list["L.ModelSpec"]:
    """Rungs whose API key is present — the same test llm.configured() applies."""
    return [s for s in L.CHAIN if os.environ.get(s.api_key_env)]


def chain(schema=None):
    """
    A runnable that walks the configured rungs top-down. Returns None when no
    key is configured, so the graph can take the deterministic edge instead of
    failing inside a model call.
    """
    specs = configured_specs()
    if not specs:
        return None
    head, *rest = [_client(s, schema) for s in specs]
    return head.with_fallbacks(rest) if rest else head


def tool_chain(tools):
    """The configured rungs with tools bound, walked top-down — for the research node."""
    specs = configured_specs()
    if not specs:
        return None
    head, *rest = [_client(s).bind_tools(tools) for s in specs]
    return head.with_fallbacks(rest) if rest else head


def rung_names() -> list[str]:
    return [s.label for s in configured_specs()]


def usage_of(result: Any) -> tuple[int, int]:
    """(input_tokens, output_tokens) from a structured-output result or a message."""
    msg = result.get("raw") if isinstance(result, dict) else result
    u = getattr(msg, "usage_metadata", None) or {}
    return int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0)
