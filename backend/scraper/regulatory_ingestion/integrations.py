"""
Integrations — pulling company facts out of the systems a customer already runs.

Onboarding has three ways in, and this is the third:

    1. Guided form   a human types the records
    2. File upload   a human drops CSVs / PDFs
    3. Integration   we connect to their system and collect it ourselves   <- here

The catalogue below is a capability list (which systems we can talk to and what
each one actually contributes). It is NOT business data — connecting nothing
still yields zero entities. Nothing here fabricates a connection, a record count
or a sync: a connection is only ever "connected" after a real call to the real
system succeeded, and every entity written carries source='integration:<id>'
plus the source_reference it came from.

Credentials: secrets are write-only over the API — they go in and are never read
back out. They are stored in the SQLite file, so that file is as sensitive as the
credentials in it. A production deployment should point SECRET_BACKEND at a real
secret manager rather than the DB.
"""
from __future__ import annotations

import base64
import csv
import io
import json
import os
import socket
import ipaddress
import urllib.parse
import hashlib
import pathlib
import re
import secrets
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS integrations (
  id            TEXT PRIMARY KEY,
  connector     TEXT NOT NULL,          -- catalogue id, e.g. 'folder'
  label         TEXT NOT NULL,          -- what the customer called this connection
  config        TEXT NOT NULL DEFAULT '{}',   -- non-secret settings (folder path, base url, …)
  secret        TEXT,                   -- write-only; never returned by the API
  status        TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
  status_detail TEXT,
  last_tested_at TEXT,
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_syncs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  outcome        TEXT,                  -- OK | FAILED | PARTIAL
  detail         TEXT,
  items_seen     INTEGER DEFAULT 0,
  entities_written INTEGER DEFAULT 0,
  documents_written INTEGER DEFAULT 0,
  skipped        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_isync_int ON integration_syncs(integration_id);


-- one row per external object we have seen, so a re-sync updates instead of duplicating
CREATE TABLE IF NOT EXISTS integration_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_id    TEXT NOT NULL,         -- path, row key, or remote object id
  entity_id      TEXT,
  content_hash   TEXT,
  last_seen_at   TEXT,
  UNIQUE (integration_id, external_id)
);
"""

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- catalogue
# `domains` is the honest answer to "what does connecting this actually give me?".
# A CRM does not give you your whole company — it gives you customer data assets
# and the systems that hold them.
CATALOGUE = [
    # Two ways in, both working with no server-side setup. Five more connectors
    # used to sit beside these — Google Drive, SharePoint, Salesforce, AWS, Jira.
    # Two needed an OAuth client this deployment never had and three were never
    # built, so all five rendered as cards that could only explain why they did
    # not work. Removed rather than kept as promises.
    {"id": "folder", "name": "Local or mounted folder", "category": "Files",
     "auth": "path", "ready": True,
     "domains": ["policies", "evidence", "processes"],
     "gives": "Every document in a directory — including a Google Drive, OneDrive or Dropbox folder synced to this machine, or a mounted network share. Give it a collection context in your own words and the documents are read against it: owners, vendors, policies, processes, controls, risks and their relationships are extracted and filed by what they are.",
     "needs": "A readable path on the server."},
    {"id": "http_csv", "name": "API endpoint", "category": "API",
     "auth": "token", "ready": True,
     "domains": ["people", "processes", "systems", "data", "policies", "controls", "risks", "evidence"],
     "gives": "Pull records from any system that exposes an API returning JSON or CSV — an HR system, an asset register, a risk or policy tool. Each record is placed by its own type, and everything collected is filed under the collection context you give it.",
     "needs": "The API's URL and, if it needs one, a token or API key."},
]

BY_ID = {c["id"]: c for c in CATALOGUE}


def runtime_catalogue() -> list[dict]:
    """
    The catalogue as it stands on this deployment.

    Both remaining connectors need no server-side configuration, so `ready` is
    simply what CATALOGUE says. This used to consult the Google and Microsoft
    OAuth settings; those connectors are gone.
    """
    return [dict(entry) for entry in CATALOGUE]


def is_ready(connector: str) -> bool:
    """Runtime readiness for one connector."""
    for c in runtime_catalogue():
        if c["id"] == connector:
            return bool(c["ready"])
    return False


_CONSTRAINTS_READY = False


def init(con: sqlite3.Connection) -> sqlite3.Connection:
    con.executescript(SCHEMA)
    _ensure_constraints(con)
    con.commit()
    return con


def _ensure_constraints(con) -> None:
    """
    Add constraints that CREATE TABLE IF NOT EXISTS cannot retrofit.

    A table created by an earlier version of the schema keeps the shape it was
    created with — IF NOT EXISTS skips the whole statement, constraints
    included. integration_records was already present without its
    UNIQUE(integration_id, external_id), so the ON CONFLICT in _write had
    nothing to match and every collection failed with "no unique or exclusion
    constraint matching the ON CONFLICT specification".
    """
    global _CONSTRAINTS_READY
    if _CONSTRAINTS_READY:
        return
    try:
        con.execute("""
            ALTER TABLE integration_records
            ADD CONSTRAINT integration_records_int_ext_key
            UNIQUE (integration_id, external_id)
        """)
        con.commit()
    except Exception:
        # Already present, or an engine without ADD CONSTRAINT. Either way the
        # next statement decides whether it worked; this must never block init.
        try:
            con.rollback()
        except Exception:
            pass
    _CONSTRAINTS_READY = True


# ---------------------------------------------------------------- connections
def add(con, *, connector: str, label: str, config: dict, secret: str | None) -> dict:
    if connector not in BY_ID:
        raise ValueError(f"unknown connector {connector!r}")
    # Whole-second timestamps alone collided: two connections created inside the
    # same second produced the same primary key, which an OAuth flow makes easy
    # to hit because every Connect click creates a row. The suffix removes the
    # race without changing the readable shape of the id.
    iid = (f"int-{connector}-{int(datetime.now(timezone.utc).timestamp())}"
           f"-{secrets.token_hex(3)}")
    con.execute(
        """INSERT INTO integrations (id, connector, label, config, secret, status, created_at, updated_at)
           VALUES (?,?,?,?,?, 'NOT_CONNECTED', ?, ?)""",
        (iid, connector, label, json.dumps(config), secret, _now(), _now()))
    con.commit()
    return get(con, iid)


def get(con, iid: str) -> dict | None:
    r = con.execute("SELECT * FROM integrations WHERE id=?", (iid,)).fetchone()
    return _public(r) if r else None


def listing(con) -> list[dict]:
    return [_public(r) for r in con.execute("SELECT * FROM integrations ORDER BY created_at")]


def _public(r) -> dict:
    """Never returns `secret`. A credential that went in does not come back out."""
    d = dict(r)
    d["config"] = json.loads(d.get("config") or "{}")
    d["has_secret"] = bool(d.pop("secret", None))
    d["connector_name"] = BY_ID.get(d["connector"], {}).get("name", d["connector"])
    return d


def remove(con, iid: str) -> None:
    con.execute("DELETE FROM integration_records WHERE integration_id=?", (iid,))
    con.execute("DELETE FROM integration_syncs  WHERE integration_id=?", (iid,))
    con.execute("DELETE FROM integrations WHERE id=?", (iid,))
    con.commit()


def _set_status(con, iid: str, status: str, detail: str) -> None:
    con.execute(
        "UPDATE integrations SET status=?, status_detail=?, last_tested_at=?, updated_at=? WHERE id=?",
        (status, detail, _now(), _now(), iid))
    con.commit()


# ---------------------------------------------------------------- test
def test(con, iid: str) -> dict:
    """
    Reach the real system and report what actually happened.

    There is no optimistic path: a connector we cannot exercise reports
    NEEDS_CREDENTIALS, and a failure reports the real error text.
    """
    row = con.execute("SELECT * FROM integrations WHERE id=?", (iid,)).fetchone()
    if not row:
        raise ValueError("no such integration")
    cat = BY_ID.get(row["connector"])
    if not cat:
        # The catalogue can change under a stored connection. Reporting that
        # plainly beats a KeyError five frames down.
        _set_status(con, iid, "FAILED",
                    f"The '{row['connector']}' connector is no longer available in "
                    f"this build. Remove this connection.")
        return get(con, iid)
    cfg = json.loads(row["config"] or "{}")

    if not is_ready(row["connector"]):
        _set_status(con, iid, "NEEDS_CREDENTIALS",
                    f"{cat['name']} needs: {cat['needs']} It is not available in this build.")
        return get(con, iid)

    try:
        if cat["auth"] == "path":
            p = pathlib.Path(cfg.get("path", "")).expanduser()
            if not p.exists():
                raise FileNotFoundError(f"{p} does not exist")
            if not p.is_dir():
                raise NotADirectoryError(f"{p} is not a directory")
            n = sum(1 for _ in p.rglob("*") if _.is_file())
            _set_status(con, iid, "CONNECTED", f"Readable. {n} file(s) visible under {p}.")
        else:
            body, ctype = _http(cfg.get("url", ""), row["secret"], cfg)
            _set_status(con, iid, "CONNECTED",
                        f"HTTP 200, {len(body)} bytes, content-type {ctype or 'unknown'}.")
    except Exception as e:                                  # report, never swallow
        _set_status(con, iid, "FAILED", f"{type(e).__name__}: {e}")
    return get(con, iid)


# How a credential is presented. Bearer covers a lot, but not enough: Okta wants
# "SSWS <token>", Jira wants Basic, Notion wants Bearer plus a version header, and
# plenty of internal APIs want their own header entirely. Supporting the scheme
# rather than one hardcoded prefix is what makes the generic connector generic.
AUTH_SCHEMES = {
    "bearer": "Authorization: Bearer <token>",
    "basic":  "Authorization: Basic base64(<token>) — give the token as user:password",
    "prefix": "Authorization: <prefix> <token> — for schemes like SSWS or token",
    "header": "<header name>: <token> — for APIs that do not use Authorization",
    "none":   "No credential sent",
}

# A header name is a token per RFC 9110; anything outside this cannot be one, and
# refusing early is what stops a newline in a name or value from splitting the
# request into two.
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


def _clean_header(name: str, value: str) -> tuple[str, str] | None:
    """One custom header, or None if it cannot safely be sent."""
    name = (name or "").strip()
    value = (value or "").strip()
    if not name or not _HEADER_NAME.match(name):
        return None
    if any(c in value for c in ("\r", "\n", "\x00")):
        return None
    return name, value


def _auth_header(scheme: str, token: str, cfg: dict) -> tuple[str, str] | None:
    """Build the credential header for the configured scheme."""
    if not token or scheme == "none":
        return None
    if scheme == "basic":
        # Callers give "user:password". Encoding a token with no colon still
        # produces a valid header, which some APIs accept, so it is not refused.
        return "Authorization", "Basic " + base64.b64encode(token.encode()).decode()
    if scheme == "prefix":
        prefix = (cfg.get("auth_prefix") or "").strip()
        if not prefix:
            raise ValueError("auth_scheme 'prefix' needs auth_prefix (for example SSWS)")
        return "Authorization", f"{prefix} {token}"
    if scheme == "header":
        name = (cfg.get("auth_header") or "").strip()
        if not name:
            raise ValueError("auth_scheme 'header' needs auth_header (for example X-API-Key)")
        cleaned = _clean_header(name, token)
        if not cleaned:
            raise ValueError(f"{name!r} is not a usable header name")
        return cleaned
    return "Authorization", f"Bearer {token}"        # default


class NotPublicURL(ValueError):
    """An address this server must not fetch from."""


LOCAL_ADVICE = ("that address points at this server itself, not at the system you want to "
                "collect from. Use the address the other side gives you for reaching it from "
                "outside its own network — usually https://something.their-domain.")


def local_fetch_allowed() -> bool:
    """
    True only where Company Brain runs on the same machine as the system it
    collects from — a laptop with the partner app on localhost:4200.

    There, "localhost" is the right answer and refusing it would block the one
    setup that works. On the public server it is the wrong answer, so the switch
    is off unless the environment turns it on, and the deployment never does.
    """
    return os.environ.get("CONNECTORS_ALLOW_LOCAL", "").strip().lower() in ("1", "true", "yes")


def check_public_url(url: str, *, resolve: bool = True) -> None:
    """
    Refuse addresses that point back inside this machine or a private network.

    Two reasons, and the first is the one people hit. A partner's note says
    "GET http://localhost:4200/…" because it was written on their own server;
    pasted here, localhost means OUR server, the test fails with a bare
    "connection refused", and the partner's key is sent to whatever happens to
    listen on that port on this box. The second is that a fetcher which will
    request any URL can be aimed at this host's own services — the database,
    the observability stack, the cloud metadata address — and that is not a
    thing a connector form should be able to do.

    Called when a connection is saved (so the mistake is caught on the form) and
    again before every fetch (so a DNS change after saving cannot route around it).
    """
    u = urllib.parse.urlsplit((url or "").strip())
    if u.scheme not in ("http", "https") or not u.hostname:
        raise NotPublicURL("Enter the full address, starting with https://")
    if local_fetch_allowed():
        return
    host = u.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise NotPublicURL(f"{host}: {LOCAL_ADVICE}")

    def refuse(ip: ipaddress._BaseAddress) -> bool:
        return (ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved
                or ip.is_unspecified or ip.is_multicast)

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if refuse(literal):
            raise NotPublicURL(f"{host}: {LOCAL_ADVICE}")
        return
    if not resolve:
        return
    try:
        infos = socket.getaddrinfo(host, u.port or (443 if u.scheme == "https" else 80))
    except socket.gaierror:
        return      # an unknown name fails on its own at fetch time, with its own message
    for info in infos:
        if refuse(ipaddress.ip_address(info[4][0])):
            raise NotPublicURL(f"{host} resolves to {info[4][0]}: {LOCAL_ADVICE}")


def _http(url: str, token: str | None, cfg: dict | None = None) -> tuple[bytes, str]:
    if not url:
        raise ValueError("no url configured")
    check_public_url(url)
    cfg = cfg or {}
    req = urllib.request.Request(url, headers={"User-Agent": "company-brain/1.0"})

    auth = _auth_header((cfg.get("auth_scheme") or "bearer").lower(), token or "", cfg)
    if auth:
        req.add_header(*auth)

    # Extra headers are config, not secrets, so they are readable back — an API
    # version or Accept header is not a credential and hiding it helps nobody.
    for k, v in (cfg.get("headers") or {}).items():
        cleaned = _clean_header(str(k), str(v))
        if cleaned:
            req.add_header(*cleaned)

    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read(), r.headers.get("content-type", "")


# ---------------------------------------------------------------- column mapping
# Header names customers actually use, mapped to Company Brain fields. Anything
# unmatched is kept in attrs rather than dropped — losing a column silently is
# how an import ends up looking complete when it isn't.
FIELD_ALIASES = {
    "name":        ["name", "title", "full name", "employee name", "system name", "policy name", "process name"],
    "description": ["description", "desc", "purpose", "summary", "details", "notes"],
    "owner":       ["owner", "owner name", "responsible", "accountable", "manager", "process owner"],
    # entity_type first: it is the importer's canonical column, so it must beat a
    # generic 'category' column that happens to be an exact alias. Losing that
    # race silently retyped a licence row as a legal entity.
    "type":        ["entity_type", "entitytype", "record_type", "type", "category",
                    "kind", "classification"],
    "criticality": ["criticality", "severity", "importance", "priority", "risk rating", "tier"],
    "status":      ["status", "state", "lifecycle"],
    "department":  ["department", "dept", "team", "business unit", "function"],
    "email":       ["email", "e-mail", "email address"],
    "reference":   ["id", "ref", "reference", "code", "employee id", "asset id"],
}
_ID_LIKE = {"id", "ref", "reference", "code", "employee id", "asset id"}


def _header_words(h: str) -> str:
    """
    A header reduced to its words: 'full_name', 'Full-Name' and 'fullName' all
    read as 'full name'.

    Only lowercasing was not enough. A header written with an underscore could
    never match an alias exactly, so 'full_name' scored as a loose hit on
    'name', tied with 'job_title' scoring a loose hit on 'title', and the tie
    was settled by how the headers happened to be spelled. That is how every
    employee in a 413-row directory ended up named by their job title.
    """
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", h.strip())
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s.lower()).split())


# The aliases go through the same reduction, so 'entity_type' keeps matching a
# header called entity_type exactly and does not lose the type race to a
# generic 'category' column.
_ALIASES = {f: [_header_words(a) for a in al] for f, al in FIELD_ALIASES.items()}
_ID_WORDS = {_header_words(a) for a in _ID_LIKE}


def map_columns(headers: list[str]) -> dict[str, str]:
    """
    Score every (field, header) pair and assign best-first, so a sheet with both
    'Policy Ref' and 'Policy Name' does not let the ref column win `name`.

    Three tiers, because how a header uses an alias says what it means:
    the header IS the alias ('full name'), the header ENDS with it as whole
    words ('employee full name' — still a name), or it merely contains it
    ('job title' is a title, not the name; 'exit status' is not the status).
    Ties break on the feed's own column order, never on spelling.
    """
    norm = {h: _header_words(h) for h in headers}
    order = {h: i for i, h in enumerate(headers)}
    scored: list[tuple[int, int, str, str]] = []
    for field, aliases in _ALIASES.items():
        for h, hl in norm.items():
            if field == "name" and hl in _ID_WORDS:
                continue                      # an id column is never the display name
            words = hl.split()
            if hl in aliases:
                score = 100 - aliases.index(hl)
            else:
                hit = next((a for a in aliases if a in hl), None)
                if hit is None:
                    continue
                whole = hit.split()
                tail = words[-len(whole):] == whole
                score = (70 if tail else 40) - aliases.index(hit)
            scored.append((-score, order[h], field, h))
    scored.sort()
    out, used_f, used_h = {}, set(), set()
    for _, _, field, h in scored:
        if field in used_f or h in used_h:
            continue
        out[field] = h
        used_f.add(field); used_h.add(h)
    return out


# Columns that are a credential whatever the source calls them. A feed that
# carries one (a user export with a password hash, a token column) must not
# leave it in our database: it is never useful here and it is a liability.
# Anything else unmapped is kept — dropping real data silently is worse.
CREDENTIAL_COLUMN = re.compile(
    r"^(password|passwd|pwd|pass|secret|token|api[_\- ]?key|apikey|private[_\- ]?key|"
    r"access[_\- ]?key|client[_\- ]?secret|otp|pin|cvv|cvc|card[_\- ]?number)$", re.I)


# Data about a person rather than about the post they hold. A staff register is
# read by colleagues, so it carries who someone is and where they work — never a
# phone number, an email address, a birth date or a staff number. Matched on the
# header's own words, exactly, so 'invoice number' and 'department' are untouched.
_PERSONAL_EXACT = {
    "email", "e mail", "email address", "work email", "personal email", "official email",
    "phone", "phone number", "mobile", "mobile phone", "mobile number", "mobile no",
    "telephone", "landline", "contact number", "contact no", "whatsapp",
    "emergency contact", "emergency contact number", "emergency contact no",
    "date of birth", "dob", "birth date", "birthday",
    "gender", "sex", "marital status", "blood group",
    "aadhaar", "aadhar", "aadhaar number", "aadhar number", "pan", "pan number",
    "passport number", "personal address", "residential address", "home address",
    "employee number", "employee no", "employee code", "employee id", "staff id",
    "staff number", "staff code", "emp no", "emp id", "emp code",
    "punch id", "biometric id", "reporting manager number", "manager number",
    "manager id", "manager employee number", "bank account", "bank account number",
    "account number", "ifsc", "uan", "esic number", "pf number",
}
# The same thing with a qualifier in front: 'personal mobile', 'work phone'.
_PERSONAL_TAIL = ("email", "e mail", "phone", "mobile", "date of birth", "birth date",
                  "aadhaar", "aadhar")


def is_personal(header: str) -> bool:
    """Is this column about the person, not the job?"""
    hl = _header_words(header)
    if hl in _PERSONAL_EXACT:
        return True
    words = hl.split()
    return any(words[-len(t.split()):] == t.split() for t in _PERSONAL_TAIL)


def drop_personal(rows: list[dict], keep: set) -> list[dict]:
    """
    The same rows without their personal columns.

    `keep` holds columns the import cannot lose: the one records are filed by and
    the source's own identifier. A staff number that IS the record's id stays,
    because keying 413 people by name silently merges the four who share one.
    """
    return [{k: v for k, v in r.items() if k in keep or not is_personal(k)} for r in rows]


def _text(v) -> str:
    """
    One incoming cell as display text.

    csv.DictReader hands every value over as a string, so treating cells as
    strings was safe while files were the only source. Real JSON is not so
    tidy: ids are ints, flags are bools, absent fields are null, and nested
    objects are dicts — and calling .strip() on any of those raised, which took
    down the one connector marked ready for arbitrary endpoints.

    A dict or list is not a display value, so it returns "" and the raw value
    survives in attrs instead of being stringified into a name.
    """
    if v is None or isinstance(v, (dict, list)):
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return v.strip()
    return str(v).strip()


def rows_to_entities(rows: list[dict], domain: str, source: str, ref_prefix: str,
                     key_prefix: str | None = None) -> list[dict]:
    """
    Turn parsed rows into Company Brain entities. Unmapped columns survive in attrs.

    Records are keyed by name, which merges the same person arriving from two
    files. An API feed passes `key_prefix` instead, and each record is keyed by
    its OWN id: an equipment register holds forty units all called "Infusion
    Pump", and keying those by name kept one and silently dropped thirty-nine.
    """
    if not rows:
        return []
    m = map_columns(list(rows[0].keys()))
    # Only these mapped fields land in a real company_entities column. Anything
    # else the mapper matched (department, email, owner…) has nowhere to be
    # stored, so it MUST fall through to attrs — a column that is recognised but
    # then dropped is the worst outcome: the import looks complete and isn't.
    stored = {m.get(f) for f in _STORED_FIELDS}
    out = []
    for i, row in enumerate(rows):
        name = _text(row.get(m.get("name", "")))
        if not name:
            continue                          # a record with no name is not a record
        extra = {attr_key(k): v for k, v in row.items()
                 if k not in stored and v not in (None, "") and not CREDENTIAL_COLUMN.match(str(k).strip())}
        own_ref = _text(row.get(m.get("reference", ""))) if m.get("reference") else ""
        ref = own_ref or f"{ref_prefix}#{i + 2}"
        source_keyed = bool(key_prefix and own_ref)
        out.append({
            "id": (f"{domain[:3]}-{key_prefix}-{_slug(own_ref)}" if source_keyed
                   else f"{domain[:3]}-{_slug(name)}"),
            # The id IS the source's own identity. _write must not trade it for
            # an existing record that merely shares the name.
            "sourceKeyed": source_keyed,
            "domain": domain,
            "name": name,
            "type": _text(row.get(m.get("type", ""))) or DOMAIN_TYPE.get(domain),
            "description": _text(row.get(m.get("description", ""))) or None,
            "criticality": _text(row.get(m.get("criticality", ""))) or None,
            "status": _text(row.get(m.get("status", ""))) or None,
            "attrs": extra,
            "provenance": {"source": source, "sourceReference": ref},
        })
    return out


_STORED_FIELDS = ("name", "type", "description", "criticality", "status", "reference")


def feed_layout(rows: list[dict], m: dict[str, str]) -> list[list[str]]:
    """
    A feed's own columns, in its own order, each paired with the key the UI
    reads it by: [["status", "status"], ["criticality", "priority"],
    ["attr.entryDate", "entry_date"], ...].

    A register should read like the source's own page — Entry date, Supplier,
    Invoice no, Amount — not like our storage. Status and priority are kept in
    columns of their own here, and without this their place in the source's
    layout, and the source's word for them ("priority", not "criticality"),
    would be lost. `m` is the mapping rows_to_entities used, so the keys agree.

    A key absent from the first row (a sparse JSON feed drops nulls) is placed
    after the key it follows in the row that has it, not at the end.
    """
    headers: list[str] = []
    for r in rows[:500]:
        at = -1
        for k in r:
            if k in headers:
                at = headers.index(k)
            else:
                at += 1
                headers.insert(at, k)
    stored = {h: f for f, h in m.items() if f in _STORED_FIELDS}
    return [[stored.get(h) or f"attr.{attr_key(h)}", h] for h in headers]


def attr_key(header: str) -> str:
    """
    'Last Reviewed' -> 'lastReviewed'.

    The UI's column config addresses attrs by camelCase key, so a collected
    column stored under its raw spreadsheet caption would sit in the record
    unreachable — present in the data, blank in every table.
    """
    parts = [p for p in "".join(c if c.isalnum() else " " for c in header).split() if p]
    if not parts:
        return header
    return parts[0].lower() + "".join(p[:1].upper() + p[1:].lower() for p in parts[1:])


def _slug(s: str) -> str:
    keep = "".join(c if c.isalnum() else "-" for c in s.lower())
    return "-".join(p for p in keep.split("-") if p)[:60]


def _parse(body: bytes, ctype: str, name: str) -> list[dict]:
    """CSV or JSON in, list of dicts out. Anything else raises rather than guessing."""
    text = body.decode("utf-8", errors="replace").lstrip("﻿")
    if "json" in (ctype or "") or name.endswith(".json") or text.lstrip()[:1] in "[{":
        data = json.loads(text)
        if isinstance(data, dict):
            for key in ("items", "records", "results", "data", "value"):
                if isinstance(data.get(key), list):
                    data = data[key]; break
            else:
                # Any other wrapper — {"equipment": [...], "total": 312} — is a
                # list of records under a name we did not predict. Taking the one
                # list of objects is right; wrapping the whole envelope as a
                # single "record" produced one entity called nothing.
                lists = [v for v in data.values()
                         if isinstance(v, list) and v and all(isinstance(x, dict) for x in v)]
                data = lists[0] if len(lists) == 1 else [data]
        return [r for r in data if isinstance(r, dict)]
    sample = text[:4096]
    try:
        delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delim = ","
    return list(csv.DictReader(io.StringIO(text), delimiter=delim))


# ---------------------------------------------------------------- sync
DOMAIN_HINTS = {
    "people": ["people", "employee", "staff", "headcount", "person", "hr", "directory"],
    "processes": ["process", "procedure", "workflow", "sop"],
    "systems": ["system", "application", "app", "asset", "server", "service", "infra"],
    "data": ["data", "dataset", "database", "pii", "record"],
    "policies": ["policy", "policies", "standard", "charter"],
    "controls": ["control", "safeguard", "check"],
    "risks": ["risk", "issue", "threat"],
    "evidence": ["evidence", "artefact", "artifact", "proof", "log", "report"],
    # A file called 11-legal-entities.csv or locations.xlsx should land somewhere
    # sensible rather than being skipped as unplaceable.
    "overview": ["legal-entit", "legal entit", "subsidiar", "location", "site",
                 "jurisdiction", "product", "offering", "business-activit",
                 "business activit", "licence", "license", "industr"],
}

# Within the overview domain the display type decides which tab a record appears
# on, so it is inferred from the filename rather than defaulted.
OVERVIEW_TYPE_HINTS = {
    "Legal Entity": ["legal-entit", "legal entit", "subsidiar", "entities"],
    "Location": ["location", "site", "office", "premises"],
    "Jurisdiction": ["jurisdiction"],
    "Product": ["product", "offering"],
    "Business Activity": ["business-activit", "business activit", "activit"],
    "License": ["licence", "license", "registration"],
    "Industry": ["industr", "sector"],
}


# A row that declares its own entity_type must be believed. The filename is only
# a fallback for rows that say nothing — a mixed file (activities plus the
# licence they are held under) would otherwise be flattened to one wrong type.
OVERVIEW_TYPE_ALIASES = {
    "legal_entity": "Legal Entity", "legalentity": "Legal Entity", "entity": "Legal Entity",
    "location": "Location", "site": "Location", "jurisdiction": "Jurisdiction",
    "product": "Product", "offering": "Product",
    "business_activity": "Business Activity", "activity": "Business Activity",
    "licence": "License", "license": "License", "registration": "License",
    "industry": "Industry", "sector": "Industry", "org_unit": "Org Unit",
}


def overview_type_for(filename: str, default: str = "Legal Entity") -> str:
    low = filename.lower()
    for t, words in OVERVIEW_TYPE_HINTS.items():
        if any(w in low for w in words):
            return t
    return default


def normalise_overview_type(raw: str | None, filename: str) -> str:
    """Row's own type wins; the filename decides only when the row is silent."""
    key = (raw or "").strip().lower().replace(" ", "_").replace("-", "_")
    if key in OVERVIEW_TYPE_ALIASES:
        return OVERVIEW_TYPE_ALIASES[key]
    if raw and raw.strip().title() in OVERVIEW_TYPE_HINTS:
        return raw.strip().title()
    return overview_type_for(filename)
