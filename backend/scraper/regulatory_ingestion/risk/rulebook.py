"""
Load a risk rulebook: read the YAML, merge a sector pack onto the base it
extends, validate every rule, and pin the result by content hash.

Every assessment records `ref` ({name, version, hash, chain}), so a score can
always be traced to the exact rules that produced it, and replayed.
"""
from __future__ import annotations

import copy
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from . import predicates as P

RULEBOOK_DIR = Path(__file__).resolve().parents[2] / "rulebooks"
BANDS = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
GRADES = ("UNKNOWN", "ABSENT", "CLAIMED", "DOCUMENTED", "TESTED")
DIMENSIONS = ("regulatory", "safety", "operational", "financial", "reputational")
CATEGORIES = ("regulatory", "safety", "data", "operational", "financial", "reputational")
SAFETY_CLASSES = ("none", "minor", "moderate", "major", "catastrophic")
EVALUATION_IDS = ("EV-01", "EV-02", "EV-03", "EV-04", "EV-05", "EV-06", "EV-07")
EXPOSURE_KINDS = ("obligation", "template", "event")
# what a theme means when it says nothing: absent is false, never unknown
THEME_DEFAULTS = {"safety_class": "none", "critical_process": False}
_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
# keys whose lists a pack adds to rather than replaces
_LIST_UNION_BY_ID = {"themes"}
_LIST_PREPEND = {"theme_mapping"}


class RulebookError(ValueError):
    pass


@dataclass(frozen=True)
class Rulebook:
    name: str
    version: str
    data: dict
    ref: dict
    themes: dict = field(default_factory=dict)

    # ------------------------------------------------------------ lookups
    @property
    def uncalibrated(self) -> bool:
        return bool(self.data.get("uncalibrated"))

    def theme(self, theme_id: str | None) -> dict | None:
        return self.themes.get(theme_id) if theme_id else None

    def theme_for(self, *, regulator: str | None = None, title: str | None = None,
                  nabh_chapter: str | None = None) -> tuple[str | None, int | None]:
        """(theme id, index of the mapping rule that matched) — first match wins."""
        reg = (regulator or "").strip().lower()
        ttl = (title or "").lower()
        chap = (nabh_chapter or "").strip().upper()
        for i, m in enumerate(self.data.get("theme_mapping") or []):
            if "regulator" in m and reg and m["regulator"].lower() == reg:
                return m["theme"], i
            if "title_matches" in m and ttl and m["title_matches"].lower() in ttl:
                return m["theme"], i
            if "nabh_chapter" in m and chap and m["nabh_chapter"].upper() == chap:
                return m["theme"], i
        return None, None

    def inspection_frequency(self, regulator: str | None) -> str | None:
        table = {k.upper(): v for k, v in (self.data.get("inspection_frequency") or {}).items()}
        return table.get((regulator or "").strip().upper())

    def scale_index(self, metrics: dict | None) -> str | None:
        """high / medium / low from the pack's thresholds; None when the metric is unknown."""
        levels = self.data.get("scale_index") or {}
        if not levels:
            return None
        unknown = False
        for level in ("high", "medium"):
            cond = levels.get(level)
            if not cond:
                continue
            state, _ = P.evaluate(cond, metrics or {})
            if state is True:
                return level
            if state is None:
                unknown = True
        return None if unknown else "low"


# ------------------------------------------------------------------ load
def _read(name: str, directory: Path) -> tuple[dict, bytes]:
    path = directory / f"{name}.yaml"
    if not path.is_file():
        raise RulebookError(f"no rulebook {name!r} in {directory}")
    raw = path.read_bytes()
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        raise RulebookError(f"{path.name}: not a mapping")
    return data, raw


