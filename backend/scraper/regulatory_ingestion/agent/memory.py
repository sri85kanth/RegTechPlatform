"""
Decision memory for the Impact Engine.

WHAT IT REMEMBERS
-----------------
Human verdicts. When a reviewer rejects "this KYC clause hits our onboarding
process" and says why, that correction should steer the next run rather than
being relitigated every time. This is the mechanism behind "AI proposes, human
approves" actually improving.

mem0 is used when configured. It is NOT a hard dependency: mem0 needs its own
LLM/embedding keys, and this engine must work without any key at all — so there
is a local SQLite store with the same interface. The active backend is always
reported, because "the agent remembered" and "the agent had no memory" lead to
very different outputs and must never be confused.

MEMORY IS EVIDENCE, NOT INSTRUCTION
-----------------------------------
Recalled items are injected as prior human decisions for the model to weigh.
They never override the grounding checks — a remembered claim about an entity
that no longer exists is still dropped by validation.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,        -- regulation id, entity id, or 'global'
  kind        TEXT NOT NULL,        -- decision | correction | preference
  text        TEXT NOT NULL,
  metadata    TEXT,
  actor       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_amem_scope ON agent_memory(scope);
"""


class LocalMemory:
    """
    Built-in memory store. Keyword recall — no embeddings, no keys, no network.

    Named for its role, not its engine: it lives in the same database as
    everything else (PostgreSQL since the migration). Reporting a hard-coded
    engine name meant the status endpoint advertised a store that no longer
    existed — a label lying about the system.
    """

    backend = "builtin"

    def __init__(self, con):
        con.executescript(SCHEMA)
        con.commit()
        self.con = con

    def add(self, text: str, scope: str = "global", kind: str = "decision",
            metadata: dict | None = None, actor: str = "human") -> dict:
        cur = self.con.execute(
            """INSERT INTO agent_memory (scope, kind, text, metadata, actor, created_at)
               VALUES (?,?,?,?,?,?)""",
            (scope, kind, text, json.dumps(metadata or {}), actor, _now()))
        self.con.commit()
        return {"id": cur.lastrowid, "backend": self.backend}

    def search(self, query: str, scope: str | None = None, limit: int = 5) -> list[dict]:
        words = [w.lower() for w in query.split() if len(w) > 3][:8]
        rows = self.con.execute(
            "SELECT * FROM agent_memory WHERE (?::text IS NULL OR scope=? OR scope='global') ORDER BY id DESC LIMIT 300",
            (scope, scope)).fetchall()
        scored = []
        for r in rows:
            t = (r["text"] or "").lower()
            hits = sum(1 for w in words if w in t)
            if hits:
                scored.append((hits, dict(r)))
        scored.sort(key=lambda x: -x[0])
        return [dict(d, score=s) for s, d in scored[:limit]]

    def all(self, scope: str | None = None, limit: int = 50) -> list[dict]:
        rows = self.con.execute(
            "SELECT * FROM agent_memory WHERE (?::text IS NULL OR scope=?) ORDER BY id DESC LIMIT ?",
            (scope, scope, limit)).fetchall()
        return [dict(r) for r in rows]


class Mem0Memory:
    """mem0 wrapper. Falls back to LocalMemory on any failure rather than losing a write."""

    backend = "mem0"

    def __init__(self, fallback: LocalMemory):
        from mem0 import Memory
        self.m = Memory()
        self.fallback = fallback

    def add(self, text: str, scope: str = "global", kind: str = "decision",
            metadata: dict | None = None, actor: str = "human") -> dict:
        try:
            self.m.add(text, user_id=scope, metadata={"kind": kind, "actor": actor, **(metadata or {})})
            self.fallback.add(text, scope, kind, metadata, actor)   # mirror, so nothing is lost
            return {"backend": self.backend}
        except Exception as e:
            r = self.fallback.add(text, scope, kind, metadata, actor)
            return {**r, "degraded": f"{type(e).__name__}: {e}"}

    def search(self, query: str, scope: str | None = None, limit: int = 5) -> list[dict]:
        try:
            res = self.m.search(query, user_id=scope or "global", limit=limit)
            items = res.get("results", res) if isinstance(res, dict) else res
            return [{"text": i.get("memory") or i.get("text", ""), "score": i.get("score"),
                     "scope": scope, "kind": (i.get("metadata") or {}).get("kind", "decision")}
                    for i in items]
        except Exception:
            return self.fallback.search(query, scope, limit)

    def all(self, scope: str | None = None, limit: int = 50) -> list[dict]:
        return self.fallback.all(scope, limit)


def get_memory(con: sqlite3.Connection):
    """mem0 when it is genuinely usable; the local store otherwise. Never raises."""
    local = LocalMemory(con)
    if os.environ.get("MEM0_API_KEY") or os.environ.get("MEM0_ENABLE"):
        try:
            return Mem0Memory(local)
        except Exception:
            return local
    return local


def status(con: sqlite3.Connection) -> dict:
    m = get_memory(con)
    return {
        "backend": m.backend,
        "store": "postgresql · agent_memory table",
        "mem0Configured": bool(os.environ.get("MEM0_API_KEY") or os.environ.get("MEM0_ENABLE")),
        "items": con.execute("SELECT COUNT(*) FROM agent_memory").fetchone()[0],
        "note": "mem0 needs its own model/embedding keys; the built-in store works with none "
                "and lives in the same database as the rest of the system.",
    }
