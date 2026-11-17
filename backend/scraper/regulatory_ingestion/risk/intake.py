"""
What risk scoring needs to know about a company, kept as records a person can
see and correct (design §6, migration 005).

  records       sites, licences, third parties and history, validated by a spec
  attestations  "none of kind K in the last N months", signed by a named person
  appetite      leadership's appetite and tolerance per category (gate G1)
  facts         values read from documents or imports, waiting for a person to
                confirm, correct or reject them (gate G2) before anything uses them
  readiness     which mandatory inputs are present, and what each one unlocks

Works on any DB-API connection whose rows convert with dict() and that takes
`?` placeholders: the Postgres wrapper in production, SQLite in the tests.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from .rulebook import BANDS, CATEGORIES, Rulebook, RulebookError, validate_matrix

HISTORY_KINDS = ("INSPECTION", "OBSERVATION", "CAPA", "INCIDENT", "RECALL", "COMPLAINT",
                 "LITIGATION", "PENALTY", "WARNING_LETTER")
ATTESTABLE = HISTORY_KINDS + ("ALL",)
CRITICALITY = ("Critical", "High", "Medium", "Low")
OUTCOMES = ("clean", "observations", "adverse")
HISTORY_WINDOW_MONTHS = 36
BAND_RANK = {b: i for i, b in enumerate(BANDS)}


class IntakeError(ValueError):
    """A value a person entered that cannot be stored as it is. Shown to them."""


class Conflict(Exception):
    """The record is not in a state that allows this (decided already, retired, …)."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def precise_now() -> str:
    """Valid-time edges: two approvals in the same second must still order."""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _log(con, entity: str, action: str, detail: str, actor: str) -> None:
    con.execute("INSERT INTO audit_events (entity_id,action,actor,detail,at) VALUES (?,?,?,?,?)",
                (entity, action, actor, detail, now()))


# ------------------------------------------------------------------ field checks
def _text(limit: int) -> Callable:
    def f(v: Any, name: str) -> str | None:
        if v is None:
            return None
        s = re.sub(r"[ \t]+", " ", str(v)).strip()
        if len(s) > limit:
            raise IntakeError(f"{name} is longer than {limit} characters")
        return s or None
    return f


def _date(v: Any, name: str) -> str | None:
    if v in (None, ""):
        return None
    try:
        return date.fromisoformat(str(v)[:10]).isoformat()
    except ValueError:
        raise IntakeError(f"{name} must be a date (YYYY-MM-DD), got {v!r}") from None


def _enum(options: tuple) -> Callable:
    def f(v: Any, name: str) -> str | None:
        if v in (None, ""):
            return None
        for o in options:
            if str(v).strip().lower() == o.lower():
                return o
        raise IntakeError(f"{name} must be one of {', '.join(options)}")
    return f


def _flag(v: Any, name: str) -> int | None:
    if v in (None, ""):
        return None
    if isinstance(v, bool):
        return int(v)
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y"):
        return 1
    if s in ("0", "false", "no", "n"):
        return 0
    raise IntakeError(f"{name} must be yes or no")


def _list(v: Any, name: str) -> str | None:
    if v in (None, ""):
        return json.dumps([])
    if isinstance(v, str):
        v = [p for p in re.split(r"[,\n]", v)]
    if not isinstance(v, list):
        raise IntakeError(f"{name} must be a list")
    items = [re.sub(r"\s+", " ", str(x)).strip() for x in v]
    items = [x for x in items if x]
    if any(len(x) > 200 for x in items):
        raise IntakeError(f"an item in {name} is longer than 200 characters")
    return json.dumps(list(dict.fromkeys(items)))


_SCALE_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _scale(v: Any, name: str) -> str | None:
    """{"beds": 250, "ipd_per_year": 12000}: named non-negative numbers."""
    if v in (None, ""):
        return json.dumps({})
    if not isinstance(v, dict):
        raise IntakeError(f"{name} must be named numbers, like beds: 250")
    out = {}
    for k, x in v.items():
        if x in (None, ""):
            continue
        if not _SCALE_KEY.match(str(k)):
            raise IntakeError(f"{name}: {k!r} is not a valid measure name")
        try:
            n = float(str(x).replace(",", ""))
        except ValueError:
            raise IntakeError(f"{name}: {k} must be a number") from None
        if n < 0:
            raise IntakeError(f"{name}: {k} cannot be negative")
        out[str(k)] = int(n) if n == int(n) else n
    return json.dumps(out)


