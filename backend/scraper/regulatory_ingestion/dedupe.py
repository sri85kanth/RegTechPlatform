"""
Merge duplicate company entities into one canonical record.

WHY THIS IS NEEDED
------------------
The same person exists up to three times — once per import route (`smp-*` from
the sample CSV, `imp-*` from another import, `peo-*` created by the folder
integration). 81 owner-capable records cover only 37 real people.

That breaks the product's core rule that one entity has one stable id, and it
blocks owner resolution outright: every owner name matches several records, so
nothing can be linked without guessing which copy is meant.

HOW IT MERGES
-------------
Group by (domain, normalised name). Choose a canonical record, then REPOINT
every reference before deleting the losers — relationships, mappings, impact
rows, actions, user links. A merge that deletes first would silently orphan
those rows, which is how a dedupe turns into data loss.

Attributes are unioned, not overwritten: if one copy knows the email and another
knows the department, the survivor keeps both.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# Where an entity id can appear. Every one must be repointed on merge.
REFERENCES = [
    ("entity_relationships", "source_id"),
    ("entity_relationships", "target_id"),
    ("company_mappings", "target_id"),
    ("impact_relationships", "company_brain_entity_id"),
    ("actions", "entity_id"),
    ("actions", "owner_id"),
    ("actions", "evidence_id"),
    ("users", "person_id"),
    ("company_entities", "owner_id"),
    ("integration_records", "entity_id"),
    ("audit_events", "entity_id"),
]

# When copies disagree on type, prefer the more specific one.
TYPE_RANK = {"Person": 5, "External Person": 4, "Role": 3, "Department": 3,
             "Team": 3, "Job Function": 2, "Access Profile": 1, "Certification": 1,
             "Training": 1}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _score(r: sqlite3.Row) -> tuple:
    """
    Canonical pick: richest record wins, ties broken by a stable id so repeated
    runs choose the same survivor.
    """
    attrs = {}
    try:
        attrs = json.loads(r["attrs"] or "{}")
    except Exception:
        pass
    return (
        TYPE_RANK.get(r["type"] or "", 0),
        len(attrs),
        1 if (r["description"] or "").strip() else 0,
        1 if (r["owner_id"] or "") else 0,
        -len(r["id"]),          # shorter ids tend to be the original scheme
    )


def groups(con) -> list[dict]:
    """Duplicate clusters: same domain, same normalised name."""
    by_key: dict[tuple, list] = {}
    for r in con.execute("SELECT * FROM company_entities"):
        by_key.setdefault((r["domain"], _norm(r["name"])), []).append(r)
    out = []
    for (domain, name), rows in by_key.items():
        if len(rows) < 2:
            continue
        ranked = sorted(rows, key=_score, reverse=True)
        out.append({
            "domain": domain, "name": rows[0]["name"],
            "canonical": ranked[0]["id"],
            "canonicalType": ranked[0]["type"],
            "duplicates": [x["id"] for x in ranked[1:]],
            "sources": sorted({(x["source"] or "?") for x in rows}),
        })
    return sorted(out, key=lambda g: -len(g["duplicates"]))


def merge(con: sqlite3.Connection, *, apply: bool = False) -> dict:
    gs = groups(con)
    repointed = {t: 0 for t, _ in REFERENCES}
    removed = 0

    if apply:
        for g in gs:
            keep, losers = g["canonical"], g["duplicates"]

            # union the attributes before anything is deleted
            merged: dict = {}
            for eid in [keep] + losers:
                r = con.execute("SELECT attrs FROM company_entities WHERE id=?", (eid,)).fetchone()
                try:
                    merged.update({k: v for k, v in json.loads(r["attrs"] or "{}").items()
                                   if v not in (None, "")})
                except Exception:
                    pass
            con.execute("UPDATE company_entities SET attrs=?, updated_at=? WHERE id=?",
                        (json.dumps(merged) if merged else None, _now(), keep))

            for loser in losers:
                # REPOINT FIRST. Deleting before this would orphan every row that
                # referenced the duplicate.
                for table, col in REFERENCES:
                    try:
                        cur = con.execute(
                            f"UPDATE OR IGNORE {table} SET {col}=? WHERE {col}=?", (keep, loser))
                        repointed[table] += cur.rowcount
                    except sqlite3.OperationalError:
                        pass    # table absent in this deployment
                con.execute("DELETE FROM company_entities WHERE id=?", (loser,))
                con.execute(
                    "INSERT INTO audit_events (entity_id, action, actor, detail, at) VALUES (?,?,?,?,?)",
                    (keep, "merged duplicate", "dedupe", f"{loser} merged into {keep}", _now()))
                removed += 1

        # a self-referential owner_id left pointing at a deleted row is worse
        # than none at all
        con.execute("""UPDATE company_entities SET owner_id=NULL
                       WHERE owner_id IS NOT NULL
                         AND owner_id NOT IN (SELECT id FROM company_entities)""")
        con.commit()

    return {
        "applied": apply,
        "duplicateGroups": len(gs),
        "recordsToRemove": sum(len(g["duplicates"]) for g in gs),
        "removed": removed,
        "repointed": {k: v for k, v in repointed.items() if v},
        "examples": gs[:6],
    }