# Each domain's records carry a Title Case singular type. The UI's sub-tabs
# filter on it, so a collected record left untyped is counted in the domain
# total but missing from every table in it.
DOMAIN_TYPE = {
    "people": "Person", "processes": "Process", "systems": "System",
    "data": "Data Asset", "policies": "Policy", "controls": "Control",
    "risks": "Risk", "evidence": "Evidence",
    # company context — the Overview tabs filter on these exact strings
    "overview": "Legal Entity",
}

# A record that says what it is decides where it goes. The Title Case types come
# from DOMAIN_TYPE; the rest are the words real exports actually use.
_TYPE_DOMAIN = {v.lower(): k for k, v in DOMAIN_TYPE.items() if k != "overview"}
_TYPE_DOMAIN.update({
    "person": "people", "employee": "people", "staff": "people", "user": "people",
    "department": "people", "team": "people",
    "process": "processes", "procedure": "processes", "sop": "processes", "workflow": "processes",
    "system": "systems", "application": "systems", "app": "systems", "asset": "systems",
    "vendor": "systems", "supplier": "systems",
    # An equipment register is an asset register. A hospital's partner API labels
    # every record "equipment", and without these the whole register was skipped.
    "equipment": "systems", "medical equipment": "systems", "device": "systems",
    "medical device": "systems", "instrument": "systems", "machine": "systems",
    "data asset": "data", "dataset": "data", "database": "data",
    "policy": "policies", "standard": "policies",
    "control": "controls", "risk": "risks",
    "evidence": "evidence", "record": "evidence", "report": "evidence", "log": "evidence",
    # A hospital's operational registers are evidence that its controls run:
    # every breakdown call, invoice handed over, ward walked and spare issued.
    "complaint": "evidence", "service record": "evidence", "service call": "evidence",
    "breakdown": "evidence", "invoice": "evidence", "walkthrough check": "evidence",
    "walk through check": "evidence", "inspection": "evidence", "material issue": "evidence",
    "legal entity": "overview", "location": "overview", "product": "overview",
    "business activity": "overview", "license": "overview", "licence": "overview",
    "industry": "overview",
})


