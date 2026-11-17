"""
Structured conditions for the rulebook, evaluated three-valued.

A condition is data, never code: a mapping of fact path → test, all of which
must hold. A fact that was never collected makes its test UNKNOWN (None), not
false, because absence of evidence is not evidence of absence. The engine uses
the unknowns to report what is missing and to compute best / worst bounds.

    {penalty.imprisonment: true}                   equality
    {penalty.max_fine_inr: {gte: 10000000}}        gte gt lte lt eq ne
    {theme.safety_class: {in: [major, catastrophic]}}
    {consequence: {any_of: [licence_suspension]}}  the fact is a list; any overlap
    {template.cia: {contains: availability}}       the fact is a list; contains the value
    {template.seeds.operational: {present: true}}  presence is always known
    {ratio: {num: a.path, den: b.path, gte: 0.01}}
    {any: [cond, cond]}  {all: [cond, cond]}  {not: cond}
"""
from __future__ import annotations

from typing import Any

MISSING = object()
_OPS = {"eq", "ne", "gte", "gt", "lte", "lt", "in", "any_of", "contains", "present"}
_RATIO_OPS = {"gte", "gt", "lte", "lt"}


class PredicateError(ValueError):
    pass


def get(facts: dict, path: str) -> Any:
    """The value at a dotted path, or MISSING. None counts as missing."""
    cur: Any = facts
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return MISSING
        cur = cur[part]
    return MISSING if cur is None else cur


def _norm(v: Any) -> Any:
    return v.lower() if isinstance(v, str) else v


def _compare(op: str, value: Any, arg: Any) -> bool:
    if op == "eq":
        return _norm(value) == _norm(arg)
    if op == "ne":
        return _norm(value) != _norm(arg)
    if op == "in":
        return _norm(value) in {_norm(a) for a in arg}
    if op == "any_of":
        vals = value if isinstance(value, (list, tuple, set)) else [value]
        return bool({_norm(v) for v in vals} & {_norm(a) for a in arg})
    if op == "contains":
        vals = value if isinstance(value, (list, tuple, set)) else [value]
        return _norm(arg) in {_norm(v) for v in vals}
    try:
        a, b = float(value), float(arg)
    except (TypeError, ValueError):
        return False
    return {"gte": a >= b, "gt": a > b, "lte": a <= b, "lt": a < b}[op]


def _test(value: Any, spec: Any) -> bool | None:
    if isinstance(spec, dict):
        if "present" in spec:
            return (value is not MISSING) == bool(spec["present"])
        if value is MISSING:
            return None
        return all(_compare(op, value, arg) for op, arg in spec.items())
    if value is MISSING:
        return None
    return _compare("eq", value, spec)


def _and(states: list[bool | None]) -> bool | None:
    if any(s is False for s in states):
        return False
    return None if any(s is None for s in states) else True


def _or(states: list[bool | None]) -> bool | None:
    if any(s is True for s in states):
        return True
    return None if any(s is None for s in states) else False


def evaluate(cond: dict, facts: dict) -> tuple[bool | None, set[str]]:
    """(True / False / None for unknown, the fact paths whose absence made it unknown)."""
    states: list[bool | None] = []
    missing: set[str] = set()
    for key, spec in cond.items():
        if key in ("any", "all"):
            parts = [evaluate(c, facts) for c in spec]
            state = (_or if key == "any" else _and)([s for s, _ in parts])
            if state is None:
                for s, m in parts:
                    if s is None:
                        missing |= m
            states.append(state)
        elif key == "not":
            s, m = evaluate(spec, facts)
            states.append(None if s is None else not s)
            if s is None:
                missing |= m
        elif key == "ratio":
            num, den = get(facts, spec["num"]), get(facts, spec["den"])
            if num is MISSING or den is MISSING:
                missing |= {p for p, v in ((spec["num"], num), (spec["den"], den)) if v is MISSING}
                states.append(None)
                continue
            try:
                r = float(num) / float(den)
            except (TypeError, ValueError, ZeroDivisionError):
                states.append(False)
                continue
            states.append(all(_compare(op, r, arg) for op, arg in spec.items() if op in _RATIO_OPS))
        else:
            value = get(facts, key)
            s = _test(value, spec)
            if s is None:
                missing.add(key)
            states.append(s)
    state = _and(states) if states else True
    return state, (missing if state is None else set())


def validate(cond: Any, where: str) -> None:
    """Reject a malformed condition at load time, naming where it is."""
    if not isinstance(cond, dict):
        raise PredicateError(f"{where}: a condition must be a mapping, got {type(cond).__name__}")
    for key, spec in cond.items():
        if key in ("any", "all"):
            if not isinstance(spec, list) or not spec:
                raise PredicateError(f"{where}.{key}: needs a non-empty list")
            for i, c in enumerate(spec):
                validate(c, f"{where}.{key}[{i}]")
        elif key == "not":
            validate(spec, f"{where}.not")
        elif key == "ratio":
            if not isinstance(spec, dict) or not {"num", "den"} <= spec.keys() or not (_RATIO_OPS & spec.keys()):
                raise PredicateError(f"{where}.ratio: needs num, den and a comparison")
        elif isinstance(spec, dict):
            bad = set(spec) - _OPS
            if bad or not spec:
                raise PredicateError(f"{where}.{key}: unknown test {sorted(bad) or '{}'}")
            for op in ("in", "any_of"):
                if op in spec and not isinstance(spec[op], list):
                    raise PredicateError(f"{where}.{key}.{op}: needs a list")
        elif isinstance(spec, list):
            raise PredicateError(f"{where}.{key}: a bare list is ambiguous; use in / any_of")
