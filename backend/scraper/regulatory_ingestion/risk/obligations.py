"""
Lens 1 — obligations (design §4.1, §4.2, §14.3).

Every requirement that applies to the company is an exposure: "failing this
duty". Exposures group into one risk per theme — "Breach of data protection and
privacy obligations" holds every applicable duty from the DPDP Act, the IT Act's
data rules and anything else the rulebook maps to that theme. (The design's
(theme, site) grouping needs per-site applicability, which requirements do not
carry yet; one risk per theme for the whole organisation until they do.)

Facts follow the rulebook's input contract (§15 #7): every fact a rule reads is
set, false and 0 included, because a fact left out is unknown and priced at its
worse value.

  penalty.*            the regulation's statutory ceilings (penalty_provisions):
                       max_fine_inr (0 when none is stated), imprisonment, present.
                       Rules under an Act with no penalty clause of their own
                       inherit the Act's (regulations.enabling_act).
  consequence          licence_suspension when the text provides for suspending
                       or cancelling a registration or licence
  instrument_type      act / rules / regulation / standard / guideline
  regulator.*          inspection_frequency (the pack's seed table) and
                       publishes_enforcement (enforcement actions on file)
  exposure.guards_licence     the regulation governs a licence the company holds
  requirement.section_changed_12m, evidence.predates_change   change velocity
  controls             company controls mapped to the requirement and accepted by
                       a person, graded no better than their own evidence
  gap_status           the gap review's finding (MET / PARTIAL / GAP / NOT_COVERED)

A regulation the rulebook cannot place in a theme waits for a person (G3):
its duties sit in "Obligations without a theme yet", unscored, until someone
chooses the theme; the choice is kept in risk_theme_assignments.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from typing import Any

from . import controls_import as CI
from . import intake as I
from . import register as G
from .rulebook import Rulebook

UNTHEMED = "UNTHEMED"
SCORED_IN = {"APPLICABLE", "CONDITIONAL"}
PENDING_IN = {"REVIEW_REQUIRED", "UNASSESSED", "NOT_ASSESSED", None, ""}
GAP_STATUSES = {"MET", "PARTIAL", "GAP", "NOT_COVERED"}


def group_key(theme: str | None) -> str:
    return f"obligation:{theme or UNTHEMED}@org"


def is_obligation(risk: dict | None) -> bool:
    return bool(risk and str(risk.get("group_key") or "").startswith("obligation:"))


def _try(con, sql: str, args: tuple = ()) -> list[dict]:
    return CI._try(con, sql, args)     # noqa: SLF001 — a workspace without that table yet reads as empty


def _norm(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def _section(clause: Any) -> str | None:
    """'Section 8(5)' / 's. 8(5)' / '8(5)(a)' → '8'; a rule or regulation number likewise."""
    m = re.search(r"(?:section|sec\.?|s\.|rule|regulation|reg\.|clause|para(?:graph)?)?\s*(\d+[A-Z]?)", str(clause or ""), re.I)
    return m.group(1).upper() if m else None


def instrument_type(reg: dict) -> str | None:
    t = _norm(reg.get("regulation_type"))
    title = _norm(reg.get("title"))
    for words, kind in ((("guideline", "advisory", "faq", "best practice"), "guideline"),
                        (("standard", "accreditation"), "standard"),
                        (("rules",), "rules"),
                        (("regulation", "direction", "notification", "circular", "order", "master"), "regulation"),
                        (("act", "code", "ordinance"), "act")):
        if any(w in t.split() or w == t for w in words):
            return kind
    if re.search(r"\brules\b", title):
        return "rules"
    if re.search(r"\b(act|code)\b", title):
        return "act"
    if re.search(r"\b(regulations?|directions?)\b", title):
        return "regulation"
    return None


# ------------------------------------------------------------------ reading the library, once
def _penalties(con) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for p in _try(con, "SELECT regulation_id, kind, amount_max, per_day_amount, imprisonment_months FROM penalty_provisions"):
        s = out.setdefault(p["regulation_id"], {"max_fine_inr": 0, "imprisonment": False, "suspension": False, "present": False})
        s["present"] = True
        if p["kind"] in ("FIXED_FINE", "PER_DAY") and p.get("amount_max"):
            s["max_fine_inr"] = max(s["max_fine_inr"], int(p["amount_max"]))
        if p["kind"] == "IMPRISONMENT":
            s["imprisonment"] = True
        if p["kind"] == "SUSPENSION_CANCELLATION":
            s["suspension"] = True
    return out


def _regulations(con) -> dict[str, dict]:
    return {r["id"]: r for r in _try(con, "SELECT * FROM regulations")}


def _inherit(regs: dict[str, dict], pens: dict[str, dict]) -> dict[str, str]:
    """Rules with no penalty clause of their own → the Act that enables them, when the library holds it."""
    by_title = {}
    for r in regs.values():
        for k in ("title", "short_title"):
            if r.get(k):
                by_title.setdefault(_norm(r[k]), r["id"])
    out = {}
    for rid, r in regs.items():
        if rid in pens or not r.get("enabling_act"):
            continue
        parent = by_title.get(_norm(r["enabling_act"]))
        if parent and parent in pens and parent != rid:
            out[rid] = parent
    return out


def _changes(con, since: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in _try(con, "SELECT regulation_id, section_number, detected_at, change_class FROM section_changes "
                       "WHERE detected_at >= ?", (since,)):
        if str(c.get("change_class") or "").upper() == "NUMBERING_ONLY":
            continue
        out.setdefault(c["regulation_id"], []).append(c)
    return out


def _controls(con) -> tuple[dict[str, list[str]], dict[str, dict]]:
    mapped: dict[str, list[str]] = {}
    for m in _try(con, "SELECT control_id, requirement_id, review_status FROM control_requirements"):
        if str(m.get("review_status") or "").upper() in ("ACCEPTED", "APPROVED"):
            mapped.setdefault(m["requirement_id"], []).append(f"control:{m['control_id']}")
    return mapped, {c["id"]: c for c in CI.existing_controls(con)}


def _engine_control(c: dict) -> dict:
    """A company control as the engine reads it, graded by its own record (controls_import.proposed_grade)."""
    g = CI.proposed_grade(c)
    kind = c["kind"] if c.get("kind") in ("preventive", "detective", "corrective") else "preventive"
    return G._engine_control({"control_key": c["id"], "label": c["name"], "kind": kind, "grade": g["grade"],     # noqa: SLF001
                              "evidence_on": g["evidence_on"], "interval_days": None})


def _licence_words(con) -> set[str]:
    words: set[str] = set()
    for lic in I.list_records(con, "licences"):
        for k in ("kind", "issuer"):
            words |= {w for w in _norm(lic.get(k)).split() if len(w) > 3 and w not in ("licence", "license", "registration",
                                                                                     "authorisation", "certificate")}
    return words


def theme_assignments(con) -> dict[str, str]:
    return {r["regulation_id"]: r["theme"] for r in _try(con, "SELECT regulation_id, theme FROM risk_theme_assignments")}


def _theme(rb: Rulebook, reg: dict, gap: dict | None, chosen: dict[str, str]) -> str | None:
    if reg["id"] in chosen and rb.theme(chosen[reg["id"]]):
        return chosen[reg["id"]]
    chapter = None
    if gap and gap.get("unit_code"):
        m = re.match(r"([A-Za-z]{3})", str(gap["unit_code"]))
        chapter = m.group(1) if m else None
    theme, _ = rb.theme_for(regulator=reg.get("regulator_short"), title=reg.get("title"), nabh_chapter=chapter)
    if not theme and reg.get("short_title"):
        theme, _ = rb.theme_for(title=reg.get("short_title"))
    return theme


def load(con, rb: Rulebook, as_of: date | None = None) -> dict:
    """Every applicable duty as an engine exposure, keyed `req:<requirement id>`, with what grouping needs."""
    as_of = as_of or G._today()     # noqa: SLF001
    rows = _try(con, "SELECT requirement_id, regulation_id, statement, source_clause, applicability, applicability_reason "
                     "FROM v_company_requirements")
    if not rows:
        return {"exposures": {}, "groups": {}, "regulations": {}}
    regs = _regulations(con)
    pens = _penalties(con)
    parents = _inherit(regs, pens)
    since = (as_of - timedelta(days=365)).isoformat()
    changes = _changes(con, since)
    mapped, controls = _controls(con)
    gaps = {g["requirement_id"]: g for g in _try(con, "SELECT requirement_id, status, unit_code FROM gap_assessments")}
    enforcing = {str(e["regulator"]).strip().upper() for e in _try(con, "SELECT DISTINCT regulator FROM enforcement_actions")}
    have_enforcement = bool(_try(con, "SELECT 1 AS x FROM enforcement_actions LIMIT 1")) or bool(enforcing)
    licence_words = _licence_words(con)
    chosen = theme_assignments(con)
    exposures: dict[str, dict] = {}
    groups: dict[str, list[str]] = {}
    for q in rows:
        verdict = (q.get("applicability") or "").upper() or None
        if verdict == "NOT_APPLICABLE":
            continue
        reg = regs.get(q["regulation_id"]) or {"id": q["regulation_id"], "title": q["regulation_id"]}
        gap = gaps.get(q["requirement_id"])
        theme = _theme(rb, reg, gap, chosen)
        pen = pens.get(reg["id"]) or pens.get(parents.get(reg["id"], ""))
        pen = dict(pen) if pen else {"max_fine_inr": 0, "imprisonment": False, "suspension": False, "present": False}
        sec = _section(q.get("source_clause"))
        reg_changes = changes.get(reg["id"]) or []
        hit = [c for c in reg_changes if not sec or _section(c.get("section_number")) == sec]
        last_change = max((str(c.get("detected_at") or "") for c in hit), default="")
        ctl = [controls[c] for c in mapped.get(q["requirement_id"], []) if c in controls]
        newest = max((str(e.get("on") or "") for c in ctl for e in (c.get("evidence") or [])), default="")
        regulator = str(reg.get("regulator_short") or reg.get("regulator") or "").strip()
        title_words = set(_norm(reg.get("title")).split())
        facts: dict[str, Any] = {
            "penalty": {"max_fine_inr": pen["max_fine_inr"], "imprisonment": pen["imprisonment"], "present": pen["present"]},
            "consequence": ["licence_suspension"] if pen["suspension"] else [],
            "exposure": {"guards_licence": bool(pen["suspension"] or (licence_words & title_words)
                                                or (regulator and regulator.lower() in licence_words))},
            "requirement": {"section_changed_12m": bool(hit)},
            "evidence": {"predates_change": bool(hit) and (not newest or newest < last_change)},
        }
        kind = instrument_type(reg)
        if kind:
            facts["instrument_type"] = kind
        reg_facts: dict[str, Any] = {}
        freq = rb.inspection_frequency(regulator)
        if freq:
            reg_facts["inspection_frequency"] = freq
        if have_enforcement:
            reg_facts["publishes_enforcement"] = regulator.upper() in enforcing
        if reg_facts:
            facts["regulator"] = reg_facts
        status = str((gap or {}).get("status") or "").upper()
        clause = str(q.get("source_clause") or "").strip()
        short = reg.get("short_title") or reg.get("title") or reg["id"]
        statement = re.sub(r"\s+", " ", str(q.get("statement") or "")).strip()
        label = f"{short} {clause}".strip() + f" — {statement[:140]}" + ("…" if len(statement) > 140 else "")
        pending = verdict in PENDING_IN or theme is None
        x = {
            "id": f"req:{q['requirement_id']}", "kind": "obligation", "label": label, "theme": theme,
            "applicability": ("REVIEW_REQUIRED" if pending else verdict),
            "gap_status": status if status in GAP_STATUSES else None, "gap_status_reviewed": False,
            "facts": facts, "controls": [_engine_control(c) for c in ctl],
            "meta": {"regulation_id": reg["id"], "requirement_id": q["requirement_id"], "regulation": reg.get("title"),
                     "clause": clause or None, "penalty_inr": pen["max_fine_inr"] or None,
                     "imprisonment": pen["imprisonment"], "inherited_from": parents.get(reg["id"]),
                     "missing": ["theme"] if theme is None else ([] if verdict in SCORED_IN else ["applicability"])},
        }
        exposures[x["id"]] = x
        groups.setdefault(theme or UNTHEMED, []).append(x["id"])
    return {"exposures": exposures, "groups": groups, "regulations": regs}


# ------------------------------------------------------------------ identify
def _title(rb: Rulebook, theme: str) -> str:
    if theme == UNTHEMED:
        return "Obligations without a theme yet"
    name = (rb.theme(theme) or {}).get("name") or theme
    return f"Breach of {name[0].lower() + name[1:]} obligations"


def identify(con, rb: Rulebook, actor: str = "engine", as_of: date | None = None, data: dict | None = None) -> dict:
    """One derived risk per theme with applicable duties, its exposures one per duty. Idempotent."""
    data = data or load(con, rb, as_of)
    ts = I.now()
    created = refreshed = retired = 0
    seen: set[str] = set()
    for theme, ids in data["groups"].items():
        key = group_key(theme if theme != UNTHEMED else None)
        seen.add(key)
        regs = {data["exposures"][i]["meta"]["regulation_id"] for i in ids}
        desc = f"{len(ids):,} applicable duties from {len(regs):,} regulations."
        r = G._one(con, "SELECT * FROM risks WHERE group_key=?", (key,))     # noqa: SLF001
        if not r:
            rid = I.new_id("RISK")
            con.execute("""INSERT INTO risks (id, group_key, title, theme, origin, lifecycle, description, created_by,
                             created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (rid, key, _title(rb, theme), None if theme == UNTHEMED else theme, "derived", "IDENTIFIED", desc,
                         actor, ts, ts))
            G.event(con, rid, "identified", actor, f"obligations: {desc}")
            created += 1
        else:
            rid = r["id"]
            con.execute("UPDATE risks SET description=?, title=?, updated_at=? WHERE id=?", (desc, _title(rb, theme), ts, rid))
            if r["retired_at"] and r["lifecycle"] == "RETIRED":
                con.execute("UPDATE risks SET retired_at=NULL, lifecycle='IDENTIFIED' WHERE id=?", (rid,))
                G.event(con, rid, "applies again", actor, "duties under this theme apply again")
            refreshed += 1
        _sync(con, rid, [data["exposures"][i] for i in ids], ts)
    for r in G._rows(con, "SELECT * FROM risks WHERE group_key LIKE 'obligation:%' AND retired_at IS NULL"):     # noqa: SLF001
        if r["group_key"] in seen or r["lifecycle"] in ("IN_TREATMENT", "ACCEPTED"):
            continue
        con.execute("UPDATE risks SET retired_at=?, lifecycle='RETIRED', updated_at=? WHERE id=?", (ts, ts, r["id"]))
        con.execute("UPDATE risk_exposures SET active=0 WHERE risk_id=?", (r["id"],))
        G.event(con, r["id"], "retired", actor, "no applicable duty is left under this theme")
        retired += 1
    con.commit()
    return {"obligation_risks_created": created, "obligation_risks_refreshed": refreshed,
            "obligation_risks_retired": retired, "duties": len(data["exposures"])}


