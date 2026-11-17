"""
Residual-risk impact scoring (v2) — an evolution of impact.py:score().

WHY A V2
--------
impact.py:score() answers "how much of the company does this regulation touch"
— a transparent *gross exposure* metric. It is deliberately kept as-is. This
module adds the three things that turn exposure into a defensible *risk* number,
using only data already in the schema:

  1. SEVERITY × LIKELIHOOD, not just count. Exposure is scaled by how bad the
     regulation is (severity, proxied from regulations.impact_level until a
     penalty magnitude is extracted) and how likely it is to bite (likelihood,
     a config default here; Stage B replaces it with an estimate).

  2. MITIGATION NETTING. The company already models controls and evidence, wired
     to risks/processes with `mitigates` / `protects` / `proves` edges. Gross
     exposure is netted down by how much of the *reached* risk surface is
     already covered — residual = inherent × (1 − k · coverage). Controls reduce
     residual risk; they never zero it (a control does not repeal a duty), so
     the reduction is capped.

  3. DEADLINE PROXIMITY. A duty in force next month is more pressing than one in
     three years. effective_from shifts urgency up as the date nears, and past-
     due dates are treated as the most pressing of all.

Every score ships with a CONFIDENCE in [0,1] derived from how complete the
profile driving it is (sectors, licences, criticality coverage, edge density,
verdict certainty). The confidence never changes the score — a thin profile can
still produce a high number — it tells the reader how much to trust it, so a 72
on two entities is not read like a 72 on a wired-up graph.

NOTHING IS HARDCODED IN THE BODY. Every constant lives in PARAMS so it can be
calibrated (Stage C) against real outcomes without touching the logic. Every
score returns its full factor breakdown, mirroring impact.py.
"""
from __future__ import annotations

import json
from datetime import date, datetime

from . import impact as _v1   # reuse WEIGHTS, CRIT_SCALE, criticality(), _REACHES

# --------------------------------------------------------------------------- #
# Tunable model. Calibrate these; do not edit the functions below.            #
# --------------------------------------------------------------------------- #
PARAMS: dict = {
    # Gross exposure — inherited from v1 so the two scores stay comparable.
    "domain_weight": dict(_v1.WEIGHTS),
    "domain_count_cap": 5,
    "crit_bonus": dict(_v1.CRIT_BONUS),
    "obligation_weight": 2,
    "obligation_cap": 15,
    "reach_multiplier": 1.15,

    # Severity: how damaging non-compliance is, on 0..1, per level. Taken from the
    # regulation's real penalties when extracted, else from the worst risk the gap
    # assessment gave its requirements, else the neutral default below.
    #
    # NEVER from regulations.impact_level: store() writes this score's own level
    # there, so reading it back made severity a copy of the last result — a
    # regulation once scored Critical stayed Critical whatever its duties were
    # (Food Recall Procedure: 90/Critical while its assessed risks were Medium).
    "severity": {"Critical": 1.0, "High": 0.8, "Medium": 0.55, "Low": 0.3},
    "severity_default": 0.5,          # nothing known yet → mid, not zero

    # Stage B: severity from the REAL statutory penalty (penalty_provisions),
    # preferred over the impact_level proxy when penalty data exists. The worst
    # provision on the regulation wins. Amounts are rupees.
    "penalty_severity": {
        "suspension": 1.0,            # cancel/suspend the registration — existential
        "imprisonment_ge_months": [(36, 1.0), (12, 0.92), (0, 0.82)],
        "per_day": 0.85,             # accrues daily until fixed
        "multiplier": 0.85,          # a multiple of the sum involved
        "fine_ge_rupees": [(10_000_000, 0.95), (1_000_000, 0.8),
                            (100_000, 0.62), (0, 0.45)],
        "unquantified": 0.5,         # a penalty exists but the text gives no number
    },

    # Likelihood of enforcement/bite. A single default here; Stage B replaces it
    # per-regulation (enforcement history, regulator, penalty teeth). 0..1.
    "likelihood_default": 0.8,

    # Mitigation: the most of the residual that existing controls+evidence can
    # net off. < 1.0 on purpose — a control lowers risk, it does not repeal law.
    "max_mitigation_reduction": 0.6,
    # Edge verbs that count as a control/evidence covering a risk surface.
    "mitigation_verbs": {"mitigates", "protects", "proves", "implements", "governed_by"},
    # Domains that constitute the "risk surface" being covered.
    "risk_surface_domains": {"risks", "processes", "systems", "data"},
    # Domains that constitute a "cover" when linked to a risk-surface entity.
    "cover_domains": {"controls", "evidence", "policies"},

    # Deadline proximity → urgency multiplier. (days_until_effective, multiplier),
    # first matching band wins; overdue handled separately.
    "deadline_bands": [(30, 1.30), (90, 1.18), (180, 1.10), (365, 1.04)],
    "deadline_far_multiplier": 1.0,   # > longest band
    "overdue_multiplier": 1.30,       # effective date already passed
    "no_date_multiplier": 1.0,        # unknown date → no urgency change

    # Level bands on the residual 0..100 score.
    "bands": {"Critical": 80, "High": 55, "Medium": 30},

    # Confidence weighting — signals that make a score trustworthy. Summed then
    # normalised to 0..1.
    "confidence_weights": {
        "has_sectors": 0.15,
        "has_licences": 0.15,
        "verdict_certain": 0.20,      # APPLICABLE / NOT_APPLICABLE, not REVIEW/CONDITIONAL
        "criticality_coverage": 0.25, # fraction of reached entities with a known criticality
        "edge_density": 0.15,         # reached entities that carry at least one edge
        "profile_verified": 0.10,     # a human confirmed the profile
    },
}

