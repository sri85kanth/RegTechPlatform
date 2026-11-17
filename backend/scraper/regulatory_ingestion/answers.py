"""
Answers over the regulation brain — retrieval that speaks, with citations.

/api/rag/search returns chunks; this composes an ANSWER. Two modes, always
labelled, never mixed up:

  extractive  — no model involved. The best sentences from the top passages,
                quoted verbatim, each with its regulation and section. This is
                the default and the fallback, and it can never hallucinate
                because it can only quote.
  synthesised — only when a model key is configured: the model writes a short
                answer FROM THE PASSAGES ONLY, with [n] citations that map back
                to the same quotes. If the model fails or cites nothing, the
                extractive answer is returned instead — degraded, said so.

Every response carries the passages themselves, so the reader can check the
answer against its sources in one glance.
"""
from __future__ import annotations

import re

from . import rag
from .agent import llm as L

_WORD = re.compile(r"[a-z0-9]{3,}")


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.;])\s+", re.sub(r"\s+", " ", text or ""))
    return [p.strip() for p in parts if len(p.strip()) > 30]


def _best_sentences(query: str, hits: list[dict], n: int = 3) -> list[dict]:
    qw = set(_WORD.findall(query.lower()))
    scored: list[tuple[float, str, dict]] = []
    for h in hits[:5]:
        for s in _sentences(h.get("content") or ""):
            sw = set(_WORD.findall(s.lower()))
            if not sw:
                continue
            overlap = len(qw & sw) / (len(qw) or 1)
            if overlap == 0:
                continue
            scored.append((overlap + min(len(s), 300) / 3000, s, h))
    scored.sort(key=lambda t: -t[0])
    out, seen = [], set()
    for _, s, h in scored:
        key = s[:80]
        if key in seen:
            continue
        seen.add(key)
        out.append({"text": s[:450], "regulation_id": h.get("regulation_id"),
                    "section": h.get("section_number"), "title": h.get("title"),
                    "source": h.get("source_id"), "app_path": h.get("app_path")})
        if len(out) >= n:
            break
    return out


def _passages(hits: list[dict], n: int = 6) -> list[dict]:
    return [{"rank": i + 1, "regulation_id": h.get("regulation_id"),
             "section": h.get("section_number"), "title": h.get("title"),
             "text": (h.get("content") or "")[:700], "app_path": h.get("app_path")}
            for i, h in enumerate(hits[:n])]


def answer(query: str, *, k: int = 8, corpus: str | None = None,
           regulation_id: str | None = None) -> dict:
    hits = rag.search(query, k=k, corpus=corpus, regulation_id=regulation_id)
    passages = _passages(hits)
    quotes = _best_sentences(query, hits)
    base = {
        "query": query,
        "passages": passages,
        "quotes": quotes,
        "note": ("Quotes are verbatim from the retrieved passages — nothing is generated. "
                 if not L.configured() else "") + "Check every claim against the cited passage.",
    }
    if not hits:
        return {**base, "mode": "no_evidence",
                "answer": None,
                "note": "Nothing relevant was retrieved for this query — no answer is offered in its place."}

    if L.configured():
        numbered = "\n\n".join(
            f"[{p['rank']}] ({p['regulation_id'] or 'derived'} §{p['section'] or '—'}) {p['text']}"
            for p in passages)
        res = L.complete(
            "You answer questions about Indian financial regulation STRICTLY from the numbered "
            "passages provided. Cite every claim as [n]. If the passages do not settle the "
            "question, say INSUFFICIENT_EVIDENCE. Never use outside knowledge.",
            f"PASSAGES:\n{numbered}\n\nQUESTION: {query}\n\n"
            "Answer in at most 120 words with [n] citations.",
            json_mode=False, max_tokens=400)
        cited = res.ok and bool(re.search(r"\[\d+\]", res.text or ""))
        if cited and "INSUFFICIENT_EVIDENCE" not in (res.text or ""):
            return {**base, "mode": "synthesised", "answer": res.text.strip(),
                    "model": f"{res.provider}/{res.model}"}
        if res.ok and "INSUFFICIENT_EVIDENCE" in (res.text or ""):
            return {**base, "mode": "no_evidence", "answer": None,
                    "model": f"{res.provider}/{res.model}",
                    "note": "The model judged the retrieved passages insufficient to answer. "
                            "The passages are shown so you can judge for yourself."}
        # model unavailable/uncited -> honest extractive fallback

    return {**base, "mode": "extractive",
            "answer": None if not quotes else " ".join(f"“{q['text']}”" for q in quotes[:2])[:800]}
