"""
Conditions layer (Stage B) — turn an applicability rule's prose into evaluable
predicates and check them against the company's quantitative facts.

WHY
---
applicability.py decides WHO a regulation addresses (entity family). It cannot
evaluate the CONDITIONS a rule attaches — "hospitals with 100 or more beds",
"non-bedded health-care facilities", "turnover exceeding 250 crore" — the code
itself notes there is "no threshold model ... threshold checks report UNKNOWN".
This module fills that gap:

  * a local LLM (gpt-oss) reads the rule text and extracts predicates — the part
    that needs language understanding;
  * a DETERMINISTIC evaluator compares each predicate to the profile facts — the
    part that must be replayable and defensible to an auditor.

The two are kept apart on purpose: the model never decides applicability, it only
proposes the predicate; the number a compliance officer sees rests on a
comparison they can re-run. Predicates are stored in applicability_rules
.thresholds (applies_if) and .conditions (excludes_if + unquantified), the
columns the schema already carries.
"""
from __future__ import annotations

import json

# Canonical facts a predicate can be evaluated against, and the words that map to
# each. Anything that does not map is kept but evaluates to UNKNOWN — honest,
# not guessed.
_FIELD_WORDS = {
    "beds":        ("bed", "bedded", "bed strength", "bed capacity"),
    "turnover_cr": ("turnover", "revenue", "annual turnover", "gross receipts", "sales"),
    "employees":   ("employee", "worker", "staff", "persons employed", "workmen",
                    "headcount", "head count", "manpower"),
}

_EXTRACT_SYSTEM = (
    "You extract applicability SIZE/COUNT conditions from a single clause of an "
    "Indian regulation — the conditions that decide WHICH organisations a rule "
    "applies to or excludes. Return ONLY JSON. "
    "Include explicit numeric thresholds (e.g. 'hospitals with 100 or more beds' "
    "-> applies_if beds >= 100; 'turnover exceeding 250 crore' -> applies_if "
    "turnover >= 250). ALSO convert categorical size words to predicates: "
    "'non-bedded' / 'without in-patient beds' -> applies_if beds = 0; "
    "'bedded' / 'in-patient' -> applies_if beds >= 1; "
    "'establishments employing N or more workers' -> applies_if employees >= N. "
    "Put an exclusion ('shall not apply to ...') in excludes_if. "
    "Ignore penalties, fees, deadlines and obligations. Every predicate needs a "
    "verbatim 'basis' quote from the text. If there is no size/count condition, "
    "return empty arrays."
)

_EXTRACT_SCHEMA = (
    '{"applies_if":[{"field":"beds|turnover|employees|<other>","op":">=|>|<=|<|=|!=",'
    '"value":<number>,"unit":"beds|crore|lakh|rupees|employees|<other>","basis":"quote"}],'
    '"excludes_if":[{"field":...,"op":...,"value":...,"unit":...,"basis":"quote"}],'
    '"unquantified_conditions":["condition text that has no number"]}'
)


def extract(text: str, max_tokens: int = 1500) -> dict:
    """LLM-extract predicates from one rule clause. Falls back to empty on failure."""
    text = (text or "").strip()
    if not text:
        return {"applies_if": [], "excludes_if": [], "unquantified_conditions": []}
    from .agent import llm as L
    r = L.complete(_EXTRACT_SYSTEM,
                   f"Clause:\n\"\"\"{text[:4000]}\"\"\"",
                   schema_hint=_EXTRACT_SCHEMA, json_mode=True, max_tokens=max_tokens)
    if not r.ok or not isinstance(r.data, dict):
        return {"applies_if": [], "excludes_if": [], "unquantified_conditions": [],
                "_error": r.error or "no data", "_model": r.model}
    d = r.data
    d.setdefault("applies_if", []); d.setdefault("excludes_if", [])
    d.setdefault("unquantified_conditions", [])
    d["_model"] = r.model
    return d


# --------------------------------------------------------------------------- #
# Deterministic evaluation.                                                     #
# --------------------------------------------------------------------------- #
def _canon_field(raw: str) -> str | None:
    t = (raw or "").lower()
    for field, words in _FIELD_WORDS.items():
        if any(w in t for w in words):
            return field
    return None


def _to_number(v) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _canon_value(field: str, value, unit: str | None) -> float | None:
    """Normalise a predicate's value to the fact's canonical unit."""
    n = _to_number(value)
    if n is None:
        return None
    u = (unit or "").lower()
    if field == "turnover_cr":
        # facts store crore. Convert rupees / lakh to crore; assume crore otherwise.
        if "rupee" in u or u in ("inr", "rs", "₹"):
            return n / 1e7
        if "lakh" in u:
            return n / 100.0
        return n            # crore (or unstated → assume crore, the register's unit)
    return n                # beds / employees are plain counts