_REACHES = _v1._REACHES


# --------------------------------------------------------------------------- #
# Factor helpers — each returns a number AND the inputs it used, so the score  #
# can be defended clause by clause the way impact.py:score() is.              #
# --------------------------------------------------------------------------- #
def _parse_date(raw) -> date | None:
    txt = str(raw or "").strip()
    if not txt:
        return None
    try:
        return datetime.fromisoformat(txt[:10]).date()
    except ValueError:
        pass
    for fmt in ("%d %B %Y", "%d %b %Y", "%B %d, %Y", "%d/%m/%Y", "%d-%m-%Y", "%Y"):
        try:
            return datetime.strptime(txt.strip(), fmt).date()
        except ValueError:
            continue
    return None


def gross_exposure(reached: list[dict], obligations: list[dict], brain_by_id: dict) -> dict:
    """
    The v1 exposure sum, factored out so v2 builds on the same base and the two
    numbers remain comparable. `reached` items carry company_brain_entity_id.
    """
    p = PARAMS
    ents = {r["company_brain_entity_id"]: r for r in reached}
    by_domain: dict[str, int] = {}
    max_crit = "Low"
    for eid in ents:
        e = brain_by_id.get(eid, {})
        d = e.get("domain", "other")
        key = "departments" if (d == "people" and e.get("type") == "Department") else d
        by_domain[key] = by_domain.get(key, 0) + 1
        c, _known = _v1.criticality(e.get("criticality"))
        if _v1.CRIT_SCALE.index(c) > _v1.CRIT_SCALE.index(max_crit):
            max_crit = c
    s = 0
    for dom, n in by_domain.items():
        s += p["domain_weight"].get(dom, 2) * min(n, p["domain_count_cap"])
    s += min(len(obligations), p["obligation_cap"]) * p["obligation_weight"]
    s += p["crit_bonus"][max_crit]
    return {"exposure": s, "by_domain": by_domain, "max_criticality": max_crit}


def severity_factor(impact_level: str | None) -> float:
    return PARAMS["severity"].get((impact_level or "").title(), PARAMS["severity_default"])


def severity_from_assessment(risks: list[str]) -> tuple[float | None, str]:
    """
    Severity 0..1 from the risk the gap assessment gave each of the regulation's
    requirements (Critical/High/Medium/Low) — the worst one wins, as with
    penalties. (None, "") when nothing was assessed, so the caller falls back.
    """
    levels = [str(r or "").title() for r in risks]
    known = [lv for lv in levels if lv in PARAMS["severity"]]
    if not known:
        return None, ""
    worst = max(known, key=lambda lv: PARAMS["severity"][lv])
    n = sum(1 for lv in known if lv == worst)
    return PARAMS["severity"][worst], f"worst assessed requirement risk: {worst} ({n} of {len(known)})"