SPECS: dict[str, dict] = {
    "sites": {
        "table": "company_sites", "prefix": "SITE", "required": ("name",),
        "fields": {"name": _text(200), "site_type": _text(80), "address": _text(500), "city": _text(120),
                   "state": _text(120), "scale": _scale, "service_lines": _list},
        "json": ("scale", "service_lines"),
    },
    "licences": {
        "table": "company_licences", "prefix": "LIC", "required": ("kind",), "refs": ("site_id",),
        "fields": {"site_id": _text(40), "kind": _text(200), "issuer": _text(200), "number": _text(120),
                   "valid_from": _date, "valid_until": _date, "conditions": _text(2000), "document_id": _text(80)},
        "json": (),
    },
    "third_parties": {
        "table": "company_third_parties", "prefix": "TP", "required": ("name",),
        "fields": {"name": _text(200), "service": _text(300), "criticality": _enum(CRITICALITY),
                   "personal_data": _flag, "data_shared": _text(500), "contract_ref": _text(200),
                   "contract_until": _date, "alternatives": _text(500), "site_ids": _list},
        "json": ("site_ids",),
    },
    "history": {
        "table": "history_records", "prefix": "HIS", "required": ("kind", "occurred_on", "title"), "refs": ("site_id",),
        "fields": {"kind": _enum(HISTORY_KINDS), "occurred_on": _date, "regulator": _text(120), "site_id": _text(40),
                   "theme": _text(40), "title": _text(300), "description": _text(4000),
                   "severity_as_recorded": _text(80), "outcome": _enum(OUTCOMES),
                   "state": _enum(("OPEN", "CLOSED")), "closed_on": _date, "due_on": _date,
                   "requirement_ids": _list, "action_id": _text(40), "document_id": _text(80)},
        "json": ("requirement_ids",),
    },
}


def _spec(kind: str) -> dict:
    if kind not in SPECS:
        raise IntakeError(f"unknown record kind {kind!r}")
    return SPECS[kind]


def _decode(spec: dict, row: dict) -> dict:
    d = dict(row)
    for k in spec["json"]:
        try:
            d[k] = json.loads(d[k]) if d.get(k) else ([] if k != "scale" else {})
        except (TypeError, ValueError):
            d[k] = [] if k != "scale" else {}
    if "personal_data" in d and d["personal_data"] is not None:
        d["personal_data"] = bool(d["personal_data"])
    return d


def _clean(con, kind: str, data: dict, partial: bool) -> dict:
    spec = _spec(kind)
    unknown = set(data) - set(spec["fields"])
    if unknown:
        raise IntakeError(f"unknown fields: {', '.join(sorted(unknown))}")
    out = {k: fn(data[k], k.replace("_", " ")) for k, fn in spec["fields"].items() if k in data}
    if not partial:
        for k in spec["required"]:
            if not out.get(k):
                raise IntakeError(f"{k.replace('_', ' ')} is required")
    elif any(k in out and not out[k] for k in spec["required"]):
        raise IntakeError(f"{', '.join(spec['required'])} cannot be emptied")
    for ref in spec.get("refs", ()):
        if out.get(ref) and not con.execute(
                "SELECT 1 FROM company_sites WHERE id=? AND retired_at IS NULL", (out[ref],)).fetchone():
            raise IntakeError(f"no current site {out[ref]!r}")
    if kind == "history":
        if out.get("state") == "CLOSED" and "closed_on" in spec["fields"] and not (out.get("closed_on") or partial):
            raise IntakeError("a closed record needs the date it closed")
    return out


# ------------------------------------------------------------------ records
def list_records(con, kind: str, include_retired: bool = False) -> list[dict]:
    spec = _spec(kind)
    where = "" if include_retired else "WHERE retired_at IS NULL"
    order = "occurred_on DESC, created_at DESC" if kind == "history" else "created_at"
    return [_decode(spec, r) for r in con.execute(f"SELECT * FROM {spec['table']} {where} ORDER BY {order}").fetchall()]


def get_record(con, kind: str, rid: str) -> dict | None:
    spec = _spec(kind)
    r = con.execute(f"SELECT * FROM {spec['table']} WHERE id=?", (rid,)).fetchone()
    return _decode(spec, r) if r else None


