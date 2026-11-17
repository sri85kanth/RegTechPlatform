"""
What people decide about risks (design §7 gates G3–G9, §14.4; migration 006).

Rules decide, people judge. Every decision here is a person's, recorded with
who and why, and the engine's own value is always kept beside it:

  G3  applicability   APPLICABLE / NOT_APPLICABLE for one exposure, with a reason
  G4  claimed control validate a self-declared control with evidence, or record
                      it absent; never by the person who made the claim
  G5  routing         acknowledge an assessment that crossed a line, or escalate it
  G6  treatment       accept (time-boxed) / avoid / mitigate (creates actions) /
                      transfer / escalate — always by a named person; accepting an
                      ESCALATE risk needs leadership
  G7  override        a person's band or verdict beside the computed one; a lower
                      value needs a second approver
  G8  rulebook        a version is published only with an admin and a governor,
                      two different people, after a dry-run diff
  G9  candidate       accept, merge or dismiss a risk that might apply; answer the
                      question that decides it; or add a risk of one's own

The store refuses what a role may not do (PermissionError → 403), a value it
cannot take (IntakeError → 422) and a wrong state (Conflict → 409).
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from . import engine as E
from . import intake as I
from . import library as L
from . import register as G
from .intake import Conflict, IntakeError
from .rulebook import BANDS, CATEGORIES, Rulebook

RANK = {"viewer": 0, "reviewer": 1, "compliance_manager": 2, "admin": 3}     # mirrors auth.CAPABILITIES
NEED = {"propose": 1, "approve": 2, "administer": 3}
TREATMENTS = ("ACCEPT", "AVOID", "MITIGATE", "TRANSFER", "ESCALATE")
OVERRIDE_VERDICTS = ("WITHIN_APPETITE", "TREAT", "ESCALATE")
ACCEPT_MAX_DAYS = 365
LIFECYCLE_AFTER = {"ACCEPT": "ACCEPTED", "AVOID": "CLOSED", "MITIGATE": "IN_TREATMENT", "TRANSFER": "IN_TREATMENT"}


def can(user: dict | None, capability: str) -> bool:
    return RANK.get((user or {}).get("role"), -1) >= NEED[capability]


def _need(user: dict | None, capability: str, what: str) -> None:
    if not can(user, capability):
        raise PermissionError(f"{what} needs the {'compliance manager' if capability == 'approve' else capability} role")


def actor(user: dict | None) -> str:
    return (user or {}).get("email") or (user or {}).get("name") or "api"


def _same(user: dict | None, by: str | None, by_user: str | None) -> bool:
    u = user or {}
    return bool((by_user and u.get("id") == by_user) or (by and actor(user) == by))


def _reason(v: Any, what: str = "a reason", minimum: int = 3) -> str:
    s = I._text(2000)(v, "reason")       # noqa: SLF001 — the intake store's own text cleaning
    if not s or len(s) < minimum:
        raise IntakeError(f"give {what}")
    return s


def _risk(con, risk_id: str) -> dict:
    r = G._one(con, "SELECT * FROM risks WHERE id=?", (risk_id,))     # noqa: SLF001
    if not r:
        raise KeyError(risk_id)
    return r


def _task(con, task_id: str) -> dict:
    t = G._one(con, "SELECT * FROM review_tasks WHERE id=?", (task_id,))     # noqa: SLF001
    if not t:
        raise KeyError(task_id)
    return t


def _log(con, entity: str, action: str, detail: str, who: str) -> None:
    I._log(con, entity, action, detail, who)        # noqa: SLF001


# ------------------------------------------------------------------ reading
def list_tasks(con, *, status: str = "OPEN", gate: str | None = None, user: dict | None = None,
               mine: bool = False) -> list[dict]:
    where, args = ["t.status=?"], [status]
    if gate:
        where.append("t.gate=?")
        args.append(gate)
    rows = G._rows(con, f"""SELECT t.*, r.title AS risk_title, r.theme AS risk_theme, r.lifecycle AS risk_lifecycle,
                                   a.verdict AS verdict, a.residual_band AS residual_band
                            FROM review_tasks t
                            LEFT JOIN risks r ON r.id = t.risk_id
                            LEFT JOIN risk_assessments a ON a.risk_id = t.risk_id AND a.superseded_at IS NULL
                            WHERE {' AND '.join(where)}
                            ORDER BY t.priority, t.due_at, t.created_at""", tuple(args))     # noqa: SLF001
    for t in rows:
        t["detail"] = G._j(t.get("detail"), None)     # noqa: SLF001
    if mine and user:
        gov = I.can_govern(con, user)
        rows = [t for t in rows if t["assignee_user"] == user.get("id")
                or (not t["assignee_user"] and (t["assignee_role"] in (user.get("role"), None)
                                                or (t["assignee_role"] == "governor" and gov)
                                                or (t["assignee_role"] == "compliance_manager" and can(user, "approve"))))]
    return rows


def queue_summary(con) -> dict:
    rows = G._rows(con, "SELECT gate, priority, due_at FROM review_tasks WHERE status='OPEN'")     # noqa: SLF001
    now = I.now()
    by_gate: dict[str, int] = {}
    for r in rows:
        by_gate[r["gate"]] = by_gate.get(r["gate"], 0) + 1
    return {"open": len(rows), "overdue": sum(1 for r in rows if r["due_at"] < now),
            "urgent": sum(1 for r in rows if r["priority"] == "P0"), "byGate": by_gate}


def list_risks(con, include_retired: bool = False) -> list[dict]:
    where = "" if include_retired else "WHERE r.retired_at IS NULL"
    rows = G._rows(con, f"""SELECT r.*, a.id AS assessment_id, a.seq, a.verdict, a.inherent_band, a.residual_band,
                                   a.target_band, a.confidence, a.provisional, a.recorded_at AS assessed_at
                            FROM risks r
                            LEFT JOIN risk_assessments a ON a.risk_id = r.id AND a.superseded_at IS NULL
                            {where} ORDER BY r.title""")     # noqa: SLF001
    open_by_risk: dict[str, int] = {}
    for t in G._rows(con, "SELECT risk_id FROM review_tasks WHERE status='OPEN' AND risk_id IS NOT NULL"):     # noqa: SLF001
        open_by_risk[t["risk_id"]] = open_by_risk.get(t["risk_id"], 0) + 1
    overrides: dict[str, list[dict]] = {}
    for o in G._rows(con, "SELECT risk_id, field, override_value FROM risk_overrides WHERE status='ACTIVE'"):     # noqa: SLF001
        overrides.setdefault(o["risk_id"], []).append(o)
    for r in rows:
        r["open_tasks"] = open_by_risk.get(r["id"], 0)
        r["effective_verdict"], r["effective_residual"] = r["verdict"], r["residual_band"]
        for o in overrides.get(r["id"], []):
            r["effective_verdict" if o["field"] == "verdict" else "effective_residual"] = o["override_value"]
        r["overridden"] = [o["field"] for o in overrides.get(r["id"], [])]
        r.pop("impact_basis", None)
    return rows


def risk_detail(con, lib: L.Library, risk_id: str) -> dict:
    risk = _risk(con, risk_id)
    risk["impact_basis"] = G._j(risk.get("impact_basis"), None)     # noqa: SLF001
    a = G.current_assessment(con, risk_id)
    tpl = lib.get(risk["template_id"]) if risk.get("template_id") else None
    treatments = G._rows(con, "SELECT * FROM treatment_decisions WHERE risk_id=? ORDER BY created_at DESC", (risk_id,))     # noqa: SLF001
    for t in treatments:
        t["action_ids"] = G._j(t.get("action_ids"), [])     # noqa: SLF001
    action_ids = [x["id"] for t in treatments for x in t["action_ids"]]
    actions = []
    for aid in action_ids:
        row = G._one(con, "SELECT id, title, status, due_date, priority FROM actions WHERE id=?", (aid,))     # noqa: SLF001
        if row:
            actions.append(row)
    # an obligation risk can hold thousands of duties: the first page, undecided ones first, and the total
    exposures = G._rows(con, f"""SELECT * FROM risk_exposures WHERE risk_id=? AND active=1
                                 ORDER BY CASE WHEN decided_applicability IS NULL AND engine_applicability='REVIEW_REQUIRED'
                                          THEN 0 ELSE 1 END, label LIMIT {EXPOSURE_PAGE}""", (risk_id,))     # noqa: SLF001
    counts = G._one(con, """SELECT COUNT(*) AS total,
                              SUM(CASE WHEN decided_applicability IS NULL AND engine_applicability='REVIEW_REQUIRED'
                                  THEN 1 ELSE 0 END) AS pending,
                              COUNT(DISTINCT regulation_id) AS regulations
                            FROM risk_exposures WHERE risk_id=? AND active=1""", (risk_id,)) or {}     # noqa: SLF001
    for x in exposures:
        x["missing"] = G._j(x.get("missing"), [])     # noqa: SLF001
    history = G._rows(con, "SELECT seq, verdict, residual_band, confidence, diff, trigger, recorded_at "     # noqa: SLF001
                           "FROM risk_assessments WHERE risk_id=? ORDER BY seq DESC", (risk_id,))
    for h in history:
        h["diff"] = G._j(h.get("diff"), None)     # noqa: SLF001
    return {
        "risk": risk,
        "assessment": {k: v for k, v in a.items() if k != "inputs"} if a else None,
        "driver": _driver(con, a),
        "exposureCounts": {"total": int(counts.get("total") or 0), "pending": int(counts.get("pending") or 0),
                           "regulations": int(counts.get("regulations") or 0), "shown": len(exposures)},
        "effective": G.effective(con, risk_id, a),
        "history": history,
        "exposures": exposures,
        "controls": {"typical": [{"key": f"tc-{i + 1}", "text": c.get("text"),
                                  "interval_days": min(c.get("intervals_days") or [0]) or None}
                                 for i, c in enumerate((tpl or {}).get("typical_controls") or [])],
                     "ratings": G.current_ratings(con, risk_id)},
        "template": {k: tpl.get(k) for k in ("id", "title", "consequence", "benchmark", "typical_mitigations",
                                             "division", "risk_type", "cia")} if tpl else None,
        "overrides": G._rows(con, "SELECT * FROM risk_overrides WHERE risk_id=? ORDER BY created_at DESC", (risk_id,)),     # noqa: SLF001
        "treatments": treatments,
        "actions": actions,
        "tasks": G._rows(con, "SELECT * FROM review_tasks WHERE risk_id=? ORDER BY status='OPEN' DESC, created_at DESC",     # noqa: SLF001
                         (risk_id,)),
        "events": G._rows(con, "SELECT * FROM risk_events WHERE risk_id=? ORDER BY at DESC", (risk_id,)),     # noqa: SLF001
    }


EXPOSURE_PAGE = 50


def _driver(con, a: dict | None) -> dict | None:
    """For an obligation risk: the duty that drives it — regulation, clause, statutory ceiling — from the inputs snapshot."""
    if not a or not str(a["result"].get("driver") or "").startswith("req:"):
        return None
    inputs = G._j(a.get("inputs"), {})     # noqa: SLF001
    e = next((x for x in inputs.get("exposures") or [] if x.get("id") == a["result"]["driver"]), None)
    if not e:
        return None
    m = e.get("meta") or {}
    pen = (e.get("facts") or {}).get("penalty") or {}
    return {"label": e.get("label"), "regulationId": m.get("regulation_id"), "regulation": m.get("regulation"),
            "clause": m.get("clause"), "penaltyInr": pen.get("max_fine_inr") or None,
            "imprisonment": bool(pen.get("imprisonment")), "inheritedFrom": m.get("inherited_from"),
            "consequence": (e.get("facts") or {}).get("consequence") or []}


def assign_theme(con, rb, regulation_id: str, theme: str, user: dict, note: str | None = None) -> dict:
    """G3: the theme of a regulation the rulebook cannot place. Its duties move to that theme's risk on the next run."""
    _need(user, "approve", "choosing a regulation's theme")
    if not regulation_id:
        raise IntakeError("choose a regulation")
    if not rb.theme(theme):
        raise IntakeError("choose a theme from the rulebook")
    who, ts = actor(user), I.now()
    con.execute("DELETE FROM risk_theme_assignments WHERE regulation_id=?", (regulation_id,))
    con.execute("INSERT INTO risk_theme_assignments (regulation_id, theme, note, set_by, set_at) VALUES (?,?,?,?,?)",
                (regulation_id, theme, I._text(500)(note, "note"), who, ts))     # noqa: SLF001
    for t in G._rows(con, "SELECT * FROM review_tasks WHERE subject_id=? AND gate='G3' AND reason_code='THEME_NEEDED' "     # noqa: SLF001
                          "AND status='OPEN'", (regulation_id,)):
        _done(con, t, theme, note, user)
    _log(con, regulation_id, "risk theme chosen", theme, who)
    con.commit()
    return {"regulationId": regulation_id, "theme": theme}