def domain_of_row(row: dict, type_col: str | None) -> str | None:
    """The domain a record's own type field names, or None when it names none."""
    if not type_col:
        return None
    key = re.sub(r"[_\-]+", " ", _text(row.get(type_col))).strip().lower()
    return _TYPE_DOMAIN.get(key)


def common_dir(files) -> tuple[str, ...]:
    """
    The deepest folder every one of `files` sits inside.

    A person named in an ICU SOP and in a Radiology SOP belongs to the level
    above both departments, not to whichever file happened to be read first.
    """
    dirs = [pathlib.PurePosixPath(f).parent.parts for f in files if f]
    out: list[str] = []
    for level in zip(*dirs):
        if all(p == level[0] for p in level):
            out.append(level[0])
        else:
            break
    return tuple(out)


# Fields that group records into the company's own units, most specific first.
# A department is a better home than a building, and a building than a category.
GROUP_FIELDS = ["department", "dept", "division", "business unit", "unit", "ward",
                "section", "location", "site", "facility", "block", "floor",
                "category", "group", "team"]


_ELSEWHERE = re.compile(r"^(reports? to|reporting|manager|managers|parent|previous|former|old|prior|transferred)\b")


def grouping_field(rows: list[dict], exclude: str | None = None) -> str | None:
    """
    The field an API's records are best grouped by, or None.

    Only a field that genuinely GROUPS qualifies: at least two distinct values,
    and far fewer values than records. A field unique to each record — a serial
    number, a room — would turn a register into a thousand one-item nodes, and a
    field with one value groups nothing.
    """
    if len(rows) < 2:
        return None
    headers = [h for h in rows[0].keys() if h != exclude]
    norm = {h: re.sub(r"[_\-]+", " ", h).strip().lower() for h in headers}
    # A field about SOMEONE ELSE's place — reports_to_department, the
    # manager's unit, a previous ward — must never file a record: every
    # person would land in their manager's department.
    norm = {h: n for h, n in norm.items() if not _ELSEWHERE.match(n)}
    ceiling = min(100, max(2, len(rows) // 2))
    for want in GROUP_FIELDS:
        for h, n in norm.items():
            if n == want or n.startswith(want + " ") or n.endswith(" " + want):
                values = {_text(r.get(h)) for r in rows} - {""}
                if 2 <= len(values) <= ceiling:
                    return h
    return None


DOC_EXT = {".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".md", ".txt"}
ROW_EXT = {".csv", ".tsv", ".json"}


def domain_for(filename: str, default: str | None = None) -> str | None:
    low = filename.lower()
    for dom, words in DOMAIN_HINTS.items():
        if any(w in low for w in words):
            return dom
    return default


def _propose_profile(con, base) -> str:
    """
    Propose a company profile from the documents this sync just collected.

    Applicability is computed against company facts — entity type, sectors,
    licences, state. With no profile row there are no facts, so every verdict
    is unreachable and the product shows nothing. The documents that answer
    "who is this company" are the ones the user has just handed us, so reading
    them here saves retyping an identity that is already on page one of their
    own file.

    Nothing this writes is authoritative. The profile is UNVERIFIED, every
    field cites the file it came from, an existing profile is never touched,
    and a folder with no evidenced legal name produces no profile at all. A
    failure is reported in the sync detail and never raised: the collection
    itself succeeded, and must not be marked FAILED because of this.
    """
    try:
        if con.execute("SELECT COUNT(*) FROM company_profile").fetchone()[0]:
            return ""                    # already answered; do not repeat it
        import sys
        root = str(pathlib.Path(__file__).resolve().parent.parent)
        if root not in sys.path:
            sys.path.insert(0, root)
        import derive_company_profile as D
        facts = D.derive(base)
        facts.pop("_files_examined", None)
        _created, why = D.write_profile(con, facts)
        return f" Company profile: {why}."
    except Exception as e:  # noqa: BLE001 — a failed proposal is not a failed sync
        return f" Company profile could not be derived ({type(e).__name__}: {e})."


def sync(con, iid: str, company_db) -> dict:
    """
    Collect from the connected system and write into the Company Brain.

    Everything written carries source='integration:<connector>' and the
    source_reference it came from, so any record can be traced back to the file
    or row it was collected from. A connector that is not connected does not
    sync — it returns the reason instead of an empty success.
    """
    row = con.execute("SELECT * FROM integrations WHERE id=?", (iid,)).fetchone()
    if not row:
        raise ValueError("no such integration")
    cfg = json.loads(row["config"] or "{}")
    started = _now()
    cur = con.execute(
        "INSERT INTO integration_syncs (integration_id, started_at) VALUES (?,?)", (iid, started))
    run = cur.lastrowid
    con.commit()

    # The run row is created BEFORE this check on purpose: _finish records the
    # outcome against a run, so a failure reported without one would write to
    # id=NULL, match nothing, and then raise on the read-back.
    cat = BY_ID.get(row["connector"])
    if not cat:
        return _finish(con, run, iid, "FAILED",
                       f"The '{row['connector']}' connector is no longer available "
                       f"in this build. Remove this connection.", 0, 0, 0, 0)

    if row["status"] != "CONNECTED":
        return _finish(con, run, iid, "FAILED",
                       f"Not connected ({row['status']}). Test the connection first.", 0, 0, 0, 0)

    source = f"integration:{row['connector']}"
    seen = written = docs = skipped = 0
    mined_note = ""
    folder_base = None          # set by the path branch; drives the profile proposal
    memory = None               # the structure nodes this connection made, by id
    layouts = None              # each register's own columns, by record type (feed_layout)
    # SAME connection: company tables live in this very file, and opening a
    # second one deadlocks against the write transaction we already hold.
    ccon = company_db.init(con)
    try:
        if cat["auth"] == "path":
            base = folder_base = pathlib.Path(cfg.get("path", "")).expanduser()
            # rglob on a missing directory yields nothing rather than raising, so
            # a folder that has been moved, unmounted or deleted used to report a
            # clean run over zero files — a successful collection of nothing,
            # which is the most misleading outcome available.
            if not base.is_dir():
                return _finish(con, run, iid, "FAILED",
                               f"{base} is no longer readable. The folder may have been "
                               f"moved, deleted, or unmounted.", 0, 0, 0, 0)
            # A COLLECTION CONTEXT REPLACES THE DOMAIN DROPDOWN.
            #
            # The old question was "which domain does this folder populate?",
            # and a real folder does not answer it: "Biomedical Department"
            # holds the equipment register, the calibration SOP, the AMC
            # contracts, the radiation-safety policy and the people who own
            # each. Choosing "policies" filed four of those five wrongly and
            # mined none of them — every document became one empty record
            # named after its file.
            #
            # With a context set, documents are READ instead, and the domain
            # follows from what each record turns out to be. Registers keep
            # going through the row parser: a risk register is a table whose
            # rows are already records, and reading it as prose would collapse
            # two hundred risks into one document called "Risk Register".
            context = (cfg.get("collection_context") or "").strip()
            doc_files: set[str] = set()
            # DOCUMENTS GO TO INTAKE. Policies, SOPs, forms, manuals, scans and
            # zips are read, split, typed and placed in their department by
            # doc_intake, in the background; this run only hands them over.
            # Spreadsheets stay here: a register's rows are records already.
            # "document_intake": false in the config restores the older reader.
            from . import doc_intake as DI
            intake_on = cfg.get("document_intake", True) is not False
            intake_ext = DI.INTAKE_EXT - {".xlsx", ".xlsm"}
            intake_files: list[str] = []
            # The context names a place in the company's own structure, so it
            # resolves to a node ONCE per run and every record collected carries
            # it. Without this the context is a string in attrs that nothing can
            # navigate by — the Company Brain would still be arranged by the
            # eleven fixed domains it was arranged by before.
            node_id = None
            from . import taxonomy as TX
            TX.init(ccon)
            actor = f"integration:{row['connector']}"
            memory = TX.Remembered(ccon, cfg.get("nodes"))
            if context:
                node_id = memory.node(f"home:{TX._norm(context)}",
                                      lambda: TX.resolve_context(ccon, context, actor=actor))

            # THE FOLDER TREE IS THE STRUCTURE.
            #
            # Every subfolder becomes a node, named cleanly ("17_Job_Descriptions"
            # -> "Job Descriptions"), nested as it is on disk, beneath the
            # collection's own node. A folder that holds the whole upload IS the
            # collection when a context names it, so it is not repeated as a
            # level of its own.
            files = [f for f in sorted(base.rglob("*")) if f.is_file() and not f.name.startswith(".")]
            rels = [pathlib.PurePosixPath(str(f.relative_to(base))) for f in files]
            tops = {r.parts[0] for r in rels if len(r.parts) > 1}
            drop_top = bool(context) and len(tops) == 1 and all(len(r.parts) > 1 for r in rels)
            node_cache: dict[tuple, str | None] = {}

            def node_for_dirs(dirs: tuple[str, ...]) -> str | None:
                if drop_top and dirs:
                    dirs = dirs[1:]
                return _dir_node(tuple(dirs))

            # One level at a time, each remembered: a folder node the user has
            # renamed keeps receiving its own subfolders instead of a second
            # copy of the old name growing beside it.
            def _dir_node(dirs: tuple[str, ...]) -> str | None:
                if not dirs:
                    return node_id
                if dirs not in node_cache:
                    parent = _dir_node(dirs[:-1])
                    node_cache[dirs] = memory.node(
                        "dir:" + "/".join(dirs),
                        lambda: TX.ensure_path(
                            ccon, [TX.folder_label(dirs[-1])], parent_id=parent,
                            kind="Folder", source=f"the folder {base.name}", actor=actor))
                return node_cache[dirs]

            for f in files:
                seen += 1
                ext, rel = f.suffix.lower(), str(f.relative_to(base))
                if intake_on and ext in intake_ext:
                    # before the folder node: intake files a document by its
                    # department, so a folder holding only documents needs none
                    intake_files.append(rel)
                    continue
                here = node_for_dirs(pathlib.PurePosixPath(rel).parent.parts)
                if ext in ROW_EXT:
                    # Without a dropdown the domain comes from the file, then
                    # the context, and only then gives up.
                    dom = domain_for(f.name) or (domain_for(context) if context else None) \
                        or cfg.get("default_domain")
                    if not dom:
                        skipped += 1
                        continue
                    file_rows = _parse(f.read_bytes(), "", f.name)
                    if dom == "people" and file_rows:
                        file_rows = drop_personal(
                            file_rows, {map_columns(list(file_rows[0].keys())).get("reference")})
                    ents = rows_to_entities(file_rows, dom, source, rel)
                    if dom == "overview":
                        for e in ents:
                            e["type"] = normalise_overview_type(e.get("type"), f.name)
                    for e in ents:
                        if context:
                            e.setdefault("attrs", {})["collectionContext"] = context
                        e["orgNodeId"] = here
                    written += _write(con, ccon, company_db, iid, ents, rel)
                elif ext in DOC_EXT:
                    if context:
                        doc_files.add(rel)          # read together, below
                        continue
                    dom = domain_for(f.name, cfg.get("default_domain"))
                    if not dom:
                        skipped += 1
                        continue
                    ent = [{
                        "id": f"{dom[:3]}-{_slug(f.stem)}", "domain": dom, "name": f.stem,
                        "type": DOMAIN_TYPE.get(dom), "description": f"Collected from {rel}",
                        "provenance": {"source": source, "sourceReference": rel},
                        "attrs": {"file": rel, "format": ext.lstrip("."), "bytes": f.stat().st_size},
                        "orgNodeId": here,
                    }]
                    docs += _write(con, ccon, company_db, iid, ent, rel)
                else:
                    skipped += 1

            if doc_files:
                # One pass over the documents, so a person named in six files is
                # one record carrying six pieces of evidence rather than six
                # records nobody can reconcile.
                from . import content_extract as CX
                result = CX.analyse(base, context=context, include=doc_files)
                mined = CX.to_entities(result, source)
                # to_entities keeps the order of result["records"], so each mined
                # entity is paired with its full evidence, not the first twelve.
                for rec, e in zip(result["records"], mined):
                    e["orgNodeId"] = node_for_dirs(common_dir(ev.file for ev in rec.evidence))
                docs += _write(con, ccon, company_db, iid, mined, context or "documents")
                skipped += result["files_unreadable"]
                for r in CX.to_relationships(result, mined):
                    try:
                        company_db.add_relationship(ccon, r)
                    except Exception:      # noqa: BLE001 — a duplicate edge is not a failed sync
                        pass
                mined_note = (" Read " + ", ".join(
                    f"{n} {k}" for k, n in sorted(result["by_kind"].items())) + ".")
            if intake_files:
                bid = DI.start(root=str(base), label=row["label"], actor=f"integration:{row['connector']}",
                               integration_id=iid, include=intake_files)
                mined_note += (f" {len(intake_files)} document{'s' if len(intake_files) != 1 else ''} handed to "
                               f"document intake (batch {bid}) to be sorted into the company structure.")
            made = len({v for v in node_cache.values() if v and v != node_id})
            if made:
                mined_note += f" Filed into {made} folder{'s' if made != 1 else ''} of the structure."
        else:
            context = (cfg.get("collection_context") or "").strip()
            from . import taxonomy as TX
            TX.init(ccon)
            actor = f"integration:{row['connector']}"
            # An API feed always has a home: the collection name if one was
            # given, otherwise the connection's own name.
            memory = TX.Remembered(ccon, cfg.get("nodes"))
            home_name = context or row["label"]
            home = memory.node(f"home:{TX._norm(home_name)}",
                               lambda: TX.resolve_context(ccon, home_name, actor=actor))

            # MORE THAN ONE REGISTER THROUGH ONE KEY.
            #
            # A partner system shares several registers under one key — the
            # equipment list, the complaint register, the invoice handover
            # register, its organisation chart. They are read in one run and
            # filed through the same remembered nodes, so a complaint raised
            # in Radiology lands in the same place as Radiology's equipment.
            #
            # `also` lists the extra feeds. A feed marked "file": "top" describes
            # the whole company — an organisation chart — and is filed by its own
            # grouping at the top of the structure, not inside this collection.
            # An extra feed that cannot be read yet (not shared, not deployed)
            # is reported by name and skipped; it never fails the others.
            feeds = [{"url": cfg.get("url", ""), "label": row["label"]}] + [
                f if isinstance(f, dict) else {"url": str(f)} for f in (cfg.get("also") or [])]
            notes: list[str] = []
            # Kept from earlier runs: a register that cannot be read this time
            # still has records here, and they keep their layout.
            layouts = dict(cfg.get("layouts") or {})
            for n_feed, feed in enumerate(feeds):
                url = (feed.get("url") or "").strip()
                if not url:
                    continue
                label = feed.get("label") or urllib.parse.urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1] \
                    .replace("-", " ").replace("_", " ").capitalize()
                top = feed.get("file") == "top"
                try:
                    body, ctype = _http(url, row["secret"], cfg)
                except Exception as err:            # noqa: BLE001 — reported, not swallowed
                    if n_feed == 0:
                        raise
                    notes.append(f"{label}: not collected — {err}")
                    skipped += 1
                    continue
                rows = _parse(body, ctype, url)
                seen += len(rows)
                node_id = None if top else home
                # One domain for the whole feed when something names it — a saved
                # choice from an older connection, the URL, or the context. Otherwise
                # every record is placed by its own type field. A record that names
                # no type is skipped and counted: putting it in a catch-all would file
                # it somewhere nobody chose.
                fixed = feed.get("domain") or ((cfg.get("default_domain") or domain_for(url)
                                               or (domain_for(context) if context else None))
                                               if n_feed == 0 else None)
                type_col = map_columns(list(rows[0].keys())).get("type") if rows else None
                # The records' own grouping — department, unit, ward, location —
                # becomes the structure beneath the collection (or, for a feed
                # about the whole company, the top of the structure).
                group_col = grouping_field(rows, exclude=type_col)
                group_nodes: dict[str, str | None] = {}

                def node_for_group(r: dict, group_col=group_col, group_nodes=group_nodes,
                                   node_id=node_id, top=top, label=label) -> str | None:
                    value = _text(r.get(group_col)) if group_col else ""
                    if not value:
                        return node_id
                    if value not in group_nodes:
                        group_nodes[value] = memory.node(
                            f"{'top' if top else 'group'}:{group_col}:{TX._norm(value)}",
                            lambda: TX.ensure_path(
                                ccon, [TX.group_label(value)], parent_id=node_id,
                                kind=group_col.replace("_", " ").title(),
                                source=f"the {group_col} field of {label}", actor=actor))
                    return group_nodes[value]
                groups: dict[str, list[dict]] = {}
                for r in rows:
                    d = fixed or domain_of_row(r, type_col)
                    if d:
                        groups.setdefault(d, []).append(r)
                if rows and not groups:
                    if n_feed == 0:
                        return _finish(con, run, iid, "FAILED",
                                       "None of these records says what it is. Add an entity_type (or type) "
                                       "field to the API's records, or give the connection a collection "
                                       "context that names what it holds.", seen, 0, 0, seen)
                    notes.append(f"{label}: {len(rows)} records name no type they could be filed as")
                    skipped += len(rows)
                    continue
                # The feed's identity is where it lives, not how it was queried:
                # raising ?limit= or adding &updated_since= must not re-key the whole
                # register into a second copy of itself.
                u = urllib.parse.urlsplit(url)
                feed_key = "api" + hashlib.sha1(f"{u.scheme}://{u.netloc}{u.path}".encode()).hexdigest()[:6]
                placed = 0
                for d, group in groups.items():
                    if d == "people" and group:
                        keep = {group_col, type_col,
                                map_columns(list(group[0].keys())).get("reference")}
                        group = drop_personal(group, keep)
                    ents = rows_to_entities(group, d, source, url, key_prefix=feed_key)
                    # rows_to_entities reads the column layout ONCE, from the first
                    # row, and drops rows with no name. The pairing below has to
                    # skip exactly the same rows, or a record is filed under the
                    # department of the row next to it.
                    m0 = map_columns(list(group[0].keys())) if group else {}
                    named = [r for r in group if _text(r.get(m0.get("name", "")))]
                    for e, src in zip(ents, named):
                        e["orgNodeId"] = node_for_group(src)
                        t = e.get("type")
                        if isinstance(t, str) and t == t.lower():
                            e["type"] = t.replace("_", " ").capitalize()   # "walkthrough_check" -> "Walkthrough check"
                        if d == "overview":
                            e["type"] = normalise_overview_type(e.get("type"), url)
                        if context and not top:
                            e.setdefault("attrs", {})["collectionContext"] = context
                    shape = feed_layout(group, m0)
                    for t in sorted({e["type"] for e in ents if isinstance(e.get("type"), str)}):
                        layouts[t] = {"label": label, "fields": shape}
                    placed += len(ents)
                    written += _write(con, ccon, company_db, iid, ents, url)
                skipped += len(rows) - placed
                grouped = (f", grouped by {group_col} into {len(group_nodes)}"
                           if group_col and group_nodes else "")
                notes.append(f"{label}: {placed} of {len(rows)}{grouped}")
            mined_note = " " + "; ".join(notes) + "." if notes else ""

        save = False
        if memory is not None and memory.changed:
            cfg["nodes"] = memory.to_save()
            save = True
        if layouts is not None and layouts != (cfg.get("layouts") or {}):
            cfg["layouts"] = layouts
            save = True
        if save:
            con.execute("UPDATE integrations SET config=? WHERE id=?", (json.dumps(cfg), iid))
        ccon.commit()
        profile = _propose_profile(con, folder_base) if folder_base and docs + written else ""
        outcome = "OK" if not skipped else "PARTIAL"
        detail = (f"{written} entities, {docs} documents from {seen} item(s); "
                  f"{skipped} skipped.{mined_note}{profile}")
        con.execute("UPDATE integrations SET last_sync_at=?, updated_at=? WHERE id=?", (_now(), _now(), iid))
        return _finish(con, run, iid, outcome, detail, seen, written, docs, skipped)
    except Exception as e:
        # A failed statement leaves PostgreSQL's transaction aborted, and every
        # later command in it is rejected — including the one that records the
        # failure. Without this rollback the error handler raised its own error
        # ("current transaction is aborted"), so the real cause never reached the
        # user and the run was never marked FAILED.
        try:
            con.rollback()
        except Exception:
            pass
        return _finish(con, run, iid, "FAILED", f"{type(e).__name__}: {e}", seen, written, docs, skipped)


def existing_by_name(con, domain: str) -> dict[str, str]:
    """Normalised name -> existing entity id, so a sync updates rather than duplicates."""
    import re as _re
    out = {}
    for r in con.execute(
            "SELECT id, name FROM company_entities WHERE domain=?", (domain,)):
        key = _re.sub(r"[^a-z0-9]+", " ", (r[1] or "").lower()).strip()
        out.setdefault(key, r[0])
    return out


def _write(con, ccon, company_db, iid: str, entities: list[dict], ref: str) -> int:
    """
    Upsert entities and remember the external object, so a re-sync updates in place.

    Before writing, each record is matched against an entity that already exists
    with the same name in the same domain. Minting a fresh id instead created a
    second copy of every person on every sync — 120 duplicates, which broke the
    'one entity, one stable id' rule and made owner resolution impossible.
    """
    import re as _re
    n = 0
    seen_domains = {e["domain"] for e in entities}
    known = {d: existing_by_name(ccon, d) for d in seen_domains}
    for e in entities:
        key = _re.sub(r"[^a-z0-9]+", " ", (e["name"] or "").lower()).strip()
        match = known.get(e["domain"], {}).get(key)
        # Matching by name is how a file-sourced person or policy is recognised
        # on the next sync — a name is all a file gives us. It is WRONG for a
        # record that carries its source's own id. An equipment register holds
        # forty units called "Infusion Pump"; matched by name, all forty were
        # written onto the first one, the last write won, and that record ended
        # up holding another unit's serial number and department while the
        # other thirty-nine stopped updating. The source's id is the identity.
        if match and not e.get("sourceKeyed"):
            e["id"] = match          # update the existing record, do not fork it
        company_db.upsert_entity(ccon, e, actor=e["provenance"]["source"])
        con.execute(
            """INSERT INTO integration_records (integration_id, external_id, entity_id, last_seen_at)
               VALUES (?,?,?,?)
               ON CONFLICT(integration_id, external_id)
               DO UPDATE SET entity_id=excluded.entity_id, last_seen_at=excluded.last_seen_at""",
            (iid, f"{ref}::{e['id']}", e["id"], _now()))
        n += 1
    con.commit()
    return n


def _finish(con, run, iid, outcome, detail, seen, written, docs, skipped) -> dict:
    con.execute(
        """UPDATE integration_syncs SET finished_at=?, outcome=?, detail=?, items_seen=?,
                  entities_written=?, documents_written=?, skipped=? WHERE id=?""",
        (_now(), outcome, detail, seen, written, docs, skipped, run))
    con.commit()
    # The run row can be gone by now: deleting an integration removes its sync
    # history, and a delete that lands while a sync is still running leaves this
    # read-back with nothing. It used to raise TypeError from dict(None), which
    # surfaced to the user as a failed request rather than a finished sync.
    row = con.execute("SELECT * FROM integration_syncs WHERE id=?", (run,)).fetchone()
    if row is None:
        return {"id": run, "integration_id": iid, "outcome": outcome, "detail": detail,
                "items_seen": seen, "entities_written": written,
                "documents_written": docs, "skipped": skipped,
                "note": "the run record was removed before this sync finished"}
    return dict(row)


def syncs(con, iid: str, limit: int = 20) -> list[dict]:
    return [dict(r) for r in con.execute(
        "SELECT * FROM integration_syncs WHERE integration_id=? ORDER BY id DESC LIMIT ?", (iid, limit))]



STATE_TTL_SECONDS = 600


def set_secret(con, iid: str, secret: str | None) -> None:
    con.execute("UPDATE integrations SET secret=?, updated_at=? WHERE id=?", (secret, _now(), iid))
    con.commit()


def raw_secret(con, iid: str) -> str | None:
    """
    The stored credential, for server-side use only.

    Deliberately not part of get()/listing(), which strip it. Every caller of
    this is inside the API process; nothing it returns reaches a response body.
    """
    row = con.execute("SELECT secret FROM integrations WHERE id=?", (iid,)).fetchone()
    return row["secret"] if row else None


def set_config(con, iid: str, config: dict) -> None:
    con.execute("UPDATE integrations SET config=?, updated_at=? WHERE id=?",
                (json.dumps(config), _now(), iid))
    con.commit()


