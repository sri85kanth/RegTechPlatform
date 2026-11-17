"""
The risk register (design §8, §14, migration 006): which risks the company
has, what the engine says about each, and what a person must look at.

  identify   library templates (lens 2) on the company's graph: the organisation,
             its sites, third parties, systems, processes, products and data
             assets. One risk per (template, site); its exposures are the nodes.
             A node type with nothing listed gets one "not listed yet" node, so
             a template is never dropped for want of a list (decision D1).
  assess     builds each risk's inputs from the records, runs the engine, and
             stores a new assessment only when the inputs or the outcome
             changed. Active overrides made against other inputs go STALE.
  route      opens the review tasks the assessment calls for (G3, G4, G5, G6,
             G9) and cancels the ones it no longer calls for.

Obligation risks (lens 1: requirement × site, grouped by theme) are assembled
in Phase 4 with the dependency index; the tables already take them.

Same connection contract as intake.py: DB-API, `?` placeholders, rows that
convert with dict(). Postgres in production, SQLite in the tests.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from . import engine as E
from . import intake as I
from . import library as L
from .rulebook import BANDS, Rulebook

BAND_RANK = {b: i for i, b in enumerate(BANDS)}

# the questions that decide whether a library template applies (G9 asks them)
ORG_QUESTIONS: tuple[tuple[str, str], ...] = (
    ("has_systems", "Does the organisation run IT systems or applications?"),
    ("develops_software", "Does it build or change software itself?"),
    ("has_vendors", "Does it rely on vendors or outsourced services?"),
    ("markets_to_customers", "Does it market or sell to customers?"),
    ("develops_products", "Does it design or develop products?"),
    ("physical_goods", "Does it make, store or move physical goods?"),
    ("runs_projects", "Does it run projects for clients or for itself?"),
    ("remote_work", "Do people work remotely?"),
    ("has_website", "Does it run a public website or app?"),
    ("imports_exports", "Does it import or export?"),
    ("listed", "Is it listed on a stock exchange?"),
    ("employees", "How many people does it employ?"),
)
ORG_KEYS = {k for k, _ in ORG_QUESTIONS}

# company_entities.type → library node type
ENTITY_NODE = {
    "system": "system", "application": "system", "it_system": "system", "software": "system",
    "process": "process", "business_process": "process",
    "product": "product", "service_line": "product",
    "data_asset": "data_asset", "dataset": "data_asset", "data": "data_asset",
}
NODE_LABEL = {"system": "Systems", "process": "Processes", "product": "Products", "data_asset": "Data assets",
              "third_party": "Third parties", "site": "Sites"}

DUE_DAYS = {"P0": 3, "P1": 7, "P2": 14}
ENGINE_GATES = ("G3", "G4", "G5", "G6", "G9")
OPEN_ACTION = ("Proposed", "Open", "In Progress", "Blocked")


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _j(v: Any, default: Any) -> Any:
    if v in (None, ""):
        return default
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return default


def _rows(con, sql: str, args: tuple = ()) -> list[dict]:
    return [dict(r) for r in con.execute(sql, args).fetchall()]


def _one(con, sql: str, args: tuple = ()) -> dict | None:
    r = con.execute(sql, args).fetchone()
    return dict(r) if r else None


def event(con, risk_id: str, kind: str, actor: str, detail: str = "") -> None:
    con.execute("INSERT INTO risk_events (id, risk_id, kind, actor, detail, at) VALUES (?,?,?,?,?,?)",
                (I.new_id("REV"), risk_id, kind, actor, detail, I.precise_now()))


# ------------------------------------------------------------------ the graph
def _profile(con) -> dict:
    try:
        return _one(con, "SELECT * FROM company_profile ORDER BY id LIMIT 1") or {}
    except Exception:  # noqa: BLE001 — a workspace without a profile table yet
        return {}


def _int(v: Any) -> int | None:
    m = re.search(r"\d[\d,]*", str(v or ""))
    return int(m.group(0).replace(",", "")) if m else None


def org_answers(con) -> dict:
    return {r["fact_key"]: {**r, "value": _j(r["value"], None)} for r in _rows(con, "SELECT * FROM risk_org_facts")}


def _entities(con) -> list[dict]:
    try:
        return _rows(con, "SELECT * FROM company_entities")
    except Exception:  # noqa: BLE001
        return []


def org_facts(con) -> dict:
    """What decides a template on the organisation. A person's answer wins; then the profile and the records."""
    p = _profile(con)
    facts: dict[str, Any] = {}
    emp = _int(p.get("employees"))
    if emp is not None:
        facts["employees"] = emp
    for k in ("listed", "imports_exports"):
        if p.get(k) is not None and k in p:
            facts[k] = bool(p[k])
    ents = _entities(con)
    if any(ENTITY_NODE.get(str(e.get("type") or "").lower()) == "system" for e in ents):
        facts["has_systems"] = True
    if I.list_records(con, "third_parties"):
        facts["has_vendors"] = True
    for k, a in org_answers(con).items():
        facts[k] = a["value"]
    return facts


