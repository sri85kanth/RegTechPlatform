"""
Score one risk. Pure: no database, no model, and the date is passed in, so the
same inputs and rulebook always give the same assessment (and the same hash).

A risk is a group of exposures (design §4.1): obligation exposures ("failure to
meet requirement R at site S") and library-template exposures ("template T on
graph node N"). Each exposure is scored on its own; the risk takes the worst
one, named as the driver, so grouping never hides a bad member.

Per exposure:
  impact      five dimensions, each by first-true rule; the aggregate is the max
  likelihood  base (inspection frequency, else template class) + modifiers
  controls    best grade among mapped controls, decayed by evidence age, capped
              by the gap review; UNKNOWN is not ABSENT
  residual    likelihood (and, for a tested corrective control, impact) reduced
  target      residual as if every planned action's control reached TESTED

Unknown facts never lower a score: an optional fact that is missing is taken at
its worse value (and the better one is kept as the lower bound); a mandatory
one makes the verdict INSUFFICIENT_EVIDENCE, with what is missing listed.
"""
from __future__ import annotations

import copy
import hashlib
import json
from datetime import date, datetime
from typing import Any

from . import predicates as P
from .rulebook import BANDS, DIMENSIONS, GRADES, Rulebook, RulebookError, validate_matrix

ENGINE = "risk-engine/1"
BAND_RANK = {b: i for i, b in enumerate(BANDS)}
GRADE_RANK = {g: i for i, g in enumerate(GRADES)}
SCORED = ("APPLICABLE", "CONDITIONAL")
VERDICTS = ("WITHIN_APPETITE", "TREAT", "ESCALATE", "INSUFFICIENT_EVIDENCE", "REVIEW_REQUIRED")
_DECAY_LADDER = ["CLAIMED", "DOCUMENTED", "TESTED"]


# ------------------------------------------------------------------ helpers
def _as_date(v: Any) -> date | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _deep_merge(a: dict, b: dict) -> dict:
    out = copy.deepcopy(a)
    for k, v in (b or {}).items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


def _matrix(rb: Rulebook, appetite: dict | None) -> tuple[dict[int, list[str]], str]:
    """The client's matrix when leadership set one (decision D2), else the rulebook's."""
    m = (appetite or {}).get("matrix")
    if m:
        try:
            validate_matrix(m, "appetite.matrix")
        except RulebookError as e:
            raise ValueError(str(e)) from e
        return {int(k): v for k, v in m.items()}, "client"
    return {int(k): v for k, v in rb.data["matrix"].items()}, "rulebook"


def _point(matrix: dict[int, list[str]], impact: int, likelihood: int) -> dict:
    return {"impact": impact, "likelihood": likelihood, "product": impact * likelihood,
            "band": matrix[impact][likelihood - 1]}


def _rank(p: dict | None) -> tuple:
    return (BAND_RANK[p["band"]], p["product"]) if p else (-1, -1)


# ------------------------------------------------------------------ impact
def _runs(rule: dict, kind: str) -> bool:
    return kind in (rule.get("applies_to") or (kind,))


def _dimension(spec: dict, facts: dict, kind: str) -> dict:
    na = spec.get("not_applicable_when")
    if na:
        state, _ = P.evaluate(na, facts)
        if state is True:
            return {"applicable": False}
    fired = None
    unknown: list[tuple[str, int]] = []
    missing: set[str] = set()
    for rule in spec.get("rules") or []:
        if not _runs(rule, kind):
            continue
        state, miss = P.evaluate(rule["when"], facts)
        score = rule.get("score")
        if "score_from" in rule:
            raw = P.get(facts, rule["score_from"])
            try:
                score = min(5, max(1, int(raw))) if raw is not P.MISSING else None
            except (TypeError, ValueError):
                score = None
            if score is None:
                state = False
        if state is True:
            fired = (rule["id"], score)
            break
        if state is None:
            unknown.append((rule["id"], score))
            missing |= miss
    if fired:
        best = worst = fired[1]
        source, default_used = fired[0], False
    else:
        d = spec["default"]
        default_used = bool(d.get("assumed"))     # a baseline default is an answer, not a gap
        if "score" in d:
            best = worst = d["score"]
            source = "default"
        else:
            key = P.get(facts, d["by"])
            options = list(d["values"].values()) + [d["otherwise"]]
            if key is P.MISSING:
                best, worst = min(options), max(options)
                missing.add(d["by"])
            else:
                best = worst = d["values"].get(str(key).lower(), d["otherwise"])
            source = f"default by {d['by']}"
    worst = max([worst] + [s for _, s in unknown])
    return {"applicable": True, "score": worst, "best": best, "rule": source, "default_used": default_used,
            "precaution": worst > best, "unknown_rules": [r for r, _ in unknown], "missing": sorted(missing)}