# ------------------------------------------------------------------ ownership and the queue
def set_owner(con, risk_id: str, user_id: str | None, name: str | None, user: dict) -> dict:
    _need(user, "approve", "choosing a risk owner")
    _risk(con, risk_id)
    name = I._text(200)(name, "name")     # noqa: SLF001
    if user_id and not name:
        raise IntakeError("give the owner's name")
    con.execute("UPDATE risks SET owner_user=?, owner_name=?, updated_at=? WHERE id=?", (user_id, name, I.now(), risk_id))
    G.event(con, risk_id, "owner set", actor(user), name or "no owner")
    for t in G._rows(con, "SELECT id FROM review_tasks WHERE risk_id=? AND gate='G6' AND status='OPEN' "     # noqa: SLF001
                          "AND created_by='engine'", (risk_id,)):
        con.execute("UPDATE review_tasks SET assignee_user=?, assignee_role=? WHERE id=?",
                    (user_id, None if user_id else "compliance_manager", t["id"]))
    con.commit()
    return _risk(con, risk_id)


def assign_task(con, task_id: str, user_id: str | None, role: str | None, user: dict) -> dict:
    _need(user, "approve", "assigning a review")
    t = _task(con, task_id)
    if t["status"] != "OPEN":
        raise Conflict("this review is already closed")
    con.execute("UPDATE review_tasks SET assignee_user=?, assignee_role=? WHERE id=?",
                (user_id, None if user_id else (role or "compliance_manager"), task_id))
    con.commit()
    return _task(con, task_id)