def graph_nodes(con) -> dict[str, list[dict]]:
    """Nodes by library type, each {id, label, site_id, …facts}."""
    p = _profile(con)
    # The organisation and its sites are not graded for criticality: the template's own
    # seed decides their operational impact. Set explicitly, so the rule reads "no" and
    # not "unknown" (an unknown is priced at its worst value; design §15 input contract).
    out: dict[str, list[dict]] = {t: [] for t in L.NODE_TYPES}
    out["organisation"] = [{"id": "org", "label": p.get("legal_name") or "The organisation", "criticality": "n/a"}]
    for s in I.list_records(con, "sites"):
        out["site"].append({"id": s["id"], "label": s["name"], "site_id": s["id"], "criticality": "n/a",
                            "site_type": s.get("site_type")})
    for tp in I.list_records(con, "third_parties"):
        n = {"id": tp["id"], "label": tp["name"]}
        if tp.get("criticality"):
            n["criticality"] = tp["criticality"]
        if tp.get("personal_data") is not None:
            n["personal_data"] = bool(tp["personal_data"])
        out["third_party"].append(n)
    for e in _entities(con):
        kind = ENTITY_NODE.get(str(e.get("type") or "").lower())
        if not kind:
            continue
        attrs = _j(e.get("attrs"), {})
        n = {"id": e["id"], "label": e.get("name") or e["id"]}
        if e.get("criticality"):
            n["criticality"] = str(e["criticality"]).strip().capitalize()
        for k in ("hosting", "uses_ai", "personal_data", "residency_outside_india"):
            v = attrs.get(k) if isinstance(attrs, dict) else None
            if v not in (None, ""):
                n[k] = v.lower() if isinstance(v, str) and k == "hosting" else v
        out[kind].append(n)
    for kind in ("system", "process", "product", "data_asset", "third_party", "site"):
        if not out[kind]:
            out[kind] = [{"id": f"{kind}:unlisted", "label": f"{NODE_LABEL[kind]} — none listed yet",
                          "placeholder": True}]
    return out