def _merge(base: dict, pack: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in pack.items():
        if key in ("extends",):
            continue
        if key in _LIST_UNION_BY_ID and isinstance(value, list):
            by_id = {t["id"]: t for t in out.get(key) or []}
            for t in value:
                by_id[t["id"]] = t
            out[key] = list(by_id.values())
        elif key in _LIST_PREPEND and isinstance(value, list):
            out[key] = list(value) + list(out.get(key) or [])
        elif isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def load(name: str = "healthcare", directory: Path | str | None = None) -> Rulebook:
    """The named rulebook, merged onto everything it extends, validated and hashed."""
    directory = Path(directory) if directory else RULEBOOK_DIR
    chain: list[tuple[str, dict, bytes]] = []
    seen: set[str] = set()
    cur: str | None = name
    while cur:
        if cur in seen:
            raise RulebookError(f"rulebook cycle at {cur!r}")
        seen.add(cur)
        data, raw = _read(cur, directory)
        _need(bool(_SEMVER.match(str(data.get("version")))), f"{cur}.yaml: version {data.get('version')!r} is not semver")
        _need(data.get("rulebook") == cur, f"{cur}.yaml: names itself {data.get('rulebook')!r}")
        chain.append((cur, data, raw))
        cur = data.get("extends")
    merged: dict = {}
    for _, data, _ in reversed(chain):
        merged = _merge(merged, data) if merged else copy.deepcopy(data)
    top = chain[0][1]
    merged["rulebook"], merged["version"] = top["rulebook"], top["version"]
    merged["uncalibrated"] = bool(top.get("uncalibrated", False))
    validate(merged)
    digest = hashlib.sha256()
    for n, _, raw in reversed(chain):
        digest.update(n.encode() + b"\0" + raw + b"\0")
    ref = {"name": top["rulebook"], "version": top["version"], "hash": "sha256:" + digest.hexdigest(),
           "chain": [f"{n}@{d['version']}" for n, d, _ in reversed(chain)]}
    themes = {t["id"]: {**THEME_DEFAULTS, **t} for t in merged.get("themes") or []}
    return Rulebook(name=top["rulebook"], version=top["version"], data=merged, ref=ref, themes=themes)


# ------------------------------------------------------------------ validate
def _need(cond: bool, msg: str) -> None:
    if not cond:
        raise RulebookError(msg)


def _kinds(rule: dict, where: str) -> None:
    kinds = rule.get("applies_to")
    if kinds is not None:
        _need(isinstance(kinds, list) and kinds and set(kinds) <= set(EXPOSURE_KINDS),
              f"{where}: applies_to must list kinds from {list(EXPOSURE_KINDS)}")


def _score(v: Any, where: str) -> None:
    _need(isinstance(v, int) and 1 <= v <= 5, f"{where}: score must be an integer 1..5, got {v!r}")


def validate(d: dict) -> None:
    """Every structural promise the engine relies on, checked once at load."""
    for k in ("rulebook", "version", "bands", "matrix", "impact", "likelihood", "controls", "confidence", "evaluation"):
        _need(k in d, f"missing top-level key {k!r}")
    _need(bool(_SEMVER.match(str(d["version"]))), f"version {d['version']!r} is not semver")
    _need(tuple(d["bands"]) == BANDS, f"bands must be {list(BANDS)}")
    validate_matrix(d["matrix"], "matrix")

    ids: set[str] = set()

    def _id(rule_id: str, where: str) -> None:
        _need(rule_id not in ids, f"{where}: duplicate rule id {rule_id!r}")
        ids.add(rule_id)

    dims = d["impact"].get("dimensions") or {}
    _need(set(dims) == set(DIMENSIONS), f"impact.dimensions must be exactly {list(DIMENSIONS)}")
    _need(d["impact"].get("aggregate") == "max", "impact.aggregate must be max")
    for name, spec in dims.items():
        where = f"impact.dimensions.{name}"
        if "not_applicable_when" in spec:
            P.validate(spec["not_applicable_when"], f"{where}.not_applicable_when")
        for i, rule in enumerate(spec.get("rules") or []):
            w = f"{where}.rules[{i}]"
            _need("id" in rule and "when" in rule, f"{w}: needs id and when")
            _id(rule["id"], w)
            _kinds(rule, w)
            P.validate(rule["when"], f"{w}.when")
            _need(("score" in rule) != ("score_from" in rule), f"{w}: exactly one of score / score_from")
            if "score" in rule:
                _score(rule["score"], w)
        default = spec.get("default")
        _need(default is not None, f"{where}: needs a default")
        if "score" in default:
            _score(default["score"], f"{where}.default")
        else:
            _need("by" in default and "values" in default and "otherwise" in default,
                  f"{where}.default: needs score, or by + values + otherwise")
            for k, v in default["values"].items():
                _score(v, f"{where}.default.values.{k}")
            _score(default["otherwise"], f"{where}.default.otherwise")

    lik = d["likelihood"]
    base = lik.get("base") or {}
    _need("from" in base and "map" in base and "default" in base, "likelihood.base needs from, map, default")
    for k, v in base["map"].items():
        _score(v, f"likelihood.base.map.{k}")
    if "fallback" in base:
        for k, v in base["fallback"]["map"].items():
            _score(v, f"likelihood.base.fallback.map.{k}")
    _score(base["default"], "likelihood.base.default")
    for i, m in enumerate(lik.get("modifiers") or []):
        w = f"likelihood.modifiers[{i}]"
        _need({"id", "when", "add"} <= m.keys(), f"{w}: needs id, when, add")
        _id(m["id"], w)
        _kinds(m, w)
        P.validate(m["when"], f"{w}.when")
        _need(isinstance(m["add"], int) and -2 <= m["add"] <= 2, f"{w}: add must be an integer -2..2")
    _need(isinstance(lik.get("mandatory"), list), "likelihood.mandatory must be a list of fact paths")

    c = d["controls"]
    _need(tuple(c.get("grades") or ()) == GRADES, f"controls.grades must be {list(GRADES)}")
    for key in ("cap_by_gap_status", "implied_by_gap_status"):
        for status, grade in (c.get(key) or {}).items():
            _need(grade in GRADES, f"controls.{key}.{status}: unknown grade {grade!r}")
    for g in ("TESTED", "DOCUMENTED", "CLAIMED", "ABSENT"):
        _need(g in (c.get("residual_effect") or {}), f"controls.residual_effect needs {g}")
    for step in c.get("freshness") or []:
        _need({"over", "drop"} <= step.keys(), "controls.freshness steps need over and drop")

    pen = d["confidence"].get("penalties") or {}
    for k, v in pen.items():
        _need(isinstance(v, list) and len(v) == 2, f"confidence.penalties.{k}: needs [each, cap]")

    _need([e.get("id") for e in d["evaluation"]] == list(EVALUATION_IDS),
          f"evaluation must list {list(EVALUATION_IDS)} in that order")

    theme_ids = set()
    for t in d.get("themes") or []:
        _need("id" in t and "name" in t, "every theme needs id and name")
        _need(t.get("safety_class", "none") in SAFETY_CLASSES, f"theme {t['id']}: unknown safety_class")
        if "category" in t:
            _need(t["category"] in CATEGORIES, f"theme {t['id']}: unknown category {t['category']!r}")
        theme_ids.add(t["id"])
    for i, m in enumerate(d.get("theme_mapping") or []):
        _need(m.get("theme") in theme_ids, f"theme_mapping[{i}]: unknown theme {m.get('theme')!r}")
        _need(bool({"regulator", "title_matches", "nabh_chapter"} & m.keys()),
              f"theme_mapping[{i}]: needs regulator, title_matches or nabh_chapter")
    for level, cond in (d.get("scale_index") or {}).items():
        _need(level in ("high", "medium"), f"scale_index: unknown level {level!r}")
        P.validate(cond, f"scale_index.{level}")
    for cat, floor in (d.get("nabh_category_floor") or {}).items():
        for dim, v in floor.items():
            _need(dim in DIMENSIONS, f"nabh_category_floor.{cat}: unknown dimension {dim!r}")
            _score(v, f"nabh_category_floor.{cat}.{dim}")


def validate_matrix(matrix: dict, where: str) -> None:
    """A 5×5 band matrix: rows impact 1..5, each a list of 5 bands for likelihood 1..5."""
    _need(isinstance(matrix, dict), f"{where}: must be a mapping")
    rows = {int(k): v for k, v in matrix.items()}
    _need(set(rows) == {1, 2, 3, 4, 5}, f"{where}: needs rows 1..5")
    for i, row in rows.items():
        _need(isinstance(row, list) and len(row) == 5 and all(b in BANDS for b in row),
              f"{where}[{i}]: needs 5 bands from {list(BANDS)}")