def _impact(rb: Rulebook, facts: dict, kind: str) -> dict:
    spec = rb.data["impact"]
    dims = {name: _dimension(spec["dimensions"][name], facts, kind) for name in DIMENSIONS}
    cat = P.get(facts, "nabh_category")
    floor = (rb.data.get("nabh_category_floor") or {}).get(str(cat).upper(), {}) if cat is not P.MISSING else {}
    for dim, v in floor.items():
        d = dims.get(dim)
        if d and d["applicable"] and d["score"] < v:
            d["score"], d["best"] = v, max(d["best"], v)
            d["rule"] = f"{d['rule']} + NABH {str(cat).upper()} floor"
            d["default_used"] = False
    live = {k: v for k, v in dims.items() if v["applicable"]}
    score = max(v["score"] for v in live.values())
    best = max(v["best"] for v in live.values())
    order = [o for o in spec.get("order") or DIMENSIONS if o in live]
    driving = next(o for o in order if live[o]["score"] == score)
    return {"score": score, "best": best, "driving_dimension": driving, "dimensions": dims}


# ------------------------------------------------------------------ likelihood
def _likelihood(rb: Rulebook, facts: dict, kind: str) -> dict:
    spec = rb.data["likelihood"]
    base_spec = spec["base"]
    value = P.get(facts, base_spec["from"])
    fb = base_spec.get("fallback") or {}
    fb_value = P.get(facts, fb["from"]) if fb else P.MISSING
    if value is not P.MISSING and str(value).lower() in base_spec["map"]:
        base, base_rule, base_default = base_spec["map"][str(value).lower()], f"base: {base_spec['from']} = {value}", False
    elif fb_value is not P.MISSING and str(fb_value).lower() in fb["map"]:
        base, base_rule, base_default = fb["map"][str(fb_value).lower()], f"base: {fb['from']} = {fb_value}", False
    else:
        base, base_rule, base_default = base_spec["default"], "base: default", True
    fired, unknown, missing = [], [], set()
    for m in spec.get("modifiers") or []:
        if not _runs(m, kind):
            continue
        state, miss = P.evaluate(m["when"], facts)
        if state is True:
            fired.append({"id": m["id"], "add": m["add"]})
        elif state is None:
            unknown.append({"id": m["id"], "add": m["add"]})
            missing |= miss
    known = base + sum(f["add"] for f in fired)
    clamp = lambda x: max(1, min(5, x))  # noqa: E731
    best = clamp(known + sum(min(0, u["add"]) for u in unknown))
    worst = clamp(known + sum(max(0, u["add"]) for u in unknown))
    mandatory_missing = [p for p in spec.get("mandatory") or [] if P.get(facts, p) is P.MISSING]
    prefixes = tuple(p.rsplit(".", 1)[0] + "." for p in mandatory_missing)
    optional_missing = sorted(p for p in missing if p not in mandatory_missing and not p.startswith(prefixes))
    return {"score": worst, "best": best, "base": base, "base_rule": base_rule, "base_default": base_default,
            "fired": fired, "unknown": unknown, "precaution": worst > best,
            "mandatory_missing": mandatory_missing, "optional_missing": optional_missing}