def _done(con, task: dict, decision: str, note: str | None, user: dict) -> None:
    con.execute("UPDATE review_tasks SET status='DONE', decision=?, note=?, decided_by=?, decided_at=? WHERE id=?",
                (decision, note, actor(user), I.now(), task["id"]))
    if task.get("risk_id"):
        G.event(con, task["risk_id"], f"review decided ({task['gate']})", actor(user),
                f"{decision}" + (f": {note}" if note else ""))


# ------------------------------------------------------------------ G9 candidates, and the questions that decide them
def answer_question(con, key: str, value: Any, note: str | None, user: dict) -> dict:
    """Answer one of ORG_QUESTIONS. The next run applies it to every template it decides."""
    _need(user, "approve", "answering what decides the library risks")
    if key not in G.ORG_KEYS:
        raise IntakeError(f"no question {key!r}")
    if key == "employees":
        n = G._int(value)     # noqa: SLF001
        if n is None:
            raise IntakeError("give a number of people")
        value = n
    elif value in (None, ""):
        con.execute("DELETE FROM risk_org_facts WHERE fact_key=?", (key,))
        con.commit()
        return questions(con)
    else:
        value = bool(I._flag(value, key))     # noqa: SLF001
    con.execute("DELETE FROM risk_org_facts WHERE fact_key=?", (key,))
    con.execute("INSERT INTO risk_org_facts (fact_key, value, note, set_by, set_at) VALUES (?,?,?,?,?)",
                (key, json.dumps(value), I._text(500)(note, "note"), actor(user), I.now()))     # noqa: SLF001
    _log(con, f"org:{key}", "risk library: question answered", json.dumps(value), actor(user))
    con.commit()
    return questions(con)


_POSSIBLE = """SELECT e.risk_id, e.missing FROM risk_exposures e
               WHERE e.active=1 AND e.risk_id IN (SELECT subject_id FROM review_tasks WHERE gate='G9' AND status='OPEN')"""


def possible_total(con) -> int:
    """How many distinct possible risks (open G9 candidates) wait on an answer of any kind."""
    return len({x["risk_id"] for x in G._rows(con, _POSSIBLE)})     # noqa: SLF001


def questions(con) -> list[dict]:
    """Each question, its answer (and where it came from), and how many possible RISKS wait on it.

    Counted per distinct risk, never per exposure row: a library template on every
    process node is one risk with many exposures, and one risk may carry more than
    one open candidate task — counting rows made a question look as if it decided
    more risks than exist.
    """
    answers, facts = G.org_answers(con), G.org_facts(con)
    waiting: dict[str, set[str]] = {}
    for x in G._rows(con, _POSSIBLE):     # noqa: SLF001
        for f in G._j(x["missing"], []):     # noqa: SLF001
            if f.startswith("org."):
                waiting.setdefault(f[4:], set()).add(x["risk_id"])
    out = []
    for key, text in G.ORG_QUESTIONS:
        a = answers.get(key)
        out.append({"key": key, "question": text, "value": facts.get(key),
                    "source": "answered" if a else ("records" if key in facts else None),
                    "answeredBy": a["set_by"] if a else None, "answeredAt": a["set_at"] if a else None,
                    "waiting": len(waiting.get(key, ()))})
    return out