def create_record(con, kind: str, data: dict, actor: str, *, source: str | None = None,
                  fact_id: str | None = None, commit: bool = True) -> dict:
    spec = _spec(kind)
    clean = _clean(con, kind, data, partial=False)
    if kind == "history":
        clean.setdefault("state", "OPEN")
    rid, ts = new_id(spec["prefix"]), now()
    cols = ["id", *clean, "status", "source", "fact_id", "created_at", "updated_at"]
    vals = [rid, *clean.values(), "CONFIRMED", source or f"entered by {actor}", fact_id, ts, ts]
    con.execute(f"INSERT INTO {spec['table']} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
    _log(con, rid, f"risk intake: {kind} added", clean.get("name") or clean.get("kind") or clean.get("title") or "", actor)
    if commit:
        con.commit()
    return get_record(con, kind, rid)


def update_record(con, kind: str, rid: str, data: dict, actor: str) -> dict:
    spec = _spec(kind)
    cur = get_record(con, kind, rid)
    if not cur:
        raise KeyError(rid)
    if cur.get("retired_at"):
        raise Conflict("this record was removed; add it again instead")
    clean = _clean(con, kind, data, partial=True)
    if not clean:
        return cur
    sets = ", ".join(f"{k}=?" for k in clean)
    con.execute(f"UPDATE {spec['table']} SET {sets}, updated_at=? WHERE id=?", [*clean.values(), now(), rid])
    _log(con, rid, f"risk intake: {kind} changed", ", ".join(sorted(clean)), actor)
    con.commit()
    return get_record(con, kind, rid)


def retire_record(con, kind: str, rid: str, actor: str) -> dict:
    spec = _spec(kind)
    cur = get_record(con, kind, rid)
    if not cur:
        raise KeyError(rid)
    if cur.get("retired_at"):
        return cur
    con.execute(f"UPDATE {spec['table']} SET retired_at=?, updated_at=? WHERE id=?", (now(), now(), rid))
    _log(con, rid, f"risk intake: {kind} removed", "", actor)
    con.commit()
    return get_record(con, kind, rid)


# ------------------------------------------------------------------ attestations
def attestations(con) -> list[dict]:
    return [dict(r) for r in con.execute(
        "SELECT * FROM history_attestations WHERE superseded_at IS NULL ORDER BY kind, attested_on DESC").fetchall()]


def _months_ago(d: date, months: int) -> date:
    return d - timedelta(days=round(months * 30.44))


def attest(con, *, kind: str, months: int, name: str, designation: str, actor: str,
           actor_user_id: str | None = None, site_id: str | None = None, statement: str | None = None,
           document_id: str | None = None, attested_on: str | None = None) -> dict:
    """Record that there were none of `kind` in the last `months` months. Refused when records say otherwise."""
    kind = _enum(ATTESTABLE)(kind, "kind")
    if not kind:
        raise IntakeError("kind is required")
    try:
        months = int(months)
    except (TypeError, ValueError):
        raise IntakeError("months must be a whole number") from None
    if not 1 <= months <= 120:
        raise IntakeError("months must be between 1 and 120")
    name, designation = _text(200)(name, "name"), _text(200)(designation, "designation")
    if not name or not designation:
        raise IntakeError("the person attesting and their designation are required")
    on = _date(attested_on, "attested on") or date.today().isoformat()
    if site_id and not con.execute("SELECT 1 FROM company_sites WHERE id=? AND retired_at IS NULL", (site_id,)).fetchone():
        raise IntakeError(f"no current site {site_id!r}")
    since = _months_ago(date.fromisoformat(on), months).isoformat()
    kinds = HISTORY_KINDS if kind == "ALL" else (kind,)
    q = (f"SELECT id, kind, occurred_on, title FROM history_records WHERE retired_at IS NULL AND status='CONFIRMED' "
         f"AND occurred_on >= ? AND kind IN ({','.join('?' * len(kinds))})")
    params: list[Any] = [since, *kinds]
    if site_id:
        q += " AND (site_id=? OR site_id IS NULL)"
        params.append(site_id)
    clash = [dict(r) for r in con.execute(q, params).fetchall()]
    if clash:
        first = clash[0]
        raise Conflict(f"{len(clash)} recorded {kind.lower().replace('_', ' ')} item(s) in that window contradict it, "
                       f"e.g. {first['kind'].lower()} on {first['occurred_on']}: {first['title']}")
    ts = now()
    cond, cp = ("site_id=?", [site_id]) if site_id else ("site_id IS NULL", [])
    con.execute(f"UPDATE history_attestations SET superseded_at=? WHERE kind=? AND {cond} AND superseded_at IS NULL",
                [ts, kind, *cp])
    aid = new_id("ATT")
    words = "any history" if kind == "ALL" else kind.lower().replace("_", " ") + "s"
    con.execute("""INSERT INTO history_attestations (id, kind, months, site_id, statement, attested_by_user,
                     attested_by_name, designation, attested_on, document_id, recorded_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (aid, kind, months, site_id, _text(1000)(statement, "statement") or
                 f"No {words} in the {months} months to {on}.", actor_user_id, name, designation, on, document_id, ts))
    _log(con, aid, "risk intake: attestation", f"{kind} · {months} months · {name}, {designation}", actor)
    con.commit()
    return dict(con.execute("SELECT * FROM history_attestations WHERE id=?", (aid,)).fetchone())


def history_coverage(con, as_of: date | None = None) -> dict[str, dict]:
    """Per kind: 'records' (confirmed records in the window), 'attested', or None (neither: unknown)."""
    as_of = as_of or date.today()
    since = _months_ago(as_of, HISTORY_WINDOW_MONTHS).isoformat()
    counts = {r["kind"]: r["n"] for r in (dict(x) for x in con.execute(
        "SELECT kind, COUNT(*) AS n FROM history_records WHERE retired_at IS NULL AND status='CONFIRMED' "
        "AND occurred_on >= ? GROUP BY kind", (since,)).fetchall())}
    att = {}
    for a in attestations(con):
        if a["site_id"] is None and a["months"] >= HISTORY_WINDOW_MONTHS:
            att.setdefault(a["kind"], a)
    out = {}
    for k in HISTORY_KINDS:
        if counts.get(k):
            out[k] = {"status": "records", "count": counts[k]}
        elif k in att or "ALL" in att:
            a = att.get(k) or att["ALL"]
            out[k] = {"status": "attested", "by": a["attested_by_name"], "on": a["attested_on"], "months": a["months"]}
        else:
            out[k] = {"status": None}
    return out


# ------------------------------------------------------------------ appetite (gate G1)
def default_appetite() -> dict:
    return {
        "categories": {c: {"appetite": "MEDIUM", "tolerance": "HIGH", "zero_tolerance": False} for c in CATEGORIES},
        "confidence_threshold": 60,
        "review_cadence_days": {"CRITICAL": 30, "HIGH": 90, "MEDIUM": 180, "LOW": 365},
        "escalation_to": "",
        "matrix": None,
    }


def validate_appetite(content: dict) -> dict:
    if not isinstance(content, dict):
        raise IntakeError("appetite must be a set of answers")
    cats = content.get("categories") or {}
    if set(cats) != set(CATEGORIES):
        raise IntakeError(f"set appetite for every category: {', '.join(CATEGORIES)}")
    clean_cats = {}
    for c, v in cats.items():
        a, t = str(v.get("appetite", "")).upper(), str(v.get("tolerance", "")).upper()
        if a not in BAND_RANK or t not in BAND_RANK:
            raise IntakeError(f"{c}: appetite and tolerance must be one of {', '.join(BANDS)}")
        if BAND_RANK[t] < BAND_RANK[a]:
            raise IntakeError(f"{c}: tolerance cannot be below appetite")
        clean_cats[c] = {"appetite": a, "tolerance": t, "zero_tolerance": bool(v.get("zero_tolerance"))}
    try:
        threshold = int(content.get("confidence_threshold", 60))
    except (TypeError, ValueError):
        raise IntakeError("the confidence threshold must be a number") from None
    if not 0 <= threshold <= 100:
        raise IntakeError("the confidence threshold must be between 0 and 100")
    cadence = {}
    for b in BANDS:
        try:
            days = int((content.get("review_cadence_days") or {}).get(b, default_appetite()["review_cadence_days"][b]))
        except (TypeError, ValueError):
            raise IntakeError(f"review cadence for {b} must be a number of days") from None
        if not 1 <= days <= 730:
            raise IntakeError(f"review cadence for {b} must be between 1 and 730 days")
        cadence[b] = days
    matrix = content.get("matrix")
    if matrix:
        try:
            validate_matrix(matrix, "matrix")
        except RulebookError as e:
            raise IntakeError(str(e)) from None
        matrix = {int(k): list(v) for k, v in matrix.items()}
    return {"categories": clean_cats, "confidence_threshold": threshold, "review_cadence_days": cadence,
            "escalation_to": _text(300)(content.get("escalation_to"), "escalation to") or "", "matrix": matrix or None}


def _appetite_row(r) -> dict:
    d = dict(r)
    d["content"] = json.loads(d["content"])
    return d


def appetite_state(con) -> dict:
    rows = [_appetite_row(r) for r in con.execute("SELECT * FROM risk_appetite ORDER BY version DESC").fetchall()]
    approved = next((r for r in rows if r["status"] == "APPROVED"), None)
    draft = next((r for r in rows if r["status"] in ("DRAFT", "RETURNED")), None)
    return {"approved": approved, "draft": draft,
            "history": [r for r in rows if r["status"] in ("APPROVED", "SUPERSEDED")],
            "default": default_appetite()}


def save_draft(con, content: dict, actor: str) -> dict:
    clean = validate_appetite(content)
    st = appetite_state(con)
    if st["draft"]:
        con.execute("UPDATE risk_appetite SET content=?, status='DRAFT', recorded_at=? WHERE id=?",
                    (json.dumps(clean), now(), st["draft"]["id"]))
        did = st["draft"]["id"]
    else:
        version = 1 + max([0] + [r["version"] for r in st["history"]])
        did = new_id("APP")
        con.execute("""INSERT INTO risk_appetite (id, version, status, content, created_by, recorded_at)
                       VALUES (?,?,?,?,?,?)""", (did, version, "DRAFT", json.dumps(clean), actor, now()))
    _log(con, did, "risk appetite: draft saved", "", actor)
    con.commit()
    return appetite_state(con)


def approve_appetite(con, *, actor: str, actor_user_id: str | None, approver_name: str, designation: str,
                     minutes_document_id: str | None = None, note: str | None = None) -> dict:
    st = appetite_state(con)
    draft = st["draft"]
    if not draft or draft["status"] != "DRAFT":
        raise Conflict("there is no draft waiting for approval")
    approver_name, designation = _text(200)(approver_name, "name"), _text(200)(designation, "designation")
    if not approver_name or not designation:
        raise IntakeError("the approver's name and designation are required")
    ts = precise_now()
    if st["approved"]:
        con.execute("UPDATE risk_appetite SET status='SUPERSEDED', valid_to=? WHERE id=?", (ts, st["approved"]["id"]))
    con.execute("""UPDATE risk_appetite SET status='APPROVED', approved_by_user=?, approver_name=?,
                     approver_designation=?, minutes_document_id=?, note=?, valid_from=? WHERE id=?""",
                (actor_user_id, approver_name, designation, minutes_document_id, _text(2000)(note, "note"), ts,
                 draft["id"]))
    _log(con, draft["id"], f"risk appetite v{draft['version']} approved", f"{approver_name}, {designation}", actor)
    con.commit()
    return appetite_state(con)


def return_appetite(con, *, actor: str, note: str) -> dict:
    st = appetite_state(con)
    if not st["draft"] or st["draft"]["status"] != "DRAFT":
        raise Conflict("there is no draft waiting for approval")
    note = _text(2000)(note, "note")
    if not note:
        raise IntakeError("say what needs to change")
    con.execute("UPDATE risk_appetite SET status='RETURNED', note=? WHERE id=?", (note, st["draft"]["id"]))
    _log(con, st["draft"]["id"], "risk appetite: returned", note, actor)
    con.commit()
    return appetite_state(con)


def appetite_for_engine(con, as_of: str | None = None) -> dict | None:
    """The approved appetite in force on `as_of` (default: now), shaped for engine.assess."""
    at = as_of or precise_now()
    rows = [_appetite_row(r) for r in con.execute(
        "SELECT * FROM risk_appetite WHERE status IN ('APPROVED','SUPERSEDED') AND valid_from <= ? "
        "AND (valid_to IS NULL OR valid_to > ?) ORDER BY version DESC", (at, at)).fetchall()]
    if not rows:
        return None
    r = rows[0]
    out = {"status": "APPROVED", "version": r["version"], **r["content"]}
    if out.get("matrix"):
        out["matrix"] = {int(k): v for k, v in out["matrix"].items()}     # JSON keeps keys as text
    else:
        out.pop("matrix", None)
    return out


# ------------------------------------------------------------------ who may govern
def can_govern(con, user: dict | None) -> bool:
    if not user:
        return False
    if user.get("role") == "admin":
        return True
    return bool(con.execute("SELECT 1 FROM risk_governors WHERE user_id=? AND revoked_at IS NULL",
                            (user.get("id"),)).fetchone())


def governors(con) -> list[dict]:
    return [dict(r) for r in con.execute(
        "SELECT * FROM risk_governors WHERE revoked_at IS NULL ORDER BY granted_at").fetchall()]


def grant_governor(con, user_id: str, designation: str | None, actor: str) -> list[dict]:
    if not user_id:
        raise IntakeError("choose a person")
    con.execute("DELETE FROM risk_governors WHERE user_id=?", (user_id,))
    con.execute("INSERT INTO risk_governors (user_id, designation, granted_by, granted_at) VALUES (?,?,?,?)",
                (user_id, _text(200)(designation, "designation"), actor, now()))
    _log(con, user_id, "risk appetite: may approve", designation or "", actor)
    con.commit()
    return governors(con)


def revoke_governor(con, user_id: str, actor: str) -> list[dict]:
    con.execute("UPDATE risk_governors SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (now(), user_id))
    _log(con, user_id, "risk appetite: may no longer approve", "", actor)
    con.commit()
    return governors(con)


# ------------------------------------------------------------------ facts (gate G2)
FACT_TARGETS = {"site": "sites", "licence": "licences", "third_party": "third_parties", "history": "history"}
FACT_KEYS = tuple(FACT_TARGETS) + ("profile.beds",)


def propose_fact(con, *, fact_key: str, value: dict, dedupe_key: str, extracted_by: str,
                 confidence: int | None = None, citations: list[dict] | None = None, commit: bool = True) -> str | None:
    """A fact read from a document or an import. Proposed once; nothing uses it until a person decides."""
    if fact_key not in FACT_KEYS:
        raise IntakeError(f"unknown fact {fact_key!r}")
    if con.execute("SELECT 1 FROM extracted_facts WHERE dedupe_key=?", (dedupe_key,)).fetchone():
        return None
    fid = new_id("FACT")
    con.execute("""INSERT INTO extracted_facts (id, fact_key, dedupe_key, value, extracted_by, confidence, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (fid, fact_key, dedupe_key, json.dumps(value), extracted_by, confidence, now()))
    for c in citations or []:
        con.execute("""INSERT INTO fact_citations (id, fact_id, document_id, file_name, page, section, quote)
                       VALUES (?,?,?,?,?,?,?)""",
                    (new_id("CIT"), fid, c.get("document_id"), c.get("file_name"), c.get("page"),
                     c.get("section"), (c.get("quote") or "")[:1000] or None))
    if commit:
        con.commit()
    return fid


def list_facts(con, status: str | None = "PROPOSED") -> list[dict]:
    q, params = "SELECT * FROM extracted_facts", []
    if status:
        q += " WHERE status=?"
        params.append(status)
    rows = [dict(r) for r in con.execute(q + " ORDER BY created_at", params).fetchall()]
    for r in rows:
        r["value"] = json.loads(r["value"])
        r["corrected_value"] = json.loads(r["corrected_value"]) if r.get("corrected_value") else None
        r["citations"] = [dict(c) for c in con.execute(
            "SELECT document_id, file_name, page, section, quote FROM fact_citations WHERE fact_id=? ORDER BY page",
            (r["id"],)).fetchall()]
    return rows


def decide_fact(con, fact_id: str, decision: str, actor: str, *, value: dict | None = None,
                note: str | None = None) -> dict:
    row = con.execute("SELECT * FROM extracted_facts WHERE id=?", (fact_id,)).fetchone()
    if not row:
        raise KeyError(fact_id)
    f = dict(row)
    if f["status"] != "PROPOSED":
        raise Conflict(f"this fact was already {f['status'].lower()}")
    decision = (decision or "").lower()
    note = _text(2000)(note, "note")
    ts = now()
    if decision == "reject":
        if not note:
            raise IntakeError("say why it is wrong")
        con.execute("UPDATE extracted_facts SET status='REJECTED', note=?, decided_by=?, decided_at=? WHERE id=?",
                    (note, actor, ts, fact_id))
        _log(con, fact_id, "fact rejected", note, actor)
        con.commit()
        return list_facts_one(con, fact_id)
    if decision not in ("confirm", "correct"):
        raise IntakeError("decision must be confirm, correct or reject")
    original = json.loads(f["value"])
    final = value if decision == "correct" else original
    if decision == "correct" and not isinstance(value, dict):
        raise IntakeError("a correction needs the corrected value")
    source = f"confirmed from {f['extracted_by']}" if decision == "confirm" else f"corrected from {f['extracted_by']}"
    if f["fact_key"] == "profile.beds":
        beds = _scale({"beds": (final or {}).get("beds")}, "beds")
        n = json.loads(beds).get("beds")
        if n is None:
            raise IntakeError("beds must be a number")
        con.execute("UPDATE company_profile SET beds=?", (int(n),))
        target_table, target_id = "company_profile", "1"
    else:
        rec = create_record(con, FACT_TARGETS[f["fact_key"]], final, actor, source=source, fact_id=fact_id, commit=False)
        target_table, target_id = SPECS[FACT_TARGETS[f["fact_key"]]]["table"], rec["id"]
    status = "CONFIRMED" if decision == "confirm" else "CORRECTED"
    con.execute("""UPDATE extracted_facts SET status=?, corrected_value=?, note=?, target_table=?, target_id=?,
                     decided_by=?, decided_at=? WHERE id=?""",
                (status, json.dumps(final) if decision == "correct" else None, note, target_table, target_id,
                 actor, ts, fact_id))
    _log(con, fact_id, f"fact {status.lower()}", f"{f['fact_key']} → {target_table} {target_id}", actor)
    con.commit()
    return list_facts_one(con, fact_id)


def list_facts_one(con, fact_id: str) -> dict:
    return next(f for f in list_facts(con, None) if f["id"] == fact_id)


def _attrs(v: Any) -> dict:
    if isinstance(v, dict):
        return v
    try:
        return json.loads(v) if v else {}
    except (TypeError, ValueError):
        return {}


_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct",
                                       "nov", "dec"], 1)}