def _fact_value(field: str, facts: dict) -> float | None:
    raw = {"beds": facts.get("beds"),
           "turnover_cr": facts.get("turnoverCr") or facts.get("turnover_cr"),
           "employees": facts.get("employees")}.get(field)
    return _to_number(raw)


_OPS = {
    ">=": lambda a, b: a >= b, ">": lambda a, b: a > b,
    "<=": lambda a, b: a <= b, "<": lambda a, b: a < b,
    "=": lambda a, b: a == b, "==": lambda a, b: a == b, "!=": lambda a, b: a != b,
}


def _check_one(pred: dict, facts: dict) -> dict:
    field = _canon_field(pred.get("field", ""))
    op = pred.get("op", "")
    val = _canon_value(field, pred.get("value"), pred.get("unit")) if field else None
    fact = _fact_value(field, facts) if field else None
    out = {"field": field or pred.get("field"), "op": op, "value": pred.get("value"),
           "unit": pred.get("unit"), "basis": pred.get("basis"), "fact": fact}
    if field is None:
        out["outcome"] = "UNKNOWN"; out["why"] = "condition is not a fact the profile tracks"
    elif fact is None:
        out["outcome"] = "UNKNOWN"; out["why"] = f"profile has no value for {field}"
    elif val is None or op not in _OPS:
        out["outcome"] = "UNKNOWN"; out["why"] = "predicate could not be parsed"
    else:
        out["outcome"] = "TRUE" if _OPS[op](fact, val) else "FALSE"
    return out


def evaluate(predicates: dict, facts: dict) -> dict:
    """
    Roll predicate checks into a verdict refinement:
      NOT_APPLICABLE  an exclusion holds, or a required threshold fails
      APPLICABLE      every applies_if threshold holds (on known facts)
      CONDITIONAL     depends on a fact the profile does not have yet
      NO_CONDITIONS   the rule carries no quantitative condition
    """
    applies = [_check_one(p, facts) for p in predicates.get("applies_if", [])]
    excludes = [_check_one(p, facts) for p in predicates.get("excludes_if", [])]
    if not applies and not excludes:
        return {"result": "NO_CONDITIONS", "checks": [],
                "unquantified": predicates.get("unquantified_conditions", [])}

    checks = ([dict(c, role="applies_if") for c in applies]
              + [dict(c, role="excludes_if") for c in excludes])

    if any(c["outcome"] == "TRUE" for c in excludes):
        result = "NOT_APPLICABLE"
    elif any(c["outcome"] == "FALSE" for c in applies):
        result = "NOT_APPLICABLE"
    elif applies and all(c["outcome"] == "TRUE" for c in applies):
        result = "APPLICABLE"
    elif any(c["outcome"] == "UNKNOWN" for c in checks):
        result = "CONDITIONAL"
    else:
        result = "CONDITIONAL"
    return {"result": result, "checks": checks,
            "unquantified": predicates.get("unquantified_conditions", [])}


# --------------------------------------------------------------------------- #
# Live wiring: extract + store + evaluate for a regulation's rules.            #
# --------------------------------------------------------------------------- #
def _rows(con, sql, args=()):
    cur = con.execute(sql, args) if args else con.execute(sql)
    return [dict(r) if hasattr(r, "keys") else r for r in cur.fetchall()]


def run_for_regulation(con, reg_id: str, facts: dict | None = None, store: bool = True) -> dict:
    if facts is None:
        from . import applicability as A
        facts = A.company_facts(con)
    rules = _rows(con, "SELECT id, entity_type, applicability_rule, source_excerpt "
                       "FROM applicability_rules WHERE regulation_id=?", (reg_id,))
    # Close the read transaction BEFORE the slow LLM calls: a model call can take
    # ~15s, and leaving a transaction open across it trips Postgres'
    # idle_in_transaction_session_timeout and drops the connection.
    try:
        con.commit()
    except Exception:
        pass
    extracted = []
    for rule in rules:
        text = rule.get("applicability_rule") or rule.get("source_excerpt") or ""
        preds = extract(text)                 # LLM — no DB transaction open here
        ev = evaluate(preds, facts)
        extracted.append((rule, text, preds, ev))
    results = []
    for rule, text, preds, ev in extracted:   # fast DB writes, one short transaction
        if store and rule.get("id") is not None:
            con.execute(
                "UPDATE applicability_rules SET thresholds=?, conditions=? WHERE id=?",
                (json.dumps({"applies_if": preds.get("applies_if", []),
                             "excludes_if": preds.get("excludes_if", []),
                             "evaluation": ev, "model": preds.get("_model")}),
                 json.dumps(preds.get("unquantified_conditions", [])),
                 rule["id"]))
        results.append({"rule_id": rule.get("id"), "entity_type": rule.get("entity_type"),
                        "predicates": preds, "evaluation": ev,
                        "text": text[:160]})
    if store:
        con.commit()
    return {"regulation_id": reg_id, "rules": results,
            "facts_used": {k: facts.get(k) for k in ("beds", "turnoverCr", "employees")}}