# ------------------------------------------------------------------ controls
def _control_grade(c: dict, ctl: dict, as_of: date) -> tuple[str, str]:
    if ctl.get("confirmed_absent"):
        return "ABSENT", "confirmed absent"
    doc, test, claim = ctl.get("approved_document"), ctl.get("test_evidence"), ctl.get("self_declared")
    if doc and test:
        grade, when = "TESTED", _as_date(ctl.get("newest_evidence_on"))
        interval = ctl.get("expected_interval_days") or c["expected_interval_days"].get(
            str(ctl.get("frequency") or "").lower(), c["expected_interval_days"].get("annual", 400))
        what = "newest test or audit evidence"
    elif doc:
        grade, when = "DOCUMENTED", _as_date(ctl.get("document_reviewed_on"))
        interval, what = c["document_review_days"], "document review"
    elif claim:
        return "CLAIMED", "self-declared only"
    elif doc is None and test is None and claim is None:
        return "UNKNOWN", "nothing known about it yet"
    else:
        return "ABSENT", "no document, test or declaration"
    if when is None:
        drop, note = 1, f"{what} date unknown, so counted as stale"
    else:
        ratio = (as_of - when).days / float(interval)
        drop = next((s["drop"] for s in sorted(c["freshness"], key=lambda s: -s["over"]) if ratio > s["over"]), 0)
        note = f"{what} {(as_of - when).days} days old against {interval} expected ({ratio:.2f}×)"
    if drop:
        new = _DECAY_LADDER[max(0, _DECAY_LADDER.index(grade) - drop)]
        return new, f"{note}: {grade} → {new}"
    return grade, note


def _grade(rb: Rulebook, exp: dict, as_of: date) -> dict:
    c = rb.data["controls"]
    rows = []
    for ctl in exp.get("controls") or []:
        g, note = _control_grade(c, ctl, as_of)
        rows.append({"id": ctl.get("id"), "label": ctl.get("label"), "kind": ctl.get("kind", "preventive"),
                     "grade": g, "note": note})
    known = [r for r in rows if r["grade"] != "UNKNOWN"]
    status = exp.get("gap_status")
    if known:
        top = max(known, key=lambda r: GRADE_RANK[r["grade"]])
        grade, source = top["grade"], f"control {top['id'] or top['label']}"
    elif status in (c.get("implied_by_gap_status") or {}):
        grade, source = c["implied_by_gap_status"][status], f"gap review says {status}"
    else:
        grade, source = "UNKNOWN", "no control evidence and no gap review"
    cap = (c.get("cap_by_gap_status") or {}).get(status)
    capped = bool(cap and GRADE_RANK[grade] > GRADE_RANK[cap])
    if capped:
        grade = cap
    corrective = grade == "TESTED" and any(r["grade"] == "TESTED" and r["kind"] == "corrective" for r in rows)
    return {"grade": grade, "source": source, "capped_by": f"gap review {status}" if capped else None,
            "corrective_tested": corrective, "controls": rows}


def _apply(rb: Rulebook, matrix: dict, impact: int, likelihood: int, grade: str, corrective: bool) -> dict:
    c = rb.data["controls"]
    eff = c["residual_effect"].get(grade, {})
    dl = max(-c["max_reduction"]["likelihood"], eff.get("likelihood", 0))
    di = max(-c["max_reduction"]["impact"], eff.get("impact_if_corrective", 0)) if corrective else 0
    return _point(matrix, max(c["floors"]["impact"], impact + di), max(c["floors"]["likelihood"], likelihood + dl))


