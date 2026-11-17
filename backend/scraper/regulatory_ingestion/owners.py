"""
Resolve owner NAMES into owner LINKS.

THE PROBLEM
-----------
134 entities carry an owner as free text in attrs ("Priya Sharma", "Compliance")
while `owner_id` is set on none of them. So "who owns this policy?" returns a
string, not a person you can route an approval to or notify when a regulation
changes. Accountability that cannot be queried is not accountability.

WHAT THIS DOES
--------------
Matches those names against real Person / Role / Department / Team records and
sets owner_id. It is deliberately conservative:

  exact name match, exactly one candidate      -> link
  case/whitespace-insensitive, one candidate   -> link
  more than one candidate                      -> AMBIGUOUS, left unlinked
  no candidate                                 -> UNMATCHED, left unlinked

A wrong owner is worse than a missing one: it sends approvals to the wrong
person and makes the audit trail lie. So nothing is guessed, and everything
skipped is reported with the reason.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# Attribute keys that carry an owner in practice, in priority order.
OWNER_KEYS = ["owner", "ownerName", "policyOwner", "processOwner", "responsible",
              "accountable", "hod", "headOfDepartment"]

# Entity types that can legitimately own something.
OWNER_TYPES = ("Person", "Role", "Department", "Team", "External Person")


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def candidates(con) -> dict[str, list[dict]]:
    """Normalised name -> the records that could be an owner."""
    idx: dict[str, list[dict]] = {}
    for r in con.execute(
            f"""SELECT id, name, type, domain FROM company_entities
                WHERE type IN ({','.join('?' * len(OWNER_TYPES))})""", OWNER_TYPES):
        idx.setdefault(_norm(r["name"]), []).append(dict(r))
    return idx


def owner_name_of(attrs_json: str | None) -> tuple[str, str] | None:
    try:
        a = json.loads(attrs_json or "{}")
    except Exception:
        return None
    for k in OWNER_KEYS:
        v = a.get(k)
        if isinstance(v, str) and v.strip():
            return k, v.strip()
    return None


def resolve(con: sqlite3.Connection, *, apply: bool = False) -> dict:
    """
    Returns what would be (or was) linked, plus every skip with its reason.
    `apply=False` is a dry run — see the outcome before changing 134 records.
    """
    idx = candidates(con)
    linked, ambiguous, unmatched = [], [], []

    rows = con.execute(
        """SELECT id, name, domain, type, attrs, owner_id FROM company_entities
           WHERE attrs IS NOT NULL AND (owner_id IS NULL OR owner_id='')""").fetchall()

    for r in rows:
        found = owner_name_of(r["attrs"])
        if not found:
            continue
        key, raw = found
        hits = idx.get(_norm(raw), [])
        if len(hits) == 1:
            linked.append({"entity_id": r["id"], "entity_name": r["name"],
                           "owner_name": raw, "owner_id": hits[0]["id"],
                           "owner_type": hits[0]["type"], "via": key})
        elif len(hits) > 1:
            ambiguous.append({"entity_id": r["id"], "owner_name": raw,
                              "candidates": [h["id"] for h in hits],
                              "reason": f"{len(hits)} records share this name — a wrong link "
                                        "would misroute approvals, so it is left unset"})
        else:
            unmatched.append({"entity_id": r["id"], "owner_name": raw,
                              "reason": "no Person/Role/Department record with this name"})

    if apply and linked:
        con.executemany("UPDATE company_entities SET owner_id=?, updated_at=? WHERE id=?",
                        [(l["owner_id"], _now(), l["entity_id"]) for l in linked])
        for l in linked:
            con.execute(
                "INSERT INTO audit_events (entity_id, action, actor, detail, at) VALUES (?,?,?,?,?)",
                (l["entity_id"], "owner linked", "owner-resolver",
                 f"{l['owner_name']} -> {l['owner_id']}", _now()))
        con.commit()

    return {
        "applied": apply,
        "linked": len(linked), "ambiguous": len(ambiguous), "unmatched": len(unmatched),
        "examples": linked[:5],
        "ambiguousDetail": ambiguous[:10],
        "unmatchedDetail": unmatched[:10],
        "note": "Ambiguous and unmatched owners are left unset on purpose. A wrong owner "
                "misroutes approvals and makes the audit trail untrue.",
    }


def coverage(con) -> dict:
    total = con.execute("SELECT COUNT(*) FROM company_entities").fetchone()[0]
    owned = con.execute(
        "SELECT COUNT(*) FROM company_entities WHERE owner_id IS NOT NULL AND owner_id != ''"
    ).fetchone()[0]
    named = 0
    for r in con.execute("SELECT attrs FROM company_entities WHERE attrs IS NOT NULL"):
        if owner_name_of(r["attrs"]):
            named += 1
    return {"entities": total, "withOwnerLink": owned,
            "withOwnerNameOnly": max(named - owned, 0),
            "coveragePct": round(100 * owned / max(total, 1), 1)}