# ------------------------------------------------------------------ identify (lens 2)
def identify(con, lib: L.Library, actor: str = "engine") -> dict:
    """Create or refresh one risk per (template, site) and its exposures. Idempotent."""
    org = org_facts(con)
    nodes = graph_nodes(con)
    ts = I.now()
    created = refreshed = retired = 0
    seen: set[str] = set()
    for t in lib.templates:
        groups: dict[str, list[dict]] = {}
        for node in nodes.get(t["node_type"], []):
            exp = L.exposure(t, node, org)
            if exp is None:
                continue
            site = node.get("site_id") if t["node_type"] == "site" else None
            exp["node_ref"], exp["site_id"], exp["node_label"] = node["id"], site, node.get("label")
            groups.setdefault(site or "org", []).append(exp)
        for site_key, exps in groups.items():
            key = f"template:{t['id']}@{site_key}"
            seen.add(key)
            title = t["title"].rstrip(".") if site_key == "org" else \
                f"{t['title'].rstrip('.')} — {exps[0]['node_label']}"
            r = _one(con, "SELECT * FROM risks WHERE group_key=?", (key,))
            if not r:
                rid = I.new_id("RISK")
                con.execute("""INSERT INTO risks (id, group_key, title, theme, site_id, template_id, origin, lifecycle,
                                 description, created_by, created_at, updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (rid, key, title, t["theme"], None if site_key == "org" else site_key, t["id"], "derived",
                             "IDENTIFIED", t.get("consequence"), actor, ts, ts))
                event(con, rid, "identified", actor, f"library template {t['id']} ({lib.ref['version']})")
                created += 1
            else:
                rid = r["id"]
                refreshed += 1
            _sync_exposures(con, rid, exps, ts)
            # retired by the engine, it comes back when a fact changes; dismissed by a person, it stays
            # dismissed unless a node nobody has decided on appears (a new vendor, a new system)
            if r and r["retired_at"] and r["origin"] == "derived" and _one(
                    con, "SELECT 1 FROM risk_exposures WHERE risk_id=? AND active=1 AND "
                         "(decided_applicability IS NULL OR decided_applicability <> 'NOT_APPLICABLE')", (rid,)):
                con.execute("UPDATE risks SET retired_at=NULL, lifecycle='IDENTIFIED', updated_at=? WHERE id=?", (ts, rid))
                event(con, rid, "applies again", actor, "a fact changed, so the template applies again")
    # derived risks whose template no longer applies anywhere
    for r in _rows(con, "SELECT * FROM risks WHERE origin='derived' AND retired_at IS NULL"):
        if r["group_key"].startswith("template:") and r["group_key"] not in seen:
            if r["lifecycle"] in ("IN_TREATMENT", "ACCEPTED"):
                continue                     # a person's decision stands until they close it
            con.execute("UPDATE risks SET retired_at=?, lifecycle='RETIRED', updated_at=? WHERE id=?", (ts, ts, r["id"]))
            con.execute("UPDATE risk_exposures SET active=0 WHERE risk_id=?", (r["id"],))
            event(con, r["id"], "retired", actor, "the template no longer applies: an answer or a record changed")
            retired += 1
    con.commit()
    return {"created": created, "refreshed": refreshed, "retired": retired}


def _sync_exposures(con, rid: str, exps: list[dict], ts: str) -> None:
    keep = set()
    for e in exps:
        keep.add(e["id"])
        row = _one(con, "SELECT id FROM risk_exposures WHERE risk_id=? AND exposure_key=?", (rid, e["id"]))
        miss = json.dumps(e.get("applicability_missing") or [])
        if row:
            con.execute("""UPDATE risk_exposures SET label=?, engine_applicability=?, missing=?, active=1,
                             node_ref=?, site_id=? WHERE id=?""",
                        (e["label"], e["applicability"], miss, e["node_ref"], e["site_id"], row["id"]))
        else:
            con.execute("""INSERT INTO risk_exposures (id, risk_id, exposure_key, kind, label, node_ref, site_id,
                             engine_applicability, missing, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        (I.new_id("EXP"), rid, e["id"], e["kind"], e["label"], e["node_ref"], e["site_id"],
                         e["applicability"], miss, ts))
    for row in _rows(con, "SELECT id, exposure_key FROM risk_exposures WHERE risk_id=? AND active=1", (rid,)):
        if row["exposure_key"] not in keep:
            con.execute("UPDATE risk_exposures SET active=0 WHERE id=?", (row["id"],))


# ------------------------------------------------------------------ inputs
def _history(con, theme: str | None, site_id: str | None, as_of: date) -> dict:
    cov = I.history_coverage(con, as_of)
    if any(v["status"] is None for v in cov.values()):
        return {}                                   # mandatory: unknown, never assumed clean
    status = "records" if any(v["status"] == "records" for v in cov.values()) else "attested"
    d24 = I._months_ago(as_of, 24).isoformat()      # noqa: SLF001 — same window arithmetic as coverage
    d36 = I._months_ago(as_of, 36).isoformat()      # noqa: SLF001
    recs = [r for r in I.list_records(con, "history") if r["status"] == "CONFIRMED"
            and (theme and r.get("theme") == theme) and (not site_id or r.get("site_id") in (None, site_id))]
    obs24 = [r for r in recs if r["kind"] == "OBSERVATION" and r["occurred_on"] >= d24]
    return {
        "status": status,
        "open_observations_theme_24m": sum(1 for r in obs24 if r["state"] == "OPEN"),
        "serious_36m": sum(1 for r in recs if r["kind"] in ("WARNING_LETTER", "PENALTY") and r["occurred_on"] >= d36),
        "overdue_capa_theme": sum(1 for r in recs if r["kind"] == "CAPA" and r["state"] == "OPEN"
                                  and r.get("due_on") and r["due_on"] < as_of.isoformat()),
        "clean_inspection_theme_24m": any(r["kind"] == "INSPECTION" and r.get("outcome") == "clean"
                                          and r["occurred_on"] >= d24 for r in recs) and not obs24,
    }


def _exposure_facts(con, rb: Rulebook, site_id: str | None) -> dict:
    sites = I.list_records(con, "sites")
    if site_id:
        sites = [s for s in sites if s["id"] == site_id]
    out: dict[str, Any] = {}
    if sites:
        out["sites"] = len(sites)
        if not (rb.data.get("scale_index") or {}):
            out["scale_index"] = "low"              # the pack sets no size thresholds: size adds nothing
        else:
            levels = [rb.scale_index(s.get("scale")) for s in sites]
            if all(levels):
                out["scale_index"] = max(levels, key=["low", "medium", "high"].index)
    return out


def _engine_control(r: dict) -> dict:
    c = {"id": r["control_key"], "label": r["label"], "kind": r["kind"]}
    if r.get("interval_days"):
        c["expected_interval_days"] = r["interval_days"]
    g = r["grade"]
    if g == "ABSENT":
        c["confirmed_absent"] = True
    elif g == "CLAIMED":
        c.update(self_declared=True, approved_document=False, test_evidence=False)
    elif g == "DOCUMENTED":
        c.update(approved_document=True, test_evidence=False, document_reviewed_on=r.get("evidence_on"))
    else:
        c.update(approved_document=True, test_evidence=True, newest_evidence_on=r.get("evidence_on"))
    return c


def current_ratings(con, risk_id: str) -> list[dict]:
    return _rows(con, "SELECT * FROM risk_control_ratings WHERE risk_id=? AND superseded_at IS NULL ORDER BY recorded_at",
                 (risk_id,))


def active_treatment(con, risk_id: str) -> dict | None:
    t = _one(con, "SELECT * FROM treatment_decisions WHERE risk_id=? AND status='ACTIVE' ORDER BY created_at DESC",
             (risk_id,))
    if t:
        t["action_ids"] = _j(t.get("action_ids"), [])
    return t


def _planned(con, risk_id: str) -> list[dict]:
    t = active_treatment(con, risk_id)
    if not t or t["decision"] != "MITIGATE":
        return []
    out = []
    for a in t["action_ids"]:
        row = _one(con, "SELECT status FROM actions WHERE id=?", (a["id"],))
        if row and row["status"] in OPEN_ACTION:
            out.append({"id": f"A-{a['id']}", "kind": a.get("kind") or "preventive"})
    return out


def context(con) -> dict:
    """What every risk in one run shares: read once, not once per risk."""
    return {"org": org_facts(con), "nodes": {n["id"]: n for ns in graph_nodes(con).values() for n in ns}}


def _custom_exposure(risk: dict, x: dict, org_node: dict) -> dict:
    basis = _j(risk.get("impact_basis"), {})
    return {"id": x["exposure_key"], "kind": "template", "label": x["label"] or risk["title"], "theme": risk.get("theme"),
            "facts": {"template": {"id": "custom", "seeds": basis.get("seeds") or {}, "seed_status": "reviewed",
                                   "base_likelihood": basis.get("base_likelihood")},
                      "node": {k: v for k, v in org_node.items() if k not in ("id", "label")}}}


def risk_input(con, rb: Rulebook, lib: L.Library, risk: dict, as_of: date, ctx: dict | None = None) -> dict:
    """The snapshot an assessment stores: everything the engine reads, nothing else."""
    ctx = ctx or context(con)
    template = lib.get(risk["template_id"]) if risk.get("template_id") else None
    controls = [_engine_control(r) for r in current_ratings(con, risk["id"])]
    planned = _planned(con, risk["id"])
    exps = []
    for x in _rows(con, "SELECT * FROM risk_exposures WHERE risk_id=? AND active=1 ORDER BY exposure_key", (risk["id"],)):
        if x["kind"] == "obligation":
            if "obl" not in ctx:
                from . import obligations as O     # lens 1 reads the library once per run
                ctx["obl"] = O.load(con, rb, as_of)
            from . import obligations as O
            e = O.exposure_for(ctx["obl"], x)
            own = e["controls"] if e else []
        else:
            node = ctx["nodes"].get(x["node_ref"]) or {"id": x["node_ref"], "label": x["label"]}
            e = L.exposure(template, node, ctx["org"]) if template else _custom_exposure(risk, x, ctx["nodes"]["org"])
            own = []
        if e is None:      # it stopped applying since identify ran (the template, or the duty's verdict)
            e = {"id": x["exposure_key"], "kind": x["kind"], "label": x["label"], "theme": risk.get("theme"),
                 "applicability": "NOT_APPLICABLE", "facts": {}}
        e["id"] = x["exposure_key"]
        e["applicability"] = x["decided_applicability"] or e.get("applicability") or "REVIEW_REQUIRED"
        e.pop("applicability_missing", None)
        e["controls"], e["planned"] = own + controls, planned
        exps.append(e)
    profile = _profile(con)
    shared: dict[str, Any] = {"exposure": _exposure_facts(con, rb, risk.get("site_id"))}
    hist = _history(con, risk.get("theme"), risk.get("site_id"), as_of)
    if hist:
        shared["history"] = hist
    turnover = _int(profile.get("turnover_cr"))
    if turnover is not None:
        shared["profile"] = {"turnover_inr": turnover * 10_000_000}
    return {"risk": {"id": risk["id"], "title": risk["title"], "theme": risk.get("theme"), "site": risk.get("site_id")},
            "shared": shared, "exposures": exps, "unconfirmed_facts": []}


# ------------------------------------------------------------------ assess
def _key(inp: dict, appetite: dict | None, rb: Rulebook) -> str:
    return "sha256:" + hashlib.sha256(json.dumps({"input": inp, "appetite": appetite, "rulebook": rb.ref["hash"]},
                                                 sort_keys=True, default=str).encode()).hexdigest()


def _band(p: dict | None) -> str | None:
    return p["band"] if p else None


def _outcome(res: dict) -> dict:
    return {"verdict": res["verdict"], "inherent": _band(res.get("inherent")), "residual": _band(res.get("residual")),
            "target": _band(res.get("target")), "confidence": res["confidence"]["score"]}


TRIM_EXPOSURES = 25


def _trim(res: dict) -> dict:
    """An obligation risk can hold thousands of duties: keep the driver and the worst 25 in the stored result.

    The inputs snapshot keeps every exposure, so the full derivation can still be replayed.
    """
    exps = res.get("exposures") or []
    if len(exps) <= TRIM_EXPOSURES:
        return res
    ranked = sorted(exps, key=lambda e: (E._rank(e.get("residual")), E._rank(e.get("inherent"))), reverse=True)     # noqa: SLF001
    keep = ranked[:TRIM_EXPOSURES]
    if res.get("driver") and all(e["id"] != res["driver"] for e in keep):
        keep.append(next(e for e in exps if e["id"] == res["driver"]))
    return {**res, "exposures": keep, "exposures_total": len(exps)}


def current_assessment(con, risk_id: str) -> dict | None:
    a = _one(con, "SELECT * FROM risk_assessments WHERE risk_id=? AND superseded_at IS NULL", (risk_id,))
    if a:
        a["result"] = _j(a["result"], {})
        a["diff"] = _j(a.get("diff"), None)
    return a


def assess_risk(con, rb: Rulebook, lib: L.Library, risk_id: str, *, appetite: dict | None = None,
                as_of: date | None = None, trigger: str = "run", actor: str = "engine", ctx: dict | None = None) -> dict:
    """Assess one risk. Returns {"changed": bool, "assessment": row}."""
    as_of = as_of or _today()
    risk = _one(con, "SELECT * FROM risks WHERE id=?", (risk_id,))
    if not risk:
        raise KeyError(risk_id)
    inp = risk_input(con, rb, lib, risk, as_of, ctx)
    key = _key(inp, appetite, rb)
    res = E.assess(rb, inp, appetite, as_of)
    cur = current_assessment(con, risk_id)
    if cur and cur["inputs_hash"] == key and _outcome(cur["result"]) == _outcome(res):
        return {"changed": False, "assessment": cur}
    res = _trim(res)
    ts = I.precise_now()
    seq = (cur["seq"] + 1) if cur else 1
    diff = None
    if cur:
        before, after = _outcome(cur["result"]), _outcome(res)
        diff = {k: [before[k], after[k]] for k in after if before.get(k) != after[k]}
        con.execute("UPDATE risk_assessments SET superseded_at=? WHERE id=?", (ts, cur["id"]))
    aid = I.new_id("RA")
    con.execute("""INSERT INTO risk_assessments (id, risk_id, seq, rulebook, rulebook_hash, inputs_hash, as_of, verdict,
                     inherent_band, residual_band, target_band, confidence, provisional, result, inputs, diff, trigger,
                     recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (aid, risk_id, seq, rb.ref["name"], rb.ref["hash"], key, res["as_of"], res["verdict"],
                 _band(res.get("inherent")), _band(res.get("residual")), _band(res.get("target")),
                 res["confidence"]["score"], int(bool(res.get("provisional"))), json.dumps(res, default=str),
                 json.dumps(inp, default=str), json.dumps(diff) if diff else None, trigger, ts))
    if risk["lifecycle"] == "IDENTIFIED":
        con.execute("UPDATE risks SET lifecycle='ASSESSED', updated_at=? WHERE id=?", (I.now(), risk_id))
    event(con, risk_id, "assessed", actor,
          f"v{seq}: {res['verdict']}" + (f" ({', '.join(f'{k} {a} → {b}' for k, (a, b) in diff.items())})" if diff else ""))
    # an override answers the inputs it was made against; new inputs make it stale
    for o in _rows(con, "SELECT * FROM risk_overrides WHERE risk_id=? AND status IN ('ACTIVE','PENDING')", (risk_id,)):
        if o["inputs_hash"] != key:
            con.execute("UPDATE risk_overrides SET status='STALE', decided_at=? WHERE id=?", (I.now(), o["id"]))
            event(con, risk_id, "override stale", actor, f"{o['field']} {o['override_value']}: the inputs changed")
            open_task(con, gate="G5", reason_code="OVERRIDE_STALE", subject_kind="override", subject_id=o["id"],
                      risk_id=risk_id, priority="P1", role="compliance_manager",
                      detail={"field": o["field"], "value": o["override_value"]},
                      reason=f"An override of {o['field'].replace('_', ' ')} to {o['override_value']} no longer matches "
                             f"the inputs. Look again: renew it or let the computed value stand.")
            close_tasks(con, gate="G7", subject_id=o["id"], status="CANCELLED", note="the override went stale")
    return {"changed": True, "assessment": current_assessment(con, risk_id)}


def expire_acceptances(con, as_of: date, actor: str = "engine") -> int:
    n = 0
    for t in _rows(con, "SELECT * FROM treatment_decisions WHERE status='ACTIVE' AND decision='ACCEPT' "
                        "AND accept_until IS NOT NULL AND accept_until < ?", (as_of.isoformat(),)):
        con.execute("UPDATE treatment_decisions SET status='EXPIRED' WHERE id=?", (t["id"],))
        con.execute("UPDATE risks SET lifecycle='ASSESSED', updated_at=? WHERE id=? AND lifecycle='ACCEPTED'",
                    (I.now(), t["risk_id"]))
        event(con, t["risk_id"], "acceptance expired", actor, f"accepted until {t['accept_until']}")
        n += 1
    return n


def run(con, rb: Rulebook, lib: L.Library, *, actor: str = "engine", as_of: date | None = None,
        trigger: str = "run", risk_ids: list[str] | None = None) -> dict:
    """Identify, assess and route. Only risks whose inputs or outcome changed get a new version."""
    from . import obligations as O
    as_of = as_of or _today()
    obl = O.load(con, rb, as_of) if risk_ids is None else None     # a decision's re-run loads it only if it needs it
    ident = {**identify(con, lib, actor), **O.identify(con, rb, actor, as_of, data=obl)} if risk_ids is None else {}
    expired = expire_acceptances(con, as_of, actor)
    appetite = I.appetite_for_engine(con)
    ids = risk_ids or [r["id"] for r in _rows(con, "SELECT id FROM risks WHERE retired_at IS NULL ORDER BY id")]
    ctx = context(con)
    if obl is not None:
        ctx["obl"] = obl
    changed = 0
    for rid in ids:
        out = assess_risk(con, rb, lib, rid, appetite=appetite, as_of=as_of, trigger=trigger, actor=actor, ctx=ctx)
        changed += out["changed"]
        route(con, rid)
    _retired_tasks(con)
    con.commit()
    return {**ident, "assessed": len(ids), "changed": changed, "acceptances_expired": expired}


# ------------------------------------------------------------------ effective values
VERDICT_RANK = {"WITHIN_APPETITE": 0, "REVIEW_REQUIRED": 1, "INSUFFICIENT_EVIDENCE": 1, "TREAT": 2, "ESCALATE": 3}


def active_overrides(con, risk_id: str) -> list[dict]:
    return _rows(con, "SELECT * FROM risk_overrides WHERE risk_id=? AND status='ACTIVE' ORDER BY created_at", (risk_id,))


def effective(con, risk_id: str, a: dict | None = None) -> dict:
    """The values people act on: computed, with any active override laid over it (and the computed kept)."""
    a = a or current_assessment(con, risk_id)
    if not a:
        return {"verdict": None, "residual_band": None, "overridden": []}
    out = {"verdict": a["verdict"], "residual_band": a["residual_band"],
           "floor_verdict": a["result"].get("floor_verdict"), "overridden": []}
    for o in active_overrides(con, risk_id):
        out[o["field"]] = o["override_value"]
        out["overridden"].append(o["field"])
    return out


# ------------------------------------------------------------------ the queue
def _due(priority: str) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=DUE_DAYS[priority])).isoformat(timespec="seconds")


def open_task(con, *, gate: str, reason_code: str, reason: str, subject_kind: str, subject_id: str,
              risk_id: str | None = None, priority: str = "P2", role: str | None = None, user: str | None = None,
              created_by: str = "engine", once: bool = False, detail: dict | None = None) -> dict | None:
    """Open a review task unless the same one is already open (or, with once, was ever decided).

    `once` is for subjects that are versions already (an assessment): acknowledging v3 is final for v3.
    Notifies whoever the task is routed to.
    """
    if once and _one(con, "SELECT 1 FROM review_tasks WHERE gate=? AND reason_code=? AND subject_kind=? "
                          "AND subject_id=? AND status='DONE'", (gate, reason_code, subject_kind, subject_id)):
        return None
    cur = _one(con, "SELECT * FROM review_tasks WHERE gate=? AND reason_code=? AND subject_kind=? AND subject_id=? "
                    "AND status='OPEN'", (gate, reason_code, subject_kind, subject_id))
    if cur:
        d = json.dumps(detail) if detail is not None else None
        if cur["reason"] != reason or cur["assignee_user"] != user or cur["assignee_role"] != role or cur["detail"] != d:
            con.execute("UPDATE review_tasks SET reason=?, detail=?, assignee_user=?, assignee_role=? WHERE id=?",
                        (reason, d, user, role, cur["id"]))
        return cur
    tid = I.new_id("RT")
    con.execute("""INSERT INTO review_tasks (id, gate, reason_code, reason, detail, risk_id, subject_kind, subject_id,
                     assignee_user, assignee_role, priority, due_at, created_by, created_at, dedupe_key)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (tid, gate, reason_code, reason, json.dumps(detail) if detail is not None else None, risk_id,
                 subject_kind, subject_id, user, role, priority,
                 _due(priority), created_by, I.now(), f"{gate}:{reason_code}:{subject_kind}:{subject_id}:{tid}"))
    if risk_id:
        event(con, risk_id, f"review opened ({gate})", created_by, reason)
    _notify(con, tid, gate, reason, priority, user, role)
    return _one(con, "SELECT * FROM review_tasks WHERE id=?", (tid,))


GATE_TITLE = {"G3": "Applicability to decide", "G4": "A claimed control to check", "G5": "A risk needs attention",
              "G6": "A treatment decision is due", "G7": "An override needs a second approver",
              "G8": "A rulebook version to publish", "G9": "A possible risk to triage"}


def _notify(con, tid: str, gate: str, reason: str, priority: str, user: str | None, role: str | None) -> None:
    try:
        from .. import notifications as N
    except Exception:  # noqa: BLE001 — the store also runs where the app package is not importable
        return
    targets: list[dict] = []
    if user:
        targets.append({"user_id": user})
    elif role == "governor":
        targets += [{"user_id": g["user_id"]} for g in I.governors(con)] + [{"role": "admin"}]
    else:
        targets.append({"role": role if role in N.RANK else "compliance_manager"})
    for t in targets:
        try:
            N.push(con, kind="awaiting_review", title=GATE_TITLE.get(gate, "Risk review"), body=reason,
                   severity="critical" if priority == "P0" else "warning" if priority == "P1" else "info",
                   link=f"/risk-review?task={tid}",
                   dedupe_key=f"risk-task:{tid}:{t.get('user_id') or t.get('role')}", **t)
        except Exception:  # noqa: BLE001 — a missed notification must not stop the review being opened
            pass


def close_tasks(con, *, gate: str | None = None, subject_id: str | None = None, risk_id: str | None = None,
                status: str = "DONE", decision: str | None = None, note: str | None = None,
                actor: str = "engine", only: set[tuple] | None = None) -> int:
    where, args = ["status='OPEN'"], []
    for col, v in (("gate", gate), ("subject_id", subject_id), ("risk_id", risk_id)):
        if v:
            where.append(f"{col}=?")
            args.append(v)
    n = 0
    for t in _rows(con, f"SELECT * FROM review_tasks WHERE {' AND '.join(where)}", tuple(args)):
        if only is not None and (t["gate"], t["reason_code"], t["subject_id"]) not in only:
            continue
        con.execute("UPDATE review_tasks SET status=?, decision=?, note=?, decided_by=?, decided_at=? WHERE id=?",
                    (status, decision, note, actor, I.now(), t["id"]))
        n += 1
    return n


def route(con, risk_id: str) -> None:
    """Open what this risk's current assessment calls for; cancel engine tasks it no longer calls for."""
    risk = _one(con, "SELECT * FROM risks WHERE id=?", (risk_id,))
    a = current_assessment(con, risk_id)
    want: list[dict] = []
    if risk and not risk["retired_at"] and a:
        res, eff = a["result"], effective(con, risk_id, a)
        exps = _rows(con, "SELECT * FROM risk_exposures WHERE risk_id=? AND active=1", (risk_id,))
        pending = [x for x in exps if not x["decided_applicability"] and x["engine_applicability"] == "REVIEW_REQUIRED"]
        if str(risk["group_key"]).startswith("obligation:"):
            # A duty's own applicability is decided on the Requirements page, not here. What the register
            # needs from a person is the theme of a regulation the rulebook cannot place (G3).
            if risk["group_key"] == "obligation:UNTHEMED@org":
                from . import obligations as O
                for reg in O.unthemed_regulations(con, risk_id):
                    want.append(dict(gate="G3", reason_code="THEME_NEEDED", subject_kind="regulation",
                                     subject_id=reg["regulation_id"], priority="P2", role="compliance_manager",
                                     detail={"regulation": reg["title"], "duties": reg["duties"]},
                                     reason=f"Which theme does {reg['title']} belong to? {reg['duties']} applicable "
                                            f"duties wait on it before they can be scored."))
        elif res.get("verdict_rule") == "EV-01" and pending and len(pending) == len(
                [x for x in exps if x["decided_applicability"] != "NOT_APPLICABLE"]):
            facts = sorted({f for x in pending for f in _j(x["missing"], [])})
            want.append(dict(gate="G9", reason_code="CANDIDATE", subject_kind="risk", subject_id=risk_id,
                             priority="P2", role="compliance_manager", detail={"facts": facts},
                             reason="Might apply: " + (f"unknown {', '.join(facts)}" if facts else "nothing decides it yet")
                                    + ". Accept it, merge it into another risk, or dismiss it with a reason."))
        else:
            for x in pending:
                want.append(dict(gate="G3", reason_code="APPLICABILITY", subject_kind="exposure", subject_id=x["id"],
                                 priority="P2", role="compliance_manager",
                                 detail={"label": x["label"], "facts": _j(x["missing"], [])},
                                 reason=f"Does it apply to {x['label']}? Unknown: "
                                        f"{', '.join(_j(x['missing'], [])) or 'nothing decides it'}."))
        if eff["residual_band"] in ("HIGH", "CRITICAL"):
            for r in current_ratings(con, risk_id):
                if r["grade"] == "CLAIMED":
                    want.append(dict(gate="G4", reason_code="CLAIMED_ON_HIGH", subject_kind="control", subject_id=r["id"],
                                     priority="P1", role="compliance_manager",
                                     detail={"label": r["label"], "band": eff["residual_band"]},
                                     reason=f"“{r['label']}” is only self-declared on a {eff['residual_band']} risk. "
                                            f"Validate it with evidence or record it as absent."))
        routing, codes = [], []
        # a provisional residual is a worst case, not a finding: INSUFFICIENT_EVIDENCE already says so
        if a["residual_band"] == "CRITICAL" and not a["provisional"]:
            routing.append("residual CRITICAL")
            codes.append("residual_critical")
        if a["verdict"] == "ESCALATE":
            routing.append("above tolerance")
            codes.append("above_tolerance")
        if res.get("verdict_rule") == "EV-06":
            routing.append(f"confidence {a['confidence']} below the threshold")
            codes.append("low_confidence")
        if routing:
            esc = a["verdict"] == "ESCALATE"
            want.append(dict(gate="G5", reason_code="ROUTED", subject_kind="assessment", subject_id=a["id"], once=True,
                             detail={"seq": a["seq"], "conditions": codes, "confidence": a["confidence"]},
                             priority="P0" if esc or "residual CRITICAL" in routing else "P2",
                             role="governor" if esc else "compliance_manager",
                             reason=f"Assessment v{a['seq']}: {', '.join(routing)}. Acknowledge, or open the review it needs."))
        needs = {eff["verdict"], eff.get("floor_verdict")} & {"TREAT", "ESCALATE"}
        if needs and not active_treatment(con, risk_id) and risk["lifecycle"] not in ("CLOSED", "RETIRED"):
            last = _one(con, "SELECT status FROM treatment_decisions WHERE risk_id=? ORDER BY created_at DESC", (risk_id,))
            expired = bool(last and last["status"] == "EXPIRED")
            esc = "ESCALATE" in needs
            want.append(dict(gate="G6", reason_code="ACCEPTANCE_EXPIRED" if expired else "TREATMENT_NEEDED",
                             subject_kind="risk", subject_id=risk_id, priority="P0" if esc else "P1",
                             user=risk["owner_user"], role=None if risk["owner_user"] else "compliance_manager",
                             detail={"verdict": eff["verdict"], "owner": bool(risk["owner_user"])},
                             reason=("The acceptance has expired. " if expired else "")
                                    + f"Verdict {eff['verdict']}: decide how to treat it — accept, avoid, mitigate, "
                                      f"transfer or escalate." + ("" if risk["owner_user"] else " It has no owner yet.")))
    keep = {(w["gate"], w["reason_code"], w["subject_id"]) for w in want}
    for t in _rows(con, "SELECT * FROM review_tasks WHERE risk_id=? AND status='OPEN' AND created_by='engine'", (risk_id,)):
        if t["gate"] in ENGINE_GATES and t["reason_code"] != "OVERRIDE_STALE" and \
                (t["gate"], t["reason_code"], t["subject_id"]) not in keep:
            close_tasks(con, subject_id=t["subject_id"], gate=t["gate"], status="CANCELLED",
                        note=f"no longer needed after assessment v{a['seq'] if a else '?'}",
                        only={(t["gate"], t["reason_code"], t["subject_id"])})
    for w in want:
        open_task(con, risk_id=risk_id, **w)


def _retired_tasks(con) -> None:
    for t in _rows(con, "SELECT t.id FROM review_tasks t JOIN risks r ON r.id = t.risk_id "
                        "WHERE t.status='OPEN' AND r.retired_at IS NOT NULL"):
        con.execute("UPDATE review_tasks SET status='CANCELLED', note='the risk was retired', decided_at=? WHERE id=?",
                    (I.now(), t["id"]))