# ------------------------------------------------------------------ one exposure
def _exposure(rb: Rulebook, risk_input: dict, exp: dict, matrix: dict, as_of: date) -> dict:
    theme_id = exp.get("theme") or risk_input["risk"].get("theme")
    facts = _deep_merge(risk_input.get("shared") or {}, exp.get("facts") or {})
    facts["theme"] = {**(rb.theme(theme_id) or {}), **(facts.get("theme") or {})}
    kind = exp.get("kind", "obligation")
    imp = _impact(rb, facts, kind)
    lik = _likelihood(rb, facts, kind)
    g = _grade(rb, exp, as_of)
    mandatory_missing = list(lik["mandatory_missing"]) + (["controls"] if g["grade"] == "UNKNOWN" else [])
    optional_missing = sorted(set(lik["optional_missing"]) | {m for d in imp["dimensions"].values()
                                                              if d.get("applicable") for m in d["missing"]})
    inherent = _point(matrix, imp["score"], lik["score"])
    residual = _apply(rb, matrix, imp["score"], lik["score"], g["grade"], g["corrective_tested"])
    planned = exp.get("planned") or []
    if planned:
        corrective = g["corrective_tested"] or any(p.get("kind") == "corrective" for p in planned)
        target = _apply(rb, matrix, imp["score"], lik["score"], "TESTED", corrective)
        if _rank(target) > _rank(residual):
            target = residual
    else:
        target = residual
    known_grade = g["grade"] != "UNKNOWN"
    best = _apply(rb, matrix, imp["best"], lik["best"], g["grade"] if known_grade else "TESTED", g["corrective_tested"])
    # the scores already take every unknown modifier and rule at its worse value
    worst = _apply(rb, matrix, imp["score"], lik["score"],
                   g["grade"] if known_grade else "ABSENT", g["corrective_tested"] if known_grade else False)
    return {"id": exp["id"], "label": exp.get("label"), "kind": kind,
            "theme": theme_id, "applicability": exp.get("applicability"),
            "gap_status": exp.get("gap_status"), "gap_status_reviewed": bool(exp.get("gap_status_reviewed")),
            "seed_status": P.get(facts, "template.seed_status"),
            "impact": imp, "likelihood": lik, "controls": g,
            "inherent": inherent, "residual": residual, "target": target, "planned": planned,
            "bounds": {"best": best, "worst": worst},
            "mandatory_missing": mandatory_missing, "optional_missing": optional_missing}


# ------------------------------------------------------------------ evaluation
def _category(rb: Rulebook, e: dict) -> str:
    t = rb.theme(e["theme"]) or {}
    return t.get("category") or e["impact"]["driving_dimension"]


def _evaluate(band: str, category: str, appetite: dict | None, confidence: int) -> tuple[str, str, str, dict | None]:
    if not appetite or appetite.get("status") != "APPROVED":
        return "REVIEW_REQUIRED", "EV-03", "the risk appetite is not approved yet", None
    cats = appetite.get("categories") or {}
    a = cats.get(category) or cats.get("default")
    if not a:
        return "REVIEW_REQUIRED", "EV-03", f"no appetite is set for {category}", None
    a = {"category": category, "appetite": a["appetite"], "tolerance": a.get("tolerance", a["appetite"]),
         "zero_tolerance": bool(a.get("zero_tolerance")), "version": appetite.get("version")}
    r, ap, tol = BAND_RANK[band], BAND_RANK[a["appetite"]], BAND_RANK[a["tolerance"]]
    if r > tol:
        return "ESCALATE", "EV-04", f"residual {band} is above the {category} tolerance {a['tolerance']}", a
    if a["zero_tolerance"] and r > ap:
        return "ESCALATE", "EV-04", f"{category} is zero-tolerance and residual {band} is above {a['appetite']}", a
    if r > ap:
        return "TREAT", "EV-05", f"residual {band} is above the {category} appetite {a['appetite']}", a
    threshold = int(appetite.get("confidence_threshold", 60))
    if confidence < threshold:
        return "REVIEW_REQUIRED", "EV-06", f"confidence {confidence} is below the threshold {threshold}", a
    return "WITHIN_APPETITE", "EV-07", f"residual {band} is within the {category} appetite {a['appetite']}", a