def decide_candidate(con, risk_id: str, decision: str, reason: str, user: dict, merge_into: str | None = None) -> dict:
    """G9: ACCEPT (it applies), DISMISS (it does not, and why), MERGE (another risk already covers it)."""
    _need(user, "approve", "triaging a possible risk")
    risk = _risk(con, risk_id)
    decision = str(decision or "").upper()
    if decision not in ("ACCEPT", "DISMISS", "MERGE"):
        raise IntakeError("decide ACCEPT, DISMISS or MERGE")
    why = _reason(reason)
    ts, who = I.now(), actor(user)
    pending = G._rows(con, "SELECT id FROM risk_exposures WHERE risk_id=? AND active=1 AND decided_applicability IS NULL",     # noqa: SLF001
                      (risk_id,))
    if decision == "ACCEPT":
        for x in pending:
            con.execute("UPDATE risk_exposures SET decided_applicability='APPLICABLE', decision_reason=?, decided_by=?, "
                        "decided_at=? WHERE id=?", (why, who, ts, x["id"]))
    else:
        target = None
        if decision == "MERGE":
            target = _risk(con, merge_into or "")
            if target["id"] == risk_id:
                raise IntakeError("a risk cannot be merged into itself")
            G.event(con, target["id"], "merged in", who, f"{risk['title']}: {why}")
        for x in pending:
            con.execute("UPDATE risk_exposures SET decided_applicability='NOT_APPLICABLE', decision_reason=?, "
                        "decided_by=?, decided_at=? WHERE id=?", (why, who, ts, x["id"]))
        con.execute("UPDATE risks SET retired_at=?, lifecycle='RETIRED', updated_at=? WHERE id=?", (ts, ts, risk_id))
        why = f"merged into {target['title']}: {why}" if target else why
    G.event(con, risk_id, f"triaged: {decision.lower()}", who, why)
    for t in G._rows(con, "SELECT * FROM review_tasks WHERE risk_id=? AND gate IN ('G9','G3') AND status='OPEN'", (risk_id,)):     # noqa: SLF001
        _done(con, t, decision, why, user)
    _log(con, risk_id, f"risk candidate {decision.lower()}", why, who)
    con.commit()
    return _risk(con, risk_id)