_SCOPE_KW = ("application", "applicab", "scope", "extent", "commencement",
             "short title", "coverage", "definition", "exempt", "classif",
             "categor", "eligib", "registration")


def _scope_text(con, reg_id: str, max_chars: int = 6500) -> str:
    """
    The fuller text most likely to carry applicability conditions: sections whose
    title names scope/application/definitions/exemptions, falling back to the
    first sections. This is where '≥100 beds', 'turnover exceeding X crore',
    'employing N or more' actually live — not in the short applicability excerpt.
    """
    secs = _rows(con, "SELECT section_number, section_title, section_text "
                      "FROM sections WHERE regulation_id=? ORDER BY rowid", (reg_id,))

    def _fmt(s):
        return (f"[{s.get('section_number') or ''}] {s.get('section_title') or ''}: "
                f"{s.get('section_text') or ''}").strip()

    picked, total = [], 0
    for s in secs:
        if any(k in (s.get("section_title") or "").lower() for k in _SCOPE_KW):
            t = _fmt(s); picked.append(t); total += len(t)
            if total >= max_chars:
                break
    if not picked:                       # nothing scope-titled → the opening sections
        for s in secs[:4]:
            t = _fmt(s); picked.append(t); total += len(t)
            if total >= max_chars:
                break
    return "\n\n".join(picked)[:max_chars]


def wire_and_rescore(con, reg_ids: list[str], facts: dict | None = None,
                     from_sections: bool = True) -> list[dict]:
    """
    End-to-end for a set of regulations: extract predicates from the fuller
    section text → store on the regulation's rules → re-evaluate the (now
    threshold-aware) applicability verdict → write regulations.applicability →
    rescore with impact_v2. Resilient: commits per regulation, skips failures.
    """
    from . import applicability as A, impact_v2 as V2
    if facts is None:
        facts = A.company_facts(con)
    ctx = V2.load_context(con)
    out = []
    for rid in reg_ids:
        try:
            before = _rows(con, "SELECT applicability, impact_score FROM regulations WHERE id=?", (rid,))
            b = before[0] if before else {}
            rule_ids = [r["id"] for r in _rows(
                con, "SELECT id FROM applicability_rules WHERE regulation_id=?", (rid,))
                if r.get("id") is not None]
            text = _scope_text(con, rid) if from_sections else ""
            try:
                con.commit()                      # close read txn before the slow LLM call
            except Exception:
                pass

            if from_sections and text.strip() and rule_ids:
                preds = extract(text)             # ONE LLM call per regulation, on fuller text
                ev0 = evaluate(preds, facts)
                payload_t = json.dumps({"applies_if": preds.get("applies_if", []),
                                        "excludes_if": preds.get("excludes_if", []),
                                        "evaluation": ev0, "model": preds.get("_model"),
                                        "source": "sections"})
                payload_c = json.dumps(preds.get("unquantified_conditions", []))
                # Store on the first rule only — evaluate() reads by regulation_id,
                # so one row is enough and avoids duplicate predicates.
                con.execute("UPDATE applicability_rules SET thresholds=?, conditions=? WHERE id=?",
                            (payload_t, payload_c, rule_ids[0]))
                con.commit()
            elif not from_sections:
                run_for_regulation(con, rid, facts=facts)

            reg = _rows(con, "SELECT * FROM regulations WHERE id=?", (rid,))[0]
            rules = _rows(con, "SELECT id, entity_type, applicability, applicability_rule, "
                               "source_clause, confidence, role FROM applicability_rules "
                               "WHERE regulation_id=?", (rid,))
            ev = A.evaluate(con, reg, rules, facts)
            con.execute("UPDATE regulations SET applicability=? WHERE id=?", (ev["verdict"], rid))
            con.commit()
            sc = V2.compute(con, rid, ctx)
            V2.store(con, rid, sc)
            con.commit()
            out.append({"id": rid,
                        "before_applicability": b.get("applicability"),
                        "after_applicability": ev["verdict"],
                        "before_score": b.get("impact_score"),
                        "after_score": sc["residualScore"],
                        "why": (ev.get("why") or "")[:120]})
            print(f"[{len(out)}/{len(reg_ids)}] {rid}  {b.get('applicability')} -> "
                  f"{ev['verdict']}  score {b.get('impact_score')} -> {sc['residualScore']}",
                  flush=True)
        except Exception as e:
            try:
                con.rollback()
            except Exception:
                pass
            out.append({"id": rid, "error": f"{type(e).__name__}: {str(e)[:120]}"})
            print(f"[{len(out)}/{len(reg_ids)}] {rid}  ERROR {type(e).__name__}: {str(e)[:100]}",
                  flush=True)
    return out