def severity_from_penalties(provisions: list[dict]) -> tuple[float | None, str]:
    """
    Severity 0..1 from the REAL statutory penalties on a regulation — the worst
    provision wins. Returns (None, "") when there are no provisions, so the
    caller falls back to the impact_level proxy. Grounded in penalty_provisions;
    every factor traces to a stored row.
    """
    if not provisions:
        return None, ""
    p = PARAMS["penalty_severity"]
    best, why = 0.0, ""

    def bump(val, reason):
        nonlocal best, why
        if val > best:
            best, why = val, reason

    for pr in provisions:
        kind = (pr.get("kind") or "").upper()
        if kind == "SUSPENSION_CANCELLATION":
            bump(p["suspension"], "registration can be cancelled/suspended")
        elif kind == "IMPRISONMENT":
            months = pr.get("imprisonment_months") or 0
            for lim, val in p["imprisonment_ge_months"]:
                if months >= lim:
                    bump(val, f"imprisonment up to {months or 'unspecified'} months")
                    break
        elif kind == "PER_DAY":
            bump(p["per_day"], "penalty accrues per day")
        elif kind == "MULTIPLIER_OF_SUM":
            bump(p["multiplier"], "penalty is a multiple of the sum involved")
        elif kind == "FIXED_FINE":
            amt = pr.get("amount_max") or pr.get("amount_min") or 0
            for lim, val in p["fine_ge_rupees"]:
                if amt >= lim:
                    bump(val, f"fine up to ₹{int(amt):,}" if amt else "fine (amount unstated)")
                    break
        elif kind == "UNQUANTIFIED":
            bump(p["unquantified"], "a penalty exists (amount not stated in text)")
    return (best, why) if best else (p["unquantified"], "penalty provisions present")


def deadline_factor(effective_from, today: date | None = None) -> tuple[float, str]:
    d = _parse_date(effective_from)
    if not d:
        return PARAMS["no_date_multiplier"], "no effective date"
    today = today or date.today()
    days = (d - today).days
    if days < 0:
        return PARAMS["overdue_multiplier"], f"in force {abs(days)}d ago"
    for limit, mult in PARAMS["deadline_bands"]:
        if days <= limit:
            return mult, f"in force in {days}d"
    return PARAMS["deadline_far_multiplier"], f"in force in {days}d"


def mitigation_coverage(reached: list[dict], edges: list[dict], brain_by_id: dict) -> dict:
    """
    How much of the reached RISK SURFACE is already covered by a control /
    evidence / policy through a mitigation edge.

    coverage = Σ(weight of covered surface entities) / Σ(weight of surface entities)
    weighted by domain weight so a covered critical process counts more than a
    covered minor data asset. Returns 0..1 plus the counts it rested on.
    """
    p = PARAMS
    reached_ids = {r["company_brain_entity_id"] for r in reached}
    # Which reached entities are "cover" nodes, by id.
    cover_ids = {eid for eid in reached_ids
                 if brain_by_id.get(eid, {}).get("domain") in p["cover_domains"]}
    # A surface entity is covered if a mitigation edge connects it to any cover
    # node (in either direction — the graph stores control→risk as often as risk→control).
    covered: set[str] = set()
    for e in edges:
        if (e.get("type") or "").lower() not in p["mitigation_verbs"]:
            continue
        a, b = e.get("source_id"), e.get("target_id")
        for x, y in ((a, b), (b, a)):
            if x in reached_ids and y in cover_ids:
                covered.add(x)

    total_w = cov_w = 0
    surface = 0
    for eid in reached_ids:
        e = brain_by_id.get(eid, {})
        if e.get("domain") not in p["risk_surface_domains"]:
            continue
        surface += 1
        w = p["domain_weight"].get(e.get("domain"), 2)
        total_w += w
        if eid in covered:
            cov_w += w
    coverage = (cov_w / total_w) if total_w else 0.0
    return {"coverage": round(coverage, 3), "surface_entities": surface,
            "covered_entities": len(covered & {i for i in reached_ids}),
            "cover_nodes": len(cover_ids)}


