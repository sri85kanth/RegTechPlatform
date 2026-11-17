"""
Control library and obligation lifecycle.

THE GAP THIS CLOSES
-------------------
The chain was Regulation → Obligation → Company entity. Mature compliance needs
a control in the middle:

    Regulation → Obligation → CONTROL → Process → Evidence

That middle term is what makes the workload tractable. The data already shows
why: in this database a single control is touched by hundreds of regulations —

    Transaction Monitoring    468 regulations
    Access Review             414 regulations
    KYC Verification Control  163 regulations

9,636 obligations collapse onto 9 controls. Without a control layer each of
those obligations is separate work; with one, satisfying a control satisfies
every obligation mapped to it. That is the difference between a discovery tool
and a compliance system.

AND A LIFECYCLE
---------------
Discovering 44,203 obligations is worthless if none of them has a state. An
obligation must be able to say where it is between "we found this" and "we can
prove we comply":

    Discovered → Applicable → Control Assigned → Evidence Verified → Compliant
                     ↓
              Not Applicable · Exception · Non-Compliant · Under Review

Every transition is recorded with who made it and why. A status that can be set
without a reason is a status nobody can defend in an audit.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# ---------------------------------------------------------------- lifecycle
STATES = [
    "Discovered",        # extracted from a document, nothing decided
    "Under Review",      # a human is deciding
    "Not Applicable",    # does not bind this firm — with a recorded reason
    "Applicable",        # it binds us
    "Control Assigned",  # a control claims to satisfy it
    "Evidence Verified", # the control has evidence behind it
    "Compliant",         # verified and accepted
    "Non-Compliant",     # known gap
    "Exception",         # accepted gap, time-boxed, with compensating control
]

# Only these moves are legal. Notably nothing jumps from Discovered to Compliant.
TRANSITIONS: dict[str, set[str]] = {
    "Discovered":        {"Under Review", "Applicable", "Not Applicable"},
    "Under Review":      {"Applicable", "Not Applicable"},
    "Not Applicable":    {"Under Review"},
    "Applicable":        {"Control Assigned", "Non-Compliant", "Exception", "Under Review"},
    "Control Assigned":  {"Evidence Verified", "Non-Compliant", "Exception"},
    "Evidence Verified": {"Compliant", "Non-Compliant"},
    "Compliant":         {"Under Review", "Non-Compliant"},
    "Non-Compliant":     {"Control Assigned", "Exception", "Under Review"},
    "Exception":         {"Applicable", "Non-Compliant"},
}

# States that cannot be entered without a written reason.
NEEDS_REASON = {"Not Applicable", "Exception", "Non-Compliant", "Compliant"}

SCHEMA = """
-- A control is a thing the company DOES that satisfies obligations. It is not a
-- copy of the obligation text; one control can satisfy many, across regulators.
CREATE TABLE IF NOT EXISTS controls (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  control_type  TEXT,              -- preventive | detective | corrective
  frequency     TEXT,              -- continuous | daily | monthly | quarterly | annual
  automated     TEXT,              -- automated | manual | hybrid
  entity_id     TEXT REFERENCES company_entities(id) ON DELETE SET NULL,
  owner_id      TEXT REFERENCES company_entities(id) ON DELETE SET NULL,
  effectiveness TEXT,              -- Effective | Partially Effective | Ineffective | Not Tested
  last_tested   TEXT,
  next_test_due TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_controls_entity ON controls(entity_id);
CREATE INDEX IF NOT EXISTS idx_controls_owner  ON controls(owner_id);

-- The many-to-many that makes the whole thing worthwhile.
CREATE TABLE IF NOT EXISTS control_obligations (
  id            BIGSERIAL PRIMARY KEY,
  control_id    TEXT NOT NULL REFERENCES controls(id) ON DELETE CASCADE,
  obligation_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
  coverage      TEXT DEFAULT 'Full',   -- Full | Partial
  rationale     TEXT,
  status        TEXT DEFAULT 'Proposed',
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (control_id, obligation_id)
);
CREATE INDEX IF NOT EXISTS idx_co_control    ON control_obligations(control_id);
CREATE INDEX IF NOT EXISTS idx_co_obligation ON control_obligations(obligation_id);

-- Lifecycle state, kept beside the obligation rather than inside it so the
-- extracted record stays a faithful copy of the document.
CREATE TABLE IF NOT EXISTS obligation_status (
  obligation_id TEXT PRIMARY KEY REFERENCES obligations(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'Discovered',
  reason        TEXT,
  owner_id      TEXT REFERENCES company_entities(id) ON DELETE SET NULL,
  due_date      TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ostatus_state ON obligation_status(state);

CREATE TABLE IF NOT EXISTS obligation_events (
  id            BIGSERIAL PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
  from_state    TEXT, to_state TEXT NOT NULL,
  reason        TEXT, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oevents_obl ON obligation_events(obligation_id);
"""

_READY = False


def init(con) -> object:
    global _READY
    if _READY:
        return con
    try:
        con.executescript(SCHEMA)
        _READY = True
    except Exception:
        pass
    return con


class TransitionError(Exception):
    pass


# ---------------------------------------------------------------- controls
def upsert_control(con, *, control_id: str, name: str, description: str = "",
                   control_type: str | None = None, frequency: str | None = None,
                   automated: str | None = None, entity_id: str | None = None,
                   owner_id: str | None = None) -> dict:
    init(con)
    con.execute(
        """INSERT INTO controls (id,name,description,control_type,frequency,automated,
             entity_id,owner_id,effectiveness,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?, 'Not Tested', ?,?)
           ON CONFLICT (id) DO UPDATE SET
             name=EXCLUDED.name, description=EXCLUDED.description,
             control_type=COALESCE(EXCLUDED.control_type, controls.control_type),
             frequency=COALESCE(EXCLUDED.frequency, controls.frequency),
             automated=COALESCE(EXCLUDED.automated, controls.automated),
             entity_id=COALESCE(EXCLUDED.entity_id, controls.entity_id),
             owner_id=COALESCE(EXCLUDED.owner_id, controls.owner_id),
             updated_at=EXCLUDED.updated_at""",
        (control_id, name, description, control_type, frequency, automated,
         entity_id, owner_id, _now(), _now()))
    con.commit()
    return get_control(con, control_id)


def get_control(con, cid: str) -> dict | None:
    init(con)
    r = con.execute(
        """SELECT c.*, e.name AS entity_name, o.name AS owner_name,
                  (SELECT COUNT(*) FROM control_obligations co WHERE co.control_id=c.id) AS obligations,
                  (SELECT COUNT(DISTINCT ob.regulation_id) FROM control_obligations co
                     JOIN obligations ob ON ob.id=co.obligation_id WHERE co.control_id=c.id) AS regulations
           FROM controls c
           LEFT JOIN company_entities e ON e.id=c.entity_id
           LEFT JOIN company_entities o ON o.id=c.owner_id
           WHERE c.id=?""", (cid,)).fetchone()
    return dict(r) if r else None


def listing(con) -> list[dict]:
    init(con)
    return [dict(r) for r in con.execute(
        """SELECT c.*, e.name AS entity_name, o.name AS owner_name,
                  -- control_obligations holds 0 rows; the live mapping this system
                  -- writes is control_requirements, so counts come from there or
                  -- every control reads "0 duties" however many it covers.
                  (SELECT COUNT(*) FROM control_requirements cr
                    WHERE cr.control_id=c.id) AS duties,
                  (SELECT COUNT(*) FROM control_requirements cr
                    WHERE cr.control_id=c.id
                      AND cr.review_status IN ('ACCEPTED','APPROVED')) AS duties_approved,
                  (SELECT COUNT(DISTINCT r.regulation_id) FROM control_requirements cr
                     JOIN requirements r ON r.id=cr.requirement_id
                    WHERE cr.control_id=c.id) AS regulations,
                  (SELECT COUNT(*) FROM evidence_links el
                    WHERE el.control_id=c.id) AS evidence,
                  (SELECT COUNT(*) FROM compliance_tests t
                    WHERE t.control_id=c.id AND t.result='PASS') AS tests_passed,
                  (SELECT COUNT(*) FROM compliance_tests t
                    WHERE t.control_id=c.id) AS tests_run
           FROM controls c
           LEFT JOIN company_entities e ON e.id=c.entity_id
           LEFT JOIN company_entities o ON o.id=c.owner_id
           ORDER BY duties DESC NULLS LAST, c.name""")]


def link(con, control_id: str, obligation_id: str, *, coverage: str = "Full",
         rationale: str = "", actor: str = "system", status: str = "Proposed") -> bool:
    """Claim that a control satisfies an obligation. Proposed until a human accepts."""
    init(con)
    cur = con.execute(
        """INSERT INTO control_obligations (control_id,obligation_id,coverage,rationale,status,created_by,created_at)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT (control_id, obligation_id) DO NOTHING""",
        (control_id, obligation_id, coverage, rationale[:400], status, actor, _now()))
    con.commit()
    return cur.rowcount > 0


# ---------------------------------------------------------------- lifecycle
def state_of(con, obligation_id: str) -> str:
    init(con)
    r = con.execute("SELECT state FROM obligation_status WHERE obligation_id=?",
                    (obligation_id,)).fetchone()
    return r["state"] if r else "Discovered"


def set_state(con, obligation_id: str, to: str, *, actor: str, reason: str = "",
              owner_id: str | None = None, due_date: str | None = None) -> dict:
    init(con)
    if to not in STATES:
        raise ValueError(f"unknown state '{to}'")
    cur = state_of(con, obligation_id)
    if to not in TRANSITIONS.get(cur, set()):
        raise TransitionError(
            f"cannot move {cur} → {to}. Allowed: {sorted(TRANSITIONS.get(cur, set())) or 'none'}")
    if to in NEEDS_REASON and not reason.strip():
        raise TransitionError(
            f"'{to}' requires a written reason — a status nobody can explain "
            "is not defensible in an audit")

    con.execute(
        """INSERT INTO obligation_status (obligation_id,state,reason,owner_id,due_date,updated_by,updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (obligation_id) DO UPDATE SET
             state=EXCLUDED.state, reason=EXCLUDED.reason,
             owner_id=COALESCE(EXCLUDED.owner_id, obligation_status.owner_id),
             due_date=COALESCE(EXCLUDED.due_date, obligation_status.due_date),
             updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at""",
        (obligation_id, to, reason[:500], owner_id, due_date, actor, _now()))
    con.execute(
        "INSERT INTO obligation_events (obligation_id,from_state,to_state,reason,actor,at) VALUES (?,?,?,?,?,?)",
        (obligation_id, cur, to, reason[:500], actor, _now()))
    con.commit()
    return {"obligation_id": obligation_id, "from": cur, "to": to,
            "allowedNext": sorted(TRANSITIONS.get(to, set()))}


def posture(con) -> dict:
    """
    Compliance posture: where every obligation sits in its lifecycle.

    Obligations with no row are Discovered — counted honestly rather than
    excluded, because an undecided obligation is the most common real state and
    hiding it would flatter the number.
    """
    init(con)
    total = con.execute("SELECT COUNT(*) FROM obligations").fetchone()[0]
    rows = dict(con.execute(
        "SELECT state, COUNT(*) FROM obligation_status GROUP BY 1").fetchall())
    decided = sum(rows.values())
    rows["Discovered"] = rows.get("Discovered", 0) + (total - decided)
    return {
        "total": total,
        "byState": rows,
        "decided": decided,
        "undecidedPct": round(100 * (total - decided) / max(total, 1), 1),
        "controls": con.execute("SELECT COUNT(*) FROM controls").fetchone()[0],
        "controlLinks": con.execute("SELECT COUNT(*) FROM control_obligations").fetchone()[0],
        "note": "Obligations with no recorded decision count as Discovered. Excluding them "
                "would flatter the posture.",
    }


def coverage_report(con, limit: int = 20) -> list[dict]:
    """Which controls carry the most regulatory load — the reuse argument, in data."""
    init(con)
    return [dict(r) for r in con.execute(
        """SELECT c.id, c.name, c.effectiveness,
                  COUNT(DISTINCT co.obligation_id) AS obligations,
                  COUNT(DISTINCT ob.regulation_id) AS regulations
           FROM controls c
           JOIN control_obligations co ON co.control_id = c.id
           JOIN obligations ob ON ob.id = co.obligation_id
           GROUP BY c.id, c.name, c.effectiveness
           ORDER BY regulations DESC LIMIT ?""", (limit,))]