def create_custom(con, rb: Rulebook, data: dict, user: dict) -> dict:
    """Lens 5: a risk a person names. They choose the theme and the impact basis; the rules score it."""
    _need(user, "propose", "adding a risk")
    title = I._text(300)(data.get("title"), "title")     # noqa: SLF001
    if not title:
        raise IntakeError("give the risk a title")
    theme = data.get("theme")
    if not rb.theme(theme):
        raise IntakeError("choose a theme")
    seeds = {}
    for dim, v in (data.get("seeds") or {}).items():
        if dim not in L.SEED_DIMENSIONS:
            raise IntakeError(f"unknown impact dimension {dim!r}")
        if v in (None, ""):
            continue
        n = G._int(v)     # noqa: SLF001
        if n is None or not 1 <= n <= 5:
            raise IntakeError(f"{dim} impact must be 1 to 5")
        seeds[dim] = n
    if not seeds:
        raise IntakeError("score at least one kind of impact, 1 to 5: without an impact basis it cannot be scored")
    fallback = rb.data["likelihood"]["base"].get("fallback") or {}
    likelihood = str(data.get("base_likelihood") or "").lower()
    if likelihood not in (fallback.get("map") or {}):
        raise IntakeError(f"how often could it happen: one of {', '.join(fallback.get('map') or {})}")
    rid, ts, who = I.new_id("RISK"), I.now(), actor(user)
    con.execute("""INSERT INTO risks (id, group_key, title, theme, origin, lifecycle, description, impact_basis,
                     created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (rid, f"custom:{rid}", title, theme, "manual", "IDENTIFIED",
                 I._text(2000)(data.get("description"), "description"),     # noqa: SLF001
                 json.dumps({"seeds": seeds, "base_likelihood": likelihood}), who, ts, ts))
    con.execute("""INSERT INTO risk_exposures (id, risk_id, exposure_key, kind, label, node_ref, engine_applicability,
                     decided_applicability, decision_reason, decided_by, decided_at, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (I.new_id("EXP"), rid, f"custom:{rid}@org", "template", title, "org", "APPLICABLE", "APPLICABLE",
                 "added by a person", who, ts, ts))
    G.event(con, rid, "identified", who, "added by a person")
    _log(con, rid, "risk added", title, who)
    con.commit()
    return _risk(con, rid)


# ------------------------------------------------------------------ G3 applicability
def decide_exposure(con, exposure_id: str, decision: str, reason: str, user: dict) -> dict:
    _need(user, "approve", "deciding applicability")
    x = G._one(con, "SELECT * FROM risk_exposures WHERE id=?", (exposure_id,))     # noqa: SLF001
    if not x:
        raise KeyError(exposure_id)
    decision = str(decision or "").upper()
    if decision not in ("APPLICABLE", "NOT_APPLICABLE"):
        raise IntakeError("decide APPLICABLE or NOT_APPLICABLE")
    why = _reason(reason)
    con.execute("UPDATE risk_exposures SET decided_applicability=?, decision_reason=?, decided_by=?, decided_at=? "
                "WHERE id=?", (decision, why, actor(user), I.now(), exposure_id))
    G.event(con, x["risk_id"], "applicability decided", actor(user),
            f"{x['label']}: {decision} (the rules said {x['engine_applicability']}) — {why}")
    for t in G._rows(con, "SELECT * FROM review_tasks WHERE subject_id=? AND gate='G3' AND status='OPEN'", (exposure_id,)):     # noqa: SLF001
        _done(con, t, decision, why, user)
    con.commit()
    return G._one(con, "SELECT * FROM risk_exposures WHERE id=?", (exposure_id,))     # noqa: SLF001


# ------------------------------------------------------------------ controls and G4
def _rating_row(con, rid: str) -> dict:
    r = G._one(con, "SELECT * FROM risk_control_ratings WHERE id=?", (rid,))     # noqa: SLF001
    if not r:
        raise KeyError(rid)
    return r


GRADES_IN = ("ABSENT", "CLAIMED", "DOCUMENTED", "TESTED")


def clean_control(data: dict, user: dict) -> dict:
    """Check one control rating as a person would enter it. Raises with the reason; writes nothing."""
    grade = str(data.get("grade") or "").upper()
    if grade not in GRADES_IN:
        raise IntakeError("grade must be ABSENT, CLAIMED, DOCUMENTED or TESTED")
    if grade in ("DOCUMENTED", "TESTED"):
        _need(user, "approve", "grading a control documented or tested")
    else:
        _need(user, "propose", "recording a control")
    label = I._text(300)(data.get("label"), "control")     # noqa: SLF001
    if not label:
        raise IntakeError("name the control")
    kind = str(data.get("kind") or "preventive").lower()
    if kind not in ("preventive", "detective", "corrective"):
        raise IntakeError("kind must be preventive, detective or corrective")
    evidence = I._text(500)(data.get("evidence"), "evidence")     # noqa: SLF001
    evidence_on = I._date(data.get("evidence_on"), "evidence date")     # noqa: SLF001
    if grade in ("DOCUMENTED", "TESTED") and not (evidence and evidence_on):
        raise IntakeError("a documented or tested control needs the evidence and its date")
    if evidence_on and evidence_on > G._today().isoformat():     # noqa: SLF001
        raise IntakeError("the evidence date cannot be in the future")
    interval = G._int(data.get("interval_days")) if data.get("interval_days") not in (None, "") else None     # noqa: SLF001
    return {"control_key": data.get("control_key") or f"c-{I.new_id('C')[2:]}", "label": label, "kind": kind,
            "grade": grade, "evidence": evidence, "evidence_on": evidence_on, "interval_days": interval,
            "note": I._text(1000)(data.get("note"), "note")}     # noqa: SLF001


def record_control(con, risk_id: str, data: dict, user: dict, *, source: str = "person", commit: bool = True) -> dict:
    """What a person knows about one of the risk's controls. A tested or documented grade needs evidence.

    `source`: person (typed in), workbook (an uploaded control workbook), control:<id> / entity:<id>
    (mapped from a control the company already records).
    """
    _risk(con, risk_id)
    c = clean_control(data, user)
    ts = I.precise_now()
    con.execute("UPDATE risk_control_ratings SET superseded_at=? WHERE risk_id=? AND control_key=? AND superseded_at IS NULL",
                (ts, risk_id, c["control_key"]))
    rid = I.new_id("CR")
    con.execute("""INSERT INTO risk_control_ratings (id, risk_id, control_key, label, kind, grade, evidence, evidence_on,
                     interval_days, note, source, rated_by, rated_by_user, recorded_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (rid, risk_id, c["control_key"], c["label"], c["kind"], c["grade"], c["evidence"], c["evidence_on"],
                 c["interval_days"], c["note"], source, actor(user), (user or {}).get("id"), ts))
    G.event(con, risk_id, "control recorded", actor(user),
            f"{c['label']}: {c['grade']}" + (f" ({c['evidence']})" if c["evidence"] else "")
            + ("" if source == "person" else f" — from {source}"))
    if commit:
        con.commit()
    return _rating_row(con, rid)


def validate_control(con, rating_id: str, grade: str, user: dict, *, evidence: str | None = None,
                     evidence_on: str | None = None, note: str | None = None) -> dict:
    """G4: a compliance manager who did not make the claim upgrades it with evidence, or records it absent."""
    _need(user, "approve", "validating a control")
    r = _rating_row(con, rating_id)
    if r["superseded_at"] or r["grade"] != "CLAIMED":
        raise Conflict("only a current self-declared control can be validated")
    if _same(user, r["rated_by"], r["rated_by_user"]):
        raise PermissionError("the person who declared a control cannot validate it")
    out = record_control(con, r["risk_id"], {"control_key": r["control_key"], "label": r["label"], "kind": r["kind"],
                                             "grade": grade, "evidence": evidence, "evidence_on": evidence_on,
                                             "interval_days": r["interval_days"], "note": note}, user)
    con.execute("UPDATE risk_control_ratings SET validated_by=? WHERE id=?", (actor(user), out["id"]))
    for t in G._rows(con, "SELECT * FROM review_tasks WHERE subject_id=? AND gate='G4' AND status='OPEN'", (rating_id,)):     # noqa: SLF001
        _done(con, t, str(grade).upper(), note, user)
    con.commit()
    return _rating_row(con, out["id"])


# ------------------------------------------------------------------ G5 routing
def acknowledge(con, task_id: str, user: dict, *, note: str | None = None, escalate: bool = False) -> dict:
    _need(user, "approve", "acknowledging a routed risk")
    t = _task(con, task_id)
    if t["gate"] != "G5" or t["status"] != "OPEN":
        raise Conflict("this is not an open routed risk")
    if escalate:
        con.execute("UPDATE review_tasks SET assignee_user=NULL, assignee_role='governor', priority='P0', note=? WHERE id=?",
                    (I._text(2000)(note, "note"), task_id))     # noqa: SLF001
        if t.get("risk_id"):
            G.event(con, t["risk_id"], "escalated to leadership", actor(user), note or "")
    else:
        _done(con, t, "ACKNOWLEDGED", I._text(2000)(note, "note"), user)     # noqa: SLF001
    con.commit()
    return _task(con, task_id)


# ------------------------------------------------------------------ G6 treatment
def decide_treatment(con, risk_id: str, data: dict, user: dict) -> dict:
    """A named person decides. Nothing reaches ACCEPTED without a name, a designation and a review date."""
    risk = _risk(con, risk_id)
    a = G.current_assessment(con, risk_id)
    if not a or not a["residual_band"]:
        raise Conflict("this risk has no residual score yet: resolve its review first")
    owner = bool(risk["owner_user"]) and (user or {}).get("id") == risk["owner_user"]
    if not (owner or can(user, "approve")):
        raise PermissionError("the risk owner or a compliance manager decides its treatment")
    decision = str(data.get("decision") or "").upper()
    if decision not in TREATMENTS:
        raise IntakeError(f"decide one of {', '.join(TREATMENTS)}")
    eff = G.effective(con, risk_id, a)
    if decision == "ACCEPT" and "ESCALATE" in (eff["verdict"], eff.get("floor_verdict")) \
            and not I.can_govern(con, user):
        raise PermissionError("a risk above tolerance can be accepted only by leadership")
    rationale = _reason(data.get("rationale"), "the rationale", 10)
    name = I._text(200)(data.get("name"), "name")     # noqa: SLF001
    designation = I._text(200)(data.get("designation"), "designation")     # noqa: SLF001
    if not name or not designation:
        raise IntakeError("the decision needs the decider's name and designation")
    accept_until = transfer_to = instrument = None
    action_refs: list[dict] = []
    if decision == "ACCEPT":
        accept_until = I._date(data.get("accept_until"), "review date")     # noqa: SLF001
        today = G._today()     # noqa: SLF001
        if not accept_until or not today < date.fromisoformat(accept_until) <= today + timedelta(days=ACCEPT_MAX_DAYS):
            raise IntakeError(f"an acceptance needs a review date within the next {ACCEPT_MAX_DAYS} days")
    elif decision == "TRANSFER":
        transfer_to = I._text(300)(data.get("transfer_to"), "transfer to")     # noqa: SLF001
        instrument = I._text(300)(data.get("instrument"), "instrument")     # noqa: SLF001
        if not transfer_to or not instrument:
            raise IntakeError("a transfer names who takes it on and the policy or contract")
    elif decision == "MITIGATE":
        items = data.get("actions") or []
        if not items:
            raise IntakeError("a mitigation needs at least one action")
        for it in items:
            if not I._text(300)(it.get("title"), "action"):     # noqa: SLF001
                raise IntakeError("every action needs a title")
            I._date(it.get("due_date"), "due date")     # noqa: SLF001
            if str(it.get("kind") or "preventive").lower() not in ("preventive", "detective", "corrective"):
                raise IntakeError("action kind must be preventive, detective or corrective")
    who, ts = actor(user), I.now()
    tid = I.new_id("TD")
    if decision == "MITIGATE":
        from .. import actions as A                    # the existing actions lifecycle (Proposed → Open → Done)
        for it in data["actions"]:
            act = A.create(con, title=I._text(300)(it["title"], "action"), action_type="add_control",     # noqa: SLF001
                           priority="P1" if a["residual_band"] in ("HIGH", "CRITICAL") else "P2",
                           description=f"Treatment for risk {risk['title']} ({risk_id}), decision {tid}.",
                           due_date=I._date(it.get("due_date"), "due date"), source="risk-treatment",     # noqa: SLF001
                           created_by=who, status="Proposed")
            A.transition(con, act["id"], "Open", actor=who, note=f"accepted in treatment decision {tid} by {name}")
            action_refs.append({"id": act["id"], "kind": str(it.get("kind") or "preventive").lower()})
    con.execute("UPDATE treatment_decisions SET status='SUPERSEDED' WHERE risk_id=? AND status='ACTIVE'", (risk_id,))
    con.execute("""INSERT INTO treatment_decisions (id, risk_id, assessment_id, decision, rationale, decided_by,
                     decided_by_user, decider_name, decider_designation, accept_until, transfer_to, instrument,
                     action_ids, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (tid, risk_id, a["id"], decision, rationale, who, (user or {}).get("id"), name, designation,
                 accept_until, transfer_to, instrument, json.dumps(action_refs), "ACTIVE", ts))
    if decision in LIFECYCLE_AFTER:
        con.execute("UPDATE risks SET lifecycle=?, updated_at=? WHERE id=?", (LIFECYCLE_AFTER[decision], ts, risk_id))
    detail = {"ACCEPT": f"until {accept_until}", "TRANSFER": f"to {transfer_to} ({instrument})",
              "MITIGATE": f"{len(action_refs)} actions", "AVOID": "", "ESCALATE": "referred to leadership"}[decision]
    G.event(con, risk_id, f"treatment: {decision.lower()}", who, f"{name}, {designation}. {detail} — {rationale}")
    for t in G._rows(con, "SELECT * FROM review_tasks WHERE risk_id=? AND gate='G6' AND status='OPEN'", (risk_id,)):     # noqa: SLF001
        _done(con, t, decision, rationale, user)
    if decision == "ESCALATE":
        G.open_task(con, gate="G6", reason_code="ESCALATED", subject_kind="risk", subject_id=risk_id, risk_id=risk_id,
                    priority="P0", role="governor", created_by=who, detail={"name": name, "rationale": rationale},
                    reason=f"{name} referred this risk to leadership: {rationale}")
    _log(con, risk_id, f"risk treatment {decision.lower()}", f"{name}, {designation}: {rationale}", who)
    con.commit()
    return G._one(con, "SELECT * FROM treatment_decisions WHERE id=?", (tid,))     # noqa: SLF001


# ------------------------------------------------------------------ G7 overrides
def _direction(field: str, computed: str, value: str) -> str:
    rank = (lambda v: G.BAND_RANK[v]) if field == "residual_band" else (lambda v: G.VERDICT_RANK[v])
    return "raise" if rank(value) > rank(computed) else "lower"


def propose_override(con, risk_id: str, data: dict, user: dict) -> dict:
    _need(user, "approve", "overriding a computed value")
    _risk(con, risk_id)
    a = G.current_assessment(con, risk_id)
    if not a:
        raise Conflict("this risk has not been assessed yet")
    field = data.get("field")
    if field not in ("residual_band", "verdict"):
        raise IntakeError("override the residual band or the verdict")
    value = str(data.get("value") or "").upper()
    options = BANDS if field == "residual_band" else OVERRIDE_VERDICTS
    if value not in options:
        raise IntakeError(f"choose one of {', '.join(options)}")
    computed = a[field] if field == "verdict" else a["residual_band"]
    if not computed:
        raise Conflict("there is no computed value to override yet")
    if value == computed:
        raise IntakeError("that is the computed value already")
    if G._one(con, "SELECT 1 FROM risk_overrides WHERE risk_id=? AND field=? AND status IN ('ACTIVE','PENDING')",     # noqa: SLF001
              (risk_id, field)):
        raise Conflict("there is already an override of this value: revoke it first")
    reason = _reason(data.get("reason"), "the reason for the override", 10)
    direction = _direction(field, computed, value)
    status = "ACTIVE" if direction == "raise" else "PENDING"
    oid, ts, who = I.new_id("OVR"), I.now(), actor(user)
    con.execute("""INSERT INTO risk_overrides (id, risk_id, assessment_id, inputs_hash, field, computed_value,
                     override_value, direction, reason, evidence, proposed_by, proposed_by_user, status, created_at,
                     decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (oid, risk_id, a["id"], a["inputs_hash"], field, computed, value, direction, reason,
                 I._text(500)(data.get("evidence"), "evidence"), who, (user or {}).get("id"), status, ts,     # noqa: SLF001
                 ts if status == "ACTIVE" else None))
    G.event(con, risk_id, f"override {'applied' if status == 'ACTIVE' else 'proposed'}", who,
            f"{field.replace('_', ' ')} {computed} → {value}: {reason}")
    if status == "PENDING":
        G.open_task(con, gate="G7", reason_code="SECOND_APPROVER", subject_kind="override", subject_id=oid,
                    risk_id=risk_id, priority="P1", role="compliance_manager", created_by=who,
                    detail={"who": who, "field": field, "computed": computed, "value": value, "reason": reason},
                    reason=f"{who} proposes {field.replace('_', ' ')} {computed} → {value} (lower than computed). "
                           f"A second approver must agree: {reason}")
    _log(con, risk_id, f"risk override {direction}", f"{field} {computed} → {value}", who)
    con.commit()
    return G._one(con, "SELECT * FROM risk_overrides WHERE id=?", (oid,))     # noqa: SLF001


def decide_override(con, override_id: str, approve: bool, user: dict, note: str | None = None) -> dict:
    _need(user, "approve", "approving an override")
    o = G._one(con, "SELECT * FROM risk_overrides WHERE id=?", (override_id,))     # noqa: SLF001
    if not o:
        raise KeyError(override_id)
    if o["status"] != "PENDING":
        raise Conflict("this override is not waiting for a second approver")
    if _same(user, o["proposed_by"], o["proposed_by_user"]):
        raise PermissionError("the second approver must be a different person")
    note = I._text(2000)(note, "note")     # noqa: SLF001
    if not approve and not note:
        raise IntakeError("say why the override is rejected")
    status = "ACTIVE" if approve else "REJECTED"
    con.execute("UPDATE risk_overrides SET status=?, second_by=?, second_by_user=?, note=?, decided_at=? WHERE id=?",
                (status, actor(user), (user or {}).get("id"), note, I.now(), override_id))
    G.event(con, o["risk_id"], f"override {'approved' if approve else 'rejected'}", actor(user),
            f"{o['field'].replace('_', ' ')} → {o['override_value']}" + (f": {note}" if note else ""))
    for t in G._rows(con, "SELECT * FROM review_tasks WHERE subject_id=? AND gate='G7' AND status='OPEN'", (override_id,)):     # noqa: SLF001
        _done(con, t, status, note, user)
    con.commit()
    return G._one(con, "SELECT * FROM risk_overrides WHERE id=?", (override_id,))     # noqa: SLF001


def revoke_override(con, override_id: str, user: dict, note: str | None = None) -> dict:
    _need(user, "approve", "revoking an override")
    o = G._one(con, "SELECT * FROM risk_overrides WHERE id=?", (override_id,))     # noqa: SLF001
    if not o:
        raise KeyError(override_id)
    if o["status"] not in ("ACTIVE", "PENDING", "STALE"):
        raise Conflict("this override is not in force")
    con.execute("UPDATE risk_overrides SET status='REVOKED', note=?, decided_at=? WHERE id=?",
                (I._text(2000)(note, "note"), I.now(), override_id))     # noqa: SLF001
    G.close_tasks(con, subject_id=override_id, status="CANCELLED", note="the override was revoked", actor=actor(user))
    G.event(con, o["risk_id"], "override revoked", actor(user), f"{o['field'].replace('_', ' ')} → {o['override_value']}")
    con.commit()
    return G._one(con, "SELECT * FROM risk_overrides WHERE id=?", (override_id,))     # noqa: SLF001


# ------------------------------------------------------------------ G8 rulebook publication
def publication_state(con, rb: Rulebook) -> dict:
    rows = G._rows(con, "SELECT * FROM rulebook_publications WHERE rulebook=? ORDER BY created_at DESC", (rb.ref["name"],))     # noqa: SLF001
    for r in rows:
        r["diff"] = G._j(r.get("diff"), None)     # noqa: SLF001
    published = next((r for r in rows if r["status"] == "PUBLISHED"), None)
    pending = next((r for r in rows if r["status"] == "PENDING" and r["rulebook_hash"] == rb.ref["hash"]), None)
    return {"rulebook": rb.ref, "published": published, "pending": pending,
            "current": bool(published and published["rulebook_hash"] == rb.ref["hash"]), "history": rows[:10]}


def dry_run(con, rb: Rulebook, lib: L.Library, as_of: date | None = None) -> dict:
    """What this rulebook would change against the assessments in force: verdict changes and the biggest movers."""
    as_of = as_of or G._today()     # noqa: SLF001
    appetite = I.appetite_for_engine(con)
    ctx = G.context(con)
    changes, movers = [], []
    risks = G._rows(con, "SELECT * FROM risks WHERE retired_at IS NULL")     # noqa: SLF001
    for risk in risks:
        cur = G.current_assessment(con, risk["id"])
        res = E.assess(rb, G.risk_input(con, rb, lib, risk, as_of, ctx), appetite, as_of)
        before_v, after_v = (cur or {}).get("verdict"), res["verdict"]
        before_b, after_b = (cur or {}).get("residual_band"), G._band(res.get("residual"))     # noqa: SLF001
        if before_v != after_v:
            changes.append({"risk": risk["id"], "title": risk["title"], "before": before_v, "after": after_v})
        if before_b and after_b and before_b != after_b:
            movers.append({"risk": risk["id"], "title": risk["title"], "before": before_b, "after": after_b,
                           "move": G.BAND_RANK[after_b] - G.BAND_RANK[before_b]})
    movers.sort(key=lambda m: -abs(m["move"]))
    return {"risks": len(risks), "verdictChanges": len(changes), "changes": changes[:50], "topMovers": movers[:10]}


def request_publication(con, rb: Rulebook, lib: L.Library, user: dict) -> dict:
    _need(user, "approve", "asking to publish a rulebook")
    st = publication_state(con, rb)
    if st["current"]:
        raise Conflict("this rulebook version is already published")
    if st["pending"]:
        return st
    pid, who = I.new_id("PUB"), actor(user)
    diff = dry_run(con, rb, lib)
    con.execute("""INSERT INTO rulebook_publications (id, rulebook, version, rulebook_hash, status, diff, requested_by,
                     created_at) VALUES (?,?,?,?,?,?,?,?)""",
                (pid, rb.ref["name"], rb.ref["version"], rb.ref["hash"], "PENDING", json.dumps(diff), who, I.now()))
    G.open_task(con, gate="G8", reason_code="PUBLISH", subject_kind="rulebook", subject_id=pid, priority="P2",
                role="admin", created_by=who,
                detail={"name": rb.ref["name"], "version": rb.ref["version"], "changes": diff["verdictChanges"],
                        "risks": diff["risks"]},
                reason=f"Rulebook {rb.ref['name']} {rb.ref['version']}: {diff['verdictChanges']} of {diff['risks']} "
                       f"verdicts would change. An admin and a governor, two different people, must approve.")
    _log(con, pid, "rulebook publication requested", f"{rb.ref['name']} {rb.ref['version']}", who)
    con.commit()
    return publication_state(con, rb)


def decide_publication(con, rb: Rulebook, pub_id: str, approve: bool, user: dict, note: str | None = None) -> dict:
    p = G._one(con, "SELECT * FROM rulebook_publications WHERE id=?", (pub_id,))     # noqa: SLF001
    if not p:
        raise KeyError(pub_id)
    if p["status"] != "PENDING":
        raise Conflict("this publication is not waiting for approval")
    is_admin, is_gov = can(user, "administer"), I.can_govern(con, user)
    if not (is_admin or is_gov):
        raise PermissionError("an admin or a governor approves a rulebook")
    who, uid, ts = actor(user), (user or {}).get("id"), I.now()
    note = I._text(2000)(note, "note")     # noqa: SLF001
    if not approve:
        if not note:
            raise IntakeError("say why it is rejected")
        con.execute("UPDATE rulebook_publications SET status='REJECTED', note=?, decided_at=? WHERE id=?", (note, ts, pub_id))
        G.close_tasks(con, subject_id=pub_id, decision="REJECTED", note=note, actor=who)
        con.commit()
        return publication_state(con, rb)
    # the admin approval and the governor approval must come from two different people
    if is_admin and not p["admin_by"] and not (p["governor_by_user"] == uid or p["governor_by"] == who):
        con.execute("UPDATE rulebook_publications SET admin_by=?, admin_by_user=? WHERE id=?", (who, uid, pub_id))
    elif is_gov and not p["governor_by"] and not (p["admin_by_user"] == uid or p["admin_by"] == who):
        con.execute("UPDATE rulebook_publications SET governor_by=?, governor_by_user=? WHERE id=?", (who, uid, pub_id))
    else:
        raise PermissionError("the second approval must come from a different person")
    p = G._one(con, "SELECT * FROM rulebook_publications WHERE id=?", (pub_id,))     # noqa: SLF001
    if p["admin_by"] and p["governor_by"]:
        con.execute("UPDATE rulebook_publications SET status='SUPERSEDED' WHERE rulebook=? AND status='PUBLISHED'",
                    (p["rulebook"],))
        con.execute("UPDATE rulebook_publications SET status='PUBLISHED', note=?, decided_at=? WHERE id=?", (note, ts, pub_id))
        G.close_tasks(con, subject_id=pub_id, decision="PUBLISHED", note=note, actor=who)
        _log(con, pub_id, "rulebook published", f"{p['rulebook']} {p['version']}", who)
    con.commit()
    return publication_state(con, rb)


def categories() -> list[str]:
    return list(CATEGORIES)