def confidence(reached: list[dict], edges: list[dict], brain_by_id: dict,
               profile_facts: dict, verdict: str | None) -> dict:
    """
    How much to trust this score, in 0..1, from the completeness of the inputs.
    Never feeds the score — reported beside it.
    """
    p = PARAMS["confidence_weights"]
    reached_ids = [r["company_brain_entity_id"] for r in reached]
    n = len(reached_ids) or 1

    known_crit = sum(1 for eid in reached_ids
                     if _v1.criticality(brain_by_id.get(eid, {}).get("criticality"))[1]
                     and (brain_by_id.get(eid, {}).get("criticality") or "").strip())
    ids_with_edge = {e.get("source_id") for e in edges} | {e.get("target_id") for e in edges}
    with_edge = sum(1 for eid in reached_ids if eid in ids_with_edge)

    signals = {
        "has_sectors": 1.0 if (profile_facts.get("sectors")) else 0.0,
        "has_licences": 1.0 if (profile_facts.get("licences")) else 0.0,
        "verdict_certain": 1.0 if (verdict or "").upper() in {"APPLICABLE", "NOT_APPLICABLE"} else 0.0,
        "criticality_coverage": known_crit / n,
        "edge_density": with_edge / n,
        "profile_verified": 1.0 if profile_facts.get("source_verified") else 0.0,
    }
    total_w = sum(p.values())
    conf = sum(p[k] * signals[k] for k in p) / total_w if total_w else 0.0
    return {"confidence": round(conf, 3), "signals": signals}


# --------------------------------------------------------------------------- #
# The score.                                                                   #
# --------------------------------------------------------------------------- #
def score(reached: list[dict], obligations: list[dict], verdict: str | None,
          brain_by_id: dict, regulation: dict, edges: list[dict],
          profile_facts: dict, today: date | None = None,
          severity_override: tuple | None = None) -> dict:
    """
    Residual-risk score for one regulation on this company.

    Returns inherentScore and residualScore (0..100), the level band on the
    residual, a confidence, and the full factor breakdown. A regulation that is
    positively NOT_APPLICABLE scores 0, as in v1.
    """
    p = PARAMS
    v = (verdict or "").upper()
    reaches = v in _REACHES

    gx = gross_exposure(reached, obligations, brain_by_id)
    if severity_override and severity_override[0] is not None:
        sev, sev_from = severity_override
    else:
        # nothing that says how bad failure is: neutral, and said so — never the
        # regulation's own previous level (see PARAMS["severity"])
        sev = p["severity_default"]
        sev_from = "not yet known: no penalties or assessed risks (neutral default)"
    like = p["likelihood_default"]
    dl_mult, dl_why = deadline_factor(regulation.get("effective_from"), today)
    mit = mitigation_coverage(reached, edges, brain_by_id)
    conf = confidence(reached, edges, brain_by_id, profile_facts, verdict)

    if v and not reaches and v != "REVIEW_REQUIRED":
        inherent = residual = 0
        level = "None"
    else:
        reach_mult = p["reach_multiplier"] if reaches else 1.0
        # Inherent risk: exposure made severe, likely and urgent, on 0..100.
        inherent = gx["exposure"] * sev * like * reach_mult * dl_mult
        inherent = int(min(100, round(inherent)))
        # Residual: net off what existing controls already cover.
        residual = inherent * (1 - p["max_mitigation_reduction"] * mit["coverage"])
        residual = int(min(100, round(residual)))
        r = residual
        b = p["bands"]
        level = ("Critical" if r >= b["Critical"] else "High" if r >= b["High"]
                 else "Medium" if r >= b["Medium"] else "Low")

    factors = {
        "inherentScore": inherent,
        "residualScore": residual,
        "confidence": conf["confidence"],
        "confidenceSignals": conf["signals"],
        "gross_exposure": gx["exposure"],
        "affected_by_domain": gx["by_domain"],
        "max_entity_criticality": gx["max_criticality"],
        "obligations": len(obligations),
        "severity": {"factor": sev, "from": sev_from},
        "likelihood": {"factor": like, "from": "config default (Stage B: estimated)"},
        "deadline": {"multiplier": dl_mult, "why": dl_why},
        "mitigation": mit,
        "applicability": v or "NOT_ASSESSED",
        "reachesCompany": reaches,
        "formula": ("inherent = min(100, gross_exposure × severity × likelihood × "
                    "reach(1.15) × deadline);  residual = inherent × "
                    "(1 − 0.6 × mitigation_coverage);  0 when positively not applicable"),
        "params_version": "v2",
    }
    return {
        "inherentScore": inherent,
        "residualScore": residual,
        "score": residual,               # the headline number is the residual
        "level": level,
        "confidence": conf["confidence"],
        "confidenceSignals": conf["signals"],
        "factors": json.dumps(factors),
    }