def _loose_date(v: Any) -> str | None:
    """'2027-03-31', '31/03/2027' or 'Mar 2027' (→ last day of the month); 'Perpetual' and the rest → None."""
    s = str(v or "").strip()
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError:
        pass
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            return None
    m = re.match(r"^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$", s)
    if m and m.group(1).lower() in _MONTHS:
        y, mo = int(m.group(2)), _MONTHS[m.group(1).lower()]
        nxt = date(y + (mo == 12), mo % 12 + 1, 1)
        return (nxt - timedelta(days=1)).isoformat()
    return None


def propose_from_records(con) -> dict:
    """Rule-based proposals from what onboarding already holds (spreadsheet sections, licence records).

    Each becomes a PROPOSED fact citing where it came from; a site or licence a
    person already entered with the same name is not proposed again.
    """
    have_sites = {(r["name"] or "").lower() for r in list_records(con, "sites", include_retired=True)}
    have_lic = {((r["kind"] or "").lower(), (r["number"] or "").lower())
                for r in list_records(con, "licences", include_retired=True)}
    proposed = skipped = 0
    rows = [dict(r) for r in con.execute(
        "SELECT id, type, name, description, attrs, source FROM company_entities "
        "WHERE lower(type) IN ('location','business_activity','license','licence')").fetchall()]
    for e in rows:
        a, t = _attrs(e.get("attrs")), (e.get("type") or "").lower()
        cite = [{"document_id": None, "file_name": e.get("source") or "Onboarding import",
                 "section": "Locations" if t == "location" else "Business activities & licences",
                 "quote": " — ".join(x for x in (e.get("name"), e.get("description")) if x)}]
        if t == "location":
            if (e.get("name") or "").lower() in have_sites:
                skipped += 1
                continue
            value = {"name": e.get("name"), "site_type": a.get("locationType"), "state": a.get("state")}
            fid = propose_fact(con, fact_key="site", value={k: v for k, v in value.items() if v},
                               dedupe_key=f"entity:{e['id']}:site", extracted_by="import:onboarding",
                               confidence=70, citations=cite, commit=False)
        else:
            kind = a.get("licence") or (e.get("name") if t in ("license", "licence") else None)
            if not kind:
                skipped += 1
                continue
            number = a.get("licenceNo") or a.get("number") or a.get("licenseNumber")
            if (kind.lower(), (number or "").lower()) in have_lic:
                skipped += 1
                continue
            value = {"kind": kind, "issuer": a.get("regulator") or a.get("issuer"), "number": number,
                     "valid_until": _loose_date(a.get("validTill") or a.get("expiryDate") or a.get("valid_until"))}
            fid = propose_fact(con, fact_key="licence", value={k: v for k, v in value.items() if v},
                               dedupe_key=f"entity:{e['id']}:licence", extracted_by="import:onboarding",
                               confidence=70, citations=cite, commit=False)
        if fid:
            proposed += 1
        else:
            skipped += 1
    prof = con.execute("SELECT beds, derived_from FROM company_profile ORDER BY id LIMIT 1").fetchone()
    if prof:
        p = dict(prof)
        ev = _attrs(p.get("derived_from")).get("beds") or {}
        if p.get("beds") is None and ev.get("evidence"):
            m = re.search(r"([\d,]{1,6})\s*beds", ev["evidence"], re.I)
            if m:
                fid = propose_fact(con, fact_key="profile.beds", value={"beds": int(m.group(1).replace(",", ""))},
                                   dedupe_key=f"profile:beds:{m.group(1)}", extracted_by="rule:derive_company_profile",
                                   confidence=80, citations=[{"file_name": ev.get("file"), "quote": ev["evidence"]}],
                                   commit=False)
                proposed += bool(fid)
    con.commit()
    return {"proposed": proposed, "skipped": skipped}