def _confidence(rb: Rulebook, risk_input: dict, driver: dict, scored: list[dict], pending: list[dict]) -> dict:
    spec = rb.data["confidence"]
    dims = [d for d in driver["impact"]["dimensions"].values() if d.get("applicable")]
    counts = {
        "mandatory_missing": len({p for e in scored for p in e["mandatory_missing"]}),
        "default_used": sum(1 for d in dims if d["default_used"]) + (1 if driver["likelihood"]["base_default"] else 0),
        "precaution_used": sum(1 for d in dims if d["precaution"]) + (1 if driver["likelihood"]["precaution"] else 0),
        "fact_unconfirmed": len(set(risk_input.get("unconfirmed_facts") or [])),
        "gap_status_unreviewed": int(any(e["gap_status"] and not e["gap_status_reviewed"] for e in scored)),
        "applicability_conditional": int(any(e["applicability"] == "CONDITIONAL" for e in scored)),
        "evidence_claimed_only": int(driver["controls"]["grade"] == "CLAIMED"),
        "pack_uncalibrated": int(rb.uncalibrated),
        "template_seed_unreviewed": int(driver["kind"] == "template" and driver["seed_status"] == "draft"),
        "exposures_pending_review": int(bool(pending)),
    }
    deductions = {}
    for key, n in counts.items():
        if n and key in spec["penalties"]:
            each, cap = spec["penalties"][key]
            deductions[key] = min(cap, each * n)
    score = max(0, int(spec["start"]) - sum(deductions.values()))
    bands = spec["bands"]
    band = "HIGH" if score >= bands["HIGH"] else "MEDIUM" if score >= bands["MEDIUM"] else "LOW"
    return {"score": score, "band": band, "deductions": deductions}


# ------------------------------------------------------------------ the risk
def assess(rb: Rulebook, risk_input: dict, appetite: dict | None = None, as_of: date | str | None = None) -> dict:
    """One risk's assessment. `risk_input` is the snapshot an assessment stores."""
    as_of_d = _as_date(as_of) or date.today()
    matrix, matrix_source = _matrix(rb, appetite)
    risk = risk_input["risk"]
    exps = [_exposure(rb, risk_input, e, matrix, as_of_d) for e in risk_input.get("exposures") or []]
    scored = [e for e in exps if e["applicability"] in SCORED]
    pending = [e for e in exps if e["applicability"] not in SCORED and e["applicability"] != "NOT_APPLICABLE"]
    ruled_out = [e for e in exps if e["applicability"] == "NOT_APPLICABLE"]
    complete = [e for e in scored if not e["mandatory_missing"]]
    incomplete = [e for e in scored if e["mandatory_missing"]]

    out: dict[str, Any] = {
        "engine": ENGINE, "rulebook": rb.ref, "as_of": as_of_d.isoformat(), "matrix_source": matrix_source,
        "risk": {k: risk.get(k) for k in ("id", "title", "theme", "site")},
        "pending_exposures": [e["id"] for e in pending], "not_applicable_exposures": [e["id"] for e in ruled_out],
        "exposures": exps,
    }
    out["inputs_hash"] = "sha256:" + hashlib.sha256(json.dumps(
        {"input": risk_input, "appetite": appetite, "as_of": out["as_of"], "rulebook": rb.ref["hash"]},
        sort_keys=True, default=str).encode()).hexdigest()

    missing: dict[str, dict] = {}
    for e in scored:
        for path in e["mandatory_missing"]:
            missing.setdefault(path, {"fact": path, "mandatory": True, "exposures": []})["exposures"].append(e["id"])
        for path in e["optional_missing"]:
            m = missing.setdefault(path, {"fact": path, "mandatory": False, "exposures": []})
            m["exposures"].append(e["id"])
    out["missing"] = sorted(missing.values(), key=lambda m: (not m["mandatory"], m["fact"]))

    if not scored or risk.get("interpretation_ambiguous"):
        why = ("its interpretation is flagged ambiguous" if risk.get("interpretation_ambiguous")
               else "no exposure has a resolved applicability")
        out.update(verdict="REVIEW_REQUIRED", verdict_rule="EV-01", verdict_reason=why, floor_verdict=None,
                   category=None, appetite=None, inherent=None, residual=None, target=None, provisional=True,
                   driver=None, confidence={"score": 0, "band": "LOW", "deductions": {}},
                   bounds={"best": None, "worst": None})
        out["rationale"] = f"{risk.get('title')}: needs review before it can be scored, because {why}."
        return out

    basis = complete or scored
    driver = max(basis, key=lambda e: (_rank(e["residual"]), _rank(e["inherent"])))
    inherent = max((e["inherent"] for e in basis), key=_rank)
    target = max((e["target"] for e in basis), key=_rank)
    confidence = _confidence(rb, risk_input, driver, scored, pending)
    category = _category(rb, driver)
    out["bounds"] = {"best": max((e["bounds"]["best"] for e in scored), key=_rank),
                     "worst": max((e["bounds"]["worst"] for e in scored), key=_rank)}

    known = _evaluate(driver["residual"]["band"], category, appetite, confidence["score"]) if complete else None
    floor = None
    if incomplete and not (known and known[0] == "ESCALATE"):
        verdict, rule = "INSUFFICIENT_EVIDENCE", "EV-02"
        facts = sorted({p for e in incomplete for p in e["mandatory_missing"]})
        reason = f"missing {', '.join(facts)} for {len(incomplete)} of {len(scored)} exposures"
        floor = known[0] if known and known[0] in ("TREAT", "ESCALATE") else None
        appetite_used = known[3] if known else None
    elif incomplete:
        verdict, rule, reason, appetite_used = known
        reason += f"; {len(incomplete)} more exposures could not be scored and can only add to it"
    else:
        verdict, rule, reason, appetite_used = known

    out.update(verdict=verdict, verdict_rule=rule, verdict_reason=reason, floor_verdict=floor,
               category=category, appetite=appetite_used, inherent=inherent, residual=driver["residual"],
               target=target, provisional=not complete, driver=driver["id"], confidence=confidence)
    out["derivation"] = _derivation(driver, matrix_source)
    out["rationale"] = _rationale(out, driver)
    return out