# --------------------------------------------------------------------------- #
# Live wiring: read the same tables pipeline.py already writes, compute the v2  #
# score, and store it where the existing API/UI already read it (impact_scores #
# .score/.level + regulations.impact_score/.impact_level). The v2 breakdown —  #
# inherent, residual, confidence, mitigation, severity, deadline, and the v1   #
# gross-exposure number for comparison — rides in the factors JSON, so the      #
# detail view surfaces it without a frontend rebuild.                          #
# --------------------------------------------------------------------------- #
def _rows(con, sql, args=()):
    # Pass params only when there are some: a query with literal % (ILIKE '%x%')
    # and an empty param tuple makes psycopg try to %-format and fail.
    cur = con.execute(sql, args) if args else con.execute(sql)
    out = []
    for r in cur.fetchall():
        out.append(dict(r) if hasattr(r, "keys") else r)
    return out


def load_context(con) -> dict:
    """Company-wide inputs, loaded once so a batch recompute reads them one time."""
    brain_by_id: dict = {}
    for r in _rows(con, "SELECT id, domain, criticality, type FROM company_entities"):
        brain_by_id[r["id"] if isinstance(r, dict) else r[0]] = (
            r if isinstance(r, dict) else
            {"id": r[0], "domain": r[1], "criticality": r[2], "type": r[3]})
    edges = _rows(con, "SELECT source_id, type, target_id FROM entity_relationships")
    from . import applicability as A
    profile = A.company_facts(con)
    pv = _rows(con, "SELECT source_verified FROM company_profile ORDER BY id LIMIT 1")
    profile["source_verified"] = bool(pv[0]["source_verified"]) if pv else False
    return {"brain_by_id": brain_by_id, "edges": edges, "profile": profile}


def compute(con, reg_id: str, ctx: dict | None = None) -> dict:
    """Compute the v2 residual-risk score for one regulation from the live tables."""
    ctx = ctx or load_context(con)
    reg_rows = _rows(con, "SELECT id, impact_level, effective_from, applicability "
                          "FROM regulations WHERE id=?", (reg_id,))
    if not reg_rows:
        raise ValueError(f"no such regulation: {reg_id}")
    reg = reg_rows[0]
    reached = _rows(con, "SELECT company_brain_entity_id FROM impact_relationships "
                         "WHERE regulation_id=?", (reg_id,))
    obls = _rows(con, "SELECT id FROM obligations WHERE regulation_id=?", (reg_id,))
    provisions = _rows(con, "SELECT kind, amount_min, amount_max, per_day_amount, "
                            "imprisonment_months FROM penalty_provisions WHERE regulation_id=?",
                       (reg_id,))
    # severity, most evidenced first: the statutory penalties, then the risks the gap
    # assessment gave the requirements, then (in score) the neutral default
    sev_override = severity_from_penalties(provisions)
    if sev_override[0] is None:
        try:
            risks = [r["risk"] for r in _rows(con, "SELECT risk FROM gap_assessments "
                                                   "WHERE regulation_id=? AND status <> 'NOT_APPLICABLE'", (reg_id,))]
        except Exception:          # no gap_assessments table on this database
            risks = []
        sev_override = severity_from_assessment(risks)
    verdict = reg.get("applicability")
    sc2 = score(reached, obls, verdict, ctx["brain_by_id"], reg, ctx["edges"], ctx["profile"],
                severity_override=sev_override)
    # Stash the v1 gross-exposure number alongside, so the two are comparable in the UI.
    try:
        v1 = _v1.score(reached, obls, verdict, ctx["brain_by_id"])
        f = json.loads(sc2["factors"]); f["v1_gross_score"] = v1["score"]
        sc2["factors"] = json.dumps(f)
    except Exception:
        pass
    return sc2


