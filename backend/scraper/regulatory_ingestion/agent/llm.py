"""
Model access for the Impact Engine.

DeepSeek is the primary provider (OpenAI-compatible API, so one client shape
covers the fallbacks too). Two rungs of the same model matter:

    deepseek-v4-flash, thinking on   long chain-of-thought; the judgement rung
    deepseek-v4-flash, thinking off  cheaper/faster; first fallback

(`deepseek-reasoner` / `deepseek-chat` were discontinued by DeepSeek on
2026-07-24.) V4 rules that shape the request: thinking is on by default and is
switched per request via extra_body {"thinking": {"type": "enabled|disabled"}};
thinking mode rejects temperature/top_p; JSON output is json_object only and the
prompt must contain the word "json" — so the schema travels in the prompt.

NO KEY, NO GUESSING
-------------------
If no API key is configured, this layer reports that plainly and the engine
falls back to its deterministic path. It never returns invented content, and it
never silently pretends a model ran. The same applies to a provider outage: the
result is labelled with which route produced it.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ModelSpec:
    provider: str
    model: str
    base_url: str
    api_key_env: str
    reasoning: bool = False          # rejects sampling params; returns reasoning_content
    thinking: bool | None = None     # DeepSeek V4: True/False → extra_body thinking enabled/disabled; None → not sent
    structured: str = "json_schema"  # response_format the provider supports: "json_schema" or "json_mode"

    @property
    def label(self) -> str:
        return f"{self.provider}/{self.model}" + ("+thinking" if self.thinking else "")

    def extra_body(self) -> dict:
        body: dict = {}
        if self.thinking is not None:
            body["thinking"] = {"type": "enabled" if self.thinking else "disabled"}
        effort = os.environ.get("AGENT_REASONING_EFFORT")      # DeepSeek: low | high | max
        if self.thinking and effort:
            body["reasoning_effort"] = effort
        return body


# Ordered fallback chain. The engine walks it top-down and records which rung
# actually answered, so an answer can never be mistaken for the primary model's.
_DS = "https://api.deepseek.com"
# Local OpenAI-compatible server (e.g. llama.cpp serving gpt-oss-120b), configured
# via env so the host/model can change without a code edit. Active only when
# LOCAL_LLM_API_KEY is set — llama.cpp ignores the key, so any non-empty value
# enables this rung. Placed first so it is the primary provider when present.
_LOCAL_BASE = os.environ.get("LOCAL_LLM_BASE_URL", "http://172.22.64.1:8081/v1")
_LOCAL_MODEL = os.environ.get("LOCAL_LLM_MODEL", "gpt-oss-120b")
CHAIN: list[ModelSpec] = [
    ModelSpec("local", _LOCAL_MODEL, _LOCAL_BASE, "LOCAL_LLM_API_KEY", reasoning=False, thinking=None, structured="json_mode"),
    ModelSpec("deepseek", "deepseek-v4-flash", _DS, "DEEPSEEK_API_KEY", reasoning=True,  thinking=True,  structured="json_mode"),
    ModelSpec("deepseek", "deepseek-v4-flash", _DS, "DEEPSEEK_API_KEY", reasoning=False, thinking=False, structured="json_mode"),
    # Optional extra rungs — active only if their key is present.
    ModelSpec("openai",   "gpt-4o-mini",       "https://api.openai.com/v1", "OPENAI_API_KEY"),
]


@dataclass
class LLMResult:
    ok: bool
    text: str = ""
    data: Any = None
    model: str = ""
    provider: str = ""
    reasoning: str = ""          # thinking rungs expose their chain separately (reasoning_content)
    attempts: list[str] = field(default_factory=list)
    error: str = ""
    usage: dict = field(default_factory=dict)
    latency_s: float = 0.0


def configured() -> list[ModelSpec]:
    """Only rungs whose key is actually present are usable."""
    return [m for m in CHAIN if os.environ.get(m.api_key_env)]


def status() -> dict:
    have = configured()
    return {
        "available": bool(have),
        "chain": [m.label for m in CHAIN],
        "usable": [m.label for m in have],
        "missingKeys": sorted({m.api_key_env for m in CHAIN if not os.environ.get(m.api_key_env)}),
        "note": None if have else
                "No model key configured. The engine will use its deterministic "
                "path and label results DETERMINISTIC_FALLBACK — it will not invent analysis.",
    }


_JSON = re.compile(r"\{.*\}|\[.*\]", re.S)


def _parse_json(text: str) -> Any:
    """
    Models wrap JSON in prose or fences even when told not to. Strip that, but
    if what remains is not valid JSON, FAIL — never hand back a half-parsed dict
    that downstream code would treat as a real answer.
    """
    t = text.strip()
    t = re.sub(r"^```(?:json)?|```$", "", t, flags=re.M).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        m = _JSON.search(t)
        if not m:
            raise ValueError(f"no JSON found in model output: {t[:200]}")
        return json.loads(m.group(0))


def complete(system: str, user: str, *, schema_hint: str = "", json_mode: bool = True,
             temperature: float = 0.0, max_tokens: int = 4000,
             prefer_reasoning: bool = False, retries: int = 2) -> LLMResult:
    """
    Walk the fallback chain until one rung answers with parseable output.

    Retries within a rung handle transient failures (429/5xx); moving to the
    next rung handles a model being unavailable or persistently malformed.
    """
    have = configured()
    if not have:
        return LLMResult(ok=False, error="no API key configured",
                         attempts=[], model="", provider="")

    order = ([m for m in have if m.reasoning] + [m for m in have if not m.reasoning]
             if prefer_reasoning else have)

    attempts: list[str] = []
    last_err = ""
    t0 = time.time()

    for spec in order:
        from openai import OpenAI
        client = OpenAI(api_key=os.environ[spec.api_key_env], base_url=spec.base_url, timeout=180)
        prompt = user if not schema_hint else f"{user}\n\nReturn ONLY a json object matching:\n{schema_hint}"

        for attempt in range(retries + 1):
            tag = f"{spec.provider}/{spec.model}#{attempt}"
            try:
                kw: dict = dict(
                    model=spec.model,
                    messages=[{"role": "system", "content": system},
                              {"role": "user", "content": prompt}],
                    max_tokens=max_tokens,
                )
                if spec.extra_body():              # DeepSeek V4: thinking on/off (+ effort)
                    kw["extra_body"] = spec.extra_body()
                if not spec.reasoning:             # thinking mode rejects sampling parameters
                    kw["temperature"] = temperature
                if json_mode:                      # json_object is the one format every rung accepts
                    kw["response_format"] = {"type": "json_object"}

                r = client.chat.completions.create(**kw)
                msg = r.choices[0].message
                text = msg.content or ""
                reasoning = getattr(msg, "reasoning_content", "") or ""

                data = _parse_json(text) if json_mode else None
                attempts.append(tag)
                return LLMResult(
                    ok=True, text=text, data=data, model=spec.model, provider=spec.provider,
                    reasoning=reasoning, attempts=attempts,
                    usage=(r.usage.model_dump() if getattr(r, "usage", None) else {}),
                    latency_s=round(time.time() - t0, 2))
            except Exception as e:
                last_err = f"{tag}: {type(e).__name__}: {str(e)[:180]}"
                attempts.append(tag + "!")
                transient = any(s in str(e).lower() for s in
                                ("429", "rate", "timeout", "500", "502", "503", "overload"))
                if transient and attempt < retries:
                    time.sleep(2 ** attempt * 2)
                    continue
                break        # non-transient, or out of retries: next rung

    return LLMResult(ok=False, error=last_err, attempts=attempts,
                     latency_s=round(time.time() - t0, 2))