def _sync(con, rid: str, exps: list[dict], ts: str) -> None:
    """Write only what changed: a register of thousands of duties must not rewrite every row on every run."""
    have = {x["exposure_key"]: x for x in G._rows(     # noqa: SLF001
        con, "SELECT id, exposure_key, label, engine_applicability, missing, active FROM risk_exposures WHERE risk_id=?",
        (rid,))}
    keep = set()
    for e in exps:
        keep.add(e["id"])
        m = e["meta"]
        miss = json.dumps(m["missing"])
        row = have.get(e["id"])
        if not row:
            con.execute("""INSERT INTO risk_exposures (id, risk_id, exposure_key, kind, label, node_ref, regulation_id,
                             requirement_id, engine_applicability, missing, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (I.new_id("EXP"), rid, e["id"], "obligation", e["label"], "org", m["regulation_id"],
                         m["requirement_id"], e["applicability"], miss, ts))
        elif (row["label"], row["engine_applicability"], row["missing"], row["active"]) != (e["label"], e["applicability"], miss, 1):
            con.execute("UPDATE risk_exposures SET label=?, engine_applicability=?, missing=?, active=1 WHERE id=?",
                        (e["label"], e["applicability"], miss, row["id"]))
    for k, row in have.items():
        if k not in keep and row["active"]:
            con.execute("UPDATE risk_exposures SET active=0 WHERE id=?", (row["id"],))


def exposure_for(data: dict, x: dict) -> dict | None:
    """The engine exposure for one stored row (a fresh copy, so a run can lay decisions and controls over it)."""
    e = data["exposures"].get(x["exposure_key"])
    if not e:
        return None
    out = dict(e)
    out["controls"] = list(e["controls"])
    return out


def unthemed_regulations(con, risk_id: str) -> list[dict]:
    """The regulations in the no-theme risk, with how many of their duties wait on a theme."""
    rows = G._rows(con, """SELECT regulation_id, COUNT(*) AS n FROM risk_exposures WHERE risk_id=? AND active=1
                           AND kind='obligation' GROUP BY regulation_id ORDER BY n DESC""", (risk_id,))     # noqa: SLF001
    titles = {r["id"]: r.get("title") for r in _try(con, "SELECT id, title FROM regulations")}
    return [{"regulation_id": r["regulation_id"], "title": titles.get(r["regulation_id"]) or r["regulation_id"],
             "duties": r["n"]} for r in rows]