# ------------------------------------------------------------------ explanation (deterministic)
def _derivation(e: dict, matrix_source: str) -> list[dict]:
    steps = []
    for name, d in e["impact"]["dimensions"].items():
        if not d.get("applicable"):
            steps.append({"step": f"impact.{name}", "value": None, "rule": "not applicable"})
            continue
        steps.append({"step": f"impact.{name}", "value": d["score"], "rule": d["rule"],
                      "unknown_rules": d["unknown_rules"], "missing": d["missing"]})
    lik = e["likelihood"]
    steps.append({"step": "likelihood.base", "value": lik["base"], "rule": lik["base_rule"]})
    for f in lik["fired"]:
        steps.append({"step": "likelihood.modifier", "value": f["add"], "rule": f["id"]})
    for u in lik["unknown"]:
        steps.append({"step": "likelihood.modifier.unknown", "value": u["add"], "rule": u["id"]})
    c = e["controls"]
    steps.append({"step": "controls.grade", "value": c["grade"], "rule": c["source"], "capped_by": c["capped_by"],
                  "controls": c["controls"]})
    steps.append({"step": "inherent", "value": e["inherent"], "rule": f"matrix ({matrix_source})"})
    steps.append({"step": "residual", "value": e["residual"], "rule": f"controls {c['grade']}"})
    steps.append({"step": "target", "value": e["target"],
                  "rule": f"{len(e['planned'])} planned actions at TESTED" if e["planned"] else "no planned actions"})
    return steps


def _rationale(a: dict, e: dict) -> str:
    imp, lik = e["impact"], e["likelihood"]
    dim = imp["driving_dimension"]
    mods = ", ".join(f"{f['id']} {f['add']:+d}" for f in lik["fired"]) or "no modifiers"
    parts = [
        f"{a['risk']['title']}: inherent {a['inherent']['band']} (impact {a['inherent']['impact']}, "
        f"likelihood {a['inherent']['likelihood']}), residual {a['residual']['band']} with {e['controls']['grade']} "
        f"controls, target {a['target']['band']}.",
        f"Driven by {e['label'] or e['id']}: {dim} impact {imp['dimensions'][dim]['score']} "
        f"({imp['dimensions'][dim]['rule']}); likelihood {lik['score']} ({lik['base_rule']}; {mods}).",
        f"Verdict {a['verdict']} ({a['verdict_rule']}): {a['verdict_reason']}.",
        f"Confidence {a['confidence']['score']} ({a['confidence']['band']}).",
    ]
    if a["verdict"] == "INSUFFICIENT_EVIDENCE":
        parts.append(f"Between {a['bounds']['best']['band']} and {a['bounds']['worst']['band']} once the missing "
                     f"inputs are known.")
    return " ".join(parts)