def store(con, reg_id: str, sc2: dict) -> None:
    """Persist v2 where the existing API/UI already read it. Residual is the headline."""
    con.execute("""INSERT INTO impact_scores (regulation_id, score, level, factors)
                   VALUES (?,?,?,?)
                   ON CONFLICT (regulation_id) DO UPDATE SET
                     score=EXCLUDED.score, level=EXCLUDED.level, factors=EXCLUDED.factors""",
                (reg_id, sc2["residualScore"], sc2["level"], sc2["factors"]))
    con.execute("UPDATE regulations SET impact_level=?, impact_score=? WHERE id=?",
                (sc2["level"], sc2["residualScore"], reg_id))


def recompute_all(con, where: str = "", args: tuple = (), commit_every: int = 200) -> dict:
    """
    Recompute v2 for every regulation that has impact relationships (i.e. has been
    mapped to the company). `where` filters the regulation set, e.g.
    "AND (r.title ILIKE '%NABH%' OR r.title ILIKE '%hospital%')".
    """
    ctx = load_context(con)
    ids = [r["id"] if isinstance(r, dict) else r[0] for r in _rows(
        con,
        "SELECT DISTINCT r.id FROM regulations r "
        "JOIN impact_relationships ir ON ir.regulation_id = r.id "
        f"WHERE 1=1 {where}", args)]
    done = 0
    bands: dict = {}
    for rid in ids:
        sc2 = compute(con, rid, ctx)
        store(con, rid, sc2)
        bands[sc2["level"]] = bands.get(sc2["level"], 0) + 1
        done += 1
        if done % commit_every == 0:
            con.commit()
    con.commit()
    return {"recomputed": done, "bands": bands}


# --------------------------------------------------------------------------- #
# Self-test: three scenarios that show the model behaving, runnable without    #
# the database or the pipeline.  python -m regulatory_ingestion.impact_v2      #
# --------------------------------------------------------------------------- #
def _demo():
    brain = {
        "risk1":  {"domain": "risks",     "criticality": "Critical"},
        "proc1":  {"domain": "processes", "criticality": "High"},
        "sys1":   {"domain": "systems",   "criticality": "High"},
        "ctrl1":  {"domain": "controls",  "criticality": "Medium"},
        "ev1":    {"domain": "evidence",  "criticality": "Low"},
    }
    reached = [{"company_brain_entity_id": k} for k in brain]
    obligations = [{"text": f"ob{i}"} for i in range(6)]
    profile = {"sectors": ["Healthcare & Hospitals"],
               "licences": ["NABH accreditation", "Fire NOC", "Bio-medical waste authorization"],
               "source_verified": True}

    print("== A) uncovered, Critical severity, in force in 20 days ==")
    r = score(reached, obligations, "APPLICABLE", brain,
              {"effective_from": (date.today().isoformat())},
              edges=[], profile_facts=profile, severity_override=(1.0, "Critical"))
    print(f"  inherent={r['inherentScore']} residual={r['residualScore']} "
          f"level={r['level']} confidence={r['confidence']}")

    print("== B) SAME reg, now controls cover the risk surface ==")
    edges = [{"source_id": "ctrl1", "type": "mitigates", "target_id": "risk1"},
             {"source_id": "ctrl1", "type": "protects",  "target_id": "proc1"},
             {"source_id": "ev1",   "type": "proves",    "target_id": "sys1"}]
    r2 = score(reached, obligations, "APPLICABLE", brain,
               {"effective_from": date.today().isoformat()},
               edges=edges, profile_facts=profile, severity_override=(1.0, "Critical"))
    print(f"  inherent={r2['inherentScore']} residual={r2['residualScore']} "
          f"level={r2['level']} confidence={r2['confidence']}  "
          f"(residual dropped from {r['residualScore']} as controls net off risk)")

    print("== C) thin profile, Low severity, no date → low confidence ==")
    r3 = score([{"company_brain_entity_id": "risk1"}], obligations[:1], "REVIEW_REQUIRED",
               {"risk1": {"domain": "risks", "criticality": ""}},
               {"effective_from": ""},
               edges=[], profile_facts={"sectors": [], "licences": []}, severity_override=(0.3, "Low"))
    print(f"  inherent={r3['inherentScore']} residual={r3['residualScore']} "
          f"level={r3['level']} confidence={r3['confidence']}  (few inputs → low confidence)")


if __name__ == "__main__":
    _demo()