# ------------------------------------------------------------------ readiness
HEALTHCARE_WORDS = re.compile(r"hospital|health|clinic|diagnostic|nursing home|medical|patholog|dental|ayush", re.I)


def pack_for(profile: dict | None) -> str:
    """Which sector pack scores this company. The base alone when no pack fits (it still scores everything)."""
    p = profile or {}
    text = " ".join([str(p.get("entity_type") or "")] + [str(s) for s in (p.get("sectors") or [])])
    return "healthcare" if HEALTHCARE_WORDS.search(text) else "base"


def readiness(con, rb: Rulebook, as_of: date | None = None) -> dict:
    """The mandatory inputs scoring needs, which are present, and what each one unlocks."""
    sites = list_records(con, "sites")
    scaled = [s for s in sites if rb.scale_index(s.get("scale")) is not None]
    coverage = history_coverage(con, as_of)
    open_kinds = [k for k, v in coverage.items() if v["status"] is None]
    app = appetite_state(con)
    pending = con.execute("SELECT COUNT(*) AS n FROM extracted_facts WHERE status='PROPOSED'").fetchone()
    pending_n = dict(pending)["n"] if pending else 0
    metric = ", ".join(sorted({k for lvl in (rb.data.get("scale_index") or {}).values() for k in lvl})) or None
    items = [
        {"key": "sites", "mandatory": True, "done": bool(sites), "count": len(sites),
         "unlocks": "exposure.sites — likelihood grows with the number of sites"},
        {"key": "scale", "mandatory": True, "done": bool(sites) and len(scaled) == len(sites),
         "count": len(scaled), "of": len(sites), "metric": metric,
         "unlocks": "exposure.scale_index — likelihood grows with size"},
        {"key": "history", "mandatory": True, "done": not open_kinds, "missing": open_kinds,
         "unlocks": "history.status — without records or an attestation, nothing can be scored"},
        {"key": "appetite", "mandatory": True, "done": bool(app["approved"]),
         "version": app["approved"]["version"] if app["approved"] else None,
         "draft": app["draft"]["status"] if app["draft"] else None,
         "unlocks": "the verdict — scores are shown, but nothing is judged against appetite until it is approved"},
        {"key": "licences", "mandatory": False, "done": bool(list_records(con, "licences")),
         "count": len(list_records(con, "licences")),
         "unlocks": "operational impact of duties that guard a licence"},
        {"key": "third_parties", "mandatory": False, "done": bool(list_records(con, "third_parties")),
         "count": len(list_records(con, "third_parties")),
         "unlocks": "third-party risks from the library, one per vendor"},
        {"key": "facts", "mandatory": False, "done": pending_n == 0, "count": pending_n,
         "unlocks": "values read from documents count only once a person confirms them"},
    ]
    return {"pack": rb.ref["name"], "items": items, "history": coverage,
            "ready": all(i["done"] for i in items if i["mandatory"])}
