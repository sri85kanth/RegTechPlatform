"""
External auditor access: what the hospital has chosen to show an auditor, and nothing else.

An auditor account (role 'auditor', auth.py) inherits no capability except
'audit', so every other endpoint refuses it. What it can see is decided here,
per auditor, by the hospital:

  regulation share   a regulation whose impact cascade the auditor may open
                     (/api/cascade only lists and serves shared regulations to an
                     auditor, and its document graph is cut to what those
                     regulations' cascades link to)
  document share     a hospital document on file (company_documents) to download
  file share         a file uploaded for this auditor only — an audit pack, a
                     register extract, a signed policy

A share carries who sent it, when, an optional note and an optional expiry, and
can be revoked. Nothing is deleted: the record of what was shown, when and by
whom stays. Every share, revocation and auditor download is written to
audit_events, so the hospital can see exactly what its auditor was given and
what it opened.

The auditor can also ASK. It searches the regulations that have an impact
cascade (title and regulator only — no figures) and requests one, or describes
anything else it needs (a document, a register, a regulation not listed), with
a reason. The request reaches compliance managers as a notification; approving a
regulation request shares it, approving any other request records that the item
was sent, and declining needs a reason the auditor can read. Requests are kept.

    GET  /api/auditor/shared                         the caller's shares (an auditor), or ?auditor_id= (staff preview)
    GET  /api/auditor/shared/{sid}/download          one shared file
    GET  /api/auditor/admin/overview                 auditors, and what can be shared
    GET  /api/auditor/admin/auditors/{uid}           one auditor's shares (incl. revoked) and activity
    POST /api/auditor/admin/auditors/{uid}/shares    share regulations or documents   {kind, refs[], note?, expires_on?}
    POST /api/auditor/admin/auditors/{uid}/files     upload a file for this auditor   multipart: file, note?, expires_on?
    POST /api/auditor/admin/shares/{sid}/revoke

    GET  /api/auditor/catalogue?q=                   regulations an auditor may ask for (title, regulator)
    GET  /api/auditor/requests                       the calling auditor's requests
    POST /api/auditor/requests                       ask   {kind: regulation, ref, message} | {kind: other, title, message}
    POST /api/auditor/requests/{rid}/withdraw
    GET  /api/auditor/admin/requests?status=         every auditor's requests
    GET  /api/auditor/admin/pending                  how many wait for a decision (the nav badge)
    POST /api/auditor/admin/requests/{rid}/approve   {note?, expires_on?}
    POST /api/auditor/admin/requests/{rid}/decline   {note}
"""
from __future__ import annotations

import difflib
import hashlib
import json
import mimetypes
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from . import auth as A
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/auditor", tags=["auditor"])
AUDIT = Depends(require("audit"))       # an auditor, or staff from viewer up
MANAGE = Depends(require("approve"))     # sending documents outside the hospital is a compliance manager's call

APP_ROOT = Path(os.environ.get("COMPANY_BRAIN_ROOT", "/srv/company-brain"))
FILES_DIR = Path(os.environ.get("AUDITOR_FILES_DIR", str(APP_ROOT / "auditor_files")))
MAX_UPLOAD = 50 * 1024 * 1024
ALLOWED_EXT = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".csv", ".txt", ".pptx", ".png", ".jpg", ".jpeg"}
KINDS = ("regulation", "document", "file")

SCHEMA = """
CREATE TABLE IF NOT EXISTS auditor_shares (
  id             TEXT PRIMARY KEY,
  auditor_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  ref            TEXT NOT NULL,
  title          TEXT NOT NULL,
  note           TEXT,
  file_name      TEXT,
  file_size      BIGINT,
  content_type   TEXT,
  sha256         TEXT,
  shared_by      TEXT NOT NULL,
  shared_by_name TEXT,
  shared_at      TEXT NOT NULL,
  expires_at     TEXT,
  revoked_at     TEXT,
  revoked_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditor_shares_auditor ON auditor_shares(auditor_id);
CREATE TABLE IF NOT EXISTS auditor_requests (
  id              TEXT PRIMARY KEY,
  auditor_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  ref             TEXT,
  title           TEXT NOT NULL,
  message         TEXT,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  decided_at      TEXT,
  decided_by      TEXT,
  decided_by_name TEXT,
  decision_note   TEXT,
  share_id        TEXT,
  context         TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditor_requests_auditor ON auditor_requests(auditor_id);
"""
_READY = False

_now = lambda: datetime.now(timezone.utc)                       # noqa: E731
_iso = lambda d: d.isoformat(timespec="seconds")                 # noqa: E731


def _con():
    global _READY
    con = connect()
    if not _READY:
        con.executescript(SCHEMA)
        con.commit()
        _READY = True
    return con


def _active_sql(alias: str = "s") -> str:
    return f"{alias}.revoked_at IS NULL AND ({alias}.expires_at IS NULL OR {alias}.expires_at > ?)"


def _expiry(expires_on: str | None) -> str | None:
    """A date (YYYY-MM-DD) means 'until the end of that day', UTC."""
    if not expires_on:
        return None
    try:
        d = datetime.strptime(expires_on.strip()[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, "expires_on must be a date, YYYY-MM-DD")
    end = d + timedelta(days=1) - timedelta(seconds=1)
    if end < _now():
        raise HTTPException(400, "expires_on is in the past")
    return _iso(end)


def log(con, actor: str, action: str, entity_id: str, detail: dict, dedupe_minutes: int = 0) -> None:
    """One audit_events row. With dedupe, a repeat of the same action within the window is not re-logged."""
    if dedupe_minutes:
        since = _iso(_now() - timedelta(minutes=dedupe_minutes))
        if con.execute("SELECT 1 FROM audit_events WHERE entity_id=? AND action=? AND actor=? AND at > ? LIMIT 1",
                       (entity_id, action, actor, since)).fetchone():
            return
    con.execute("INSERT INTO audit_events (entity_id, action, actor, detail, at) VALUES (?,?,?,?,?)",
                (entity_id, action, actor, json.dumps(detail, ensure_ascii=False), _iso(_now())))
    con.commit()


# ---------------------------------------------------------------- what an auditor may see
def shared_regulation_ids(con, auditor_id: str) -> set[str]:
    _ = _con()
    return {r[0] for r in con.execute(
        f"SELECT ref FROM auditor_shares s WHERE s.auditor_id=? AND s.kind='regulation' AND {_active_sql()}",
        (auditor_id, _iso(_now())))}


def graph_for(graph: dict, codes: set[str]) -> dict:
    """
    The part of the hospital's document graph an auditor's cascade draws: the
    documents its shared regulations cite, and what those link to — the
    controls that run an SOP or form, the policy over an SOP, the SOPs a form
    is used in, and the register risks the controls treat. Nothing else.
    """
    docs, risks = graph.get("docs", {}), graph.get("risks", {})
    keep = {c for c in codes if c in docs}
    for _ in range(6):                                          # a fixed point in a few rounds
        before = len(keep)
        for code in list(keep):
            d = docs.get(code, {})
            for k in ("sops", "forms", "pol"):
                keep.update(c for c in (d.get(k) or []) if c in docs)
        for code, d in docs.items():
            if d.get("k") == "Control" and code not in keep and \
                    any(c in keep for c in (d.get("sops") or []) + (d.get("forms") or [])):
                keep.add(code)
        if len(keep) == before:
            break
    risk_keep = {r for c in keep for r in (docs[c].get("risks") or []) if r in risks}
    return {"docs": {c: docs[c] for c in keep}, "risks": {r: risks[r] for r in risk_keep}}


def _auditor(con, uid: str) -> dict:
    u = con.execute("SELECT id, email, name, role, active, last_login_at, created_at FROM users WHERE id=?",
                    (uid,)).fetchone()
    if not u or u["role"] not in A.EXTERNAL_ROLES:
        raise HTTPException(404, "no such auditor")
    return dict(u)


def _folder_bases(con) -> list[Path]:
    from . import doc_intake as DI
    DI.init(con)
    # the folders document intake read from, uploads included
    out = [Path(r["root"]) for r in con.execute("SELECT DISTINCT root FROM intake_batches") if r["root"]]
    for r in con.execute("SELECT config FROM integrations WHERE connector='folder'"):
        try:
            p = json.loads(r["config"] or "{}").get("path")
            if p:
                out.append(Path(p))
        except (TypeError, ValueError):
            pass
    return out


def _doc_file(con, doc_id: str) -> Path | None:
    """A company_documents row → its file on this server, only from the known document folders."""
    d = con.execute("SELECT storage_path FROM company_documents WHERE id=?", (doc_id,)).fetchone()
    sp = (d["storage_path"] if d else "") or ""
    if not sp:
        return None
    bases = [APP_ROOT / "sops", *_folder_bases(con)]
    cands = [Path(sp), APP_ROOT / sp.lstrip("/")] if sp.startswith("/") else [b / sp for b in _folder_bases(con)]
    for c in cands:
        try:
            c = c.resolve()
        except OSError:
            continue
        if c.is_file() and any(c.is_relative_to(b.resolve()) for b in bases):
            return c
    return None


def _share_file(con, s: dict) -> Path | None:
    if s["kind"] == "document":
        return _doc_file(con, s["ref"])
    if s["kind"] == "file":
        p = (FILES_DIR / s["ref"]).resolve()
        return p if p.is_file() and p.is_relative_to(FILES_DIR.resolve()) else None
    return None


def _public_share(con, s: dict, with_file: bool = True) -> dict:
    out = {k: s[k] for k in ("id", "kind", "ref", "title", "note", "file_name", "file_size", "content_type",
                             "shared_by_name", "shared_at", "expires_at", "revoked_at")}
    if with_file and s["kind"] != "regulation":
        out["available"] = _share_file(con, s) is not None
    return out


# ---------------------------------------------------------------- the auditor's side
@router.get("/shared")
def shared(auditor_id: str | None = None, user: dict | None = AUDIT):
    """What has been shared with the calling auditor. Staff who can approve may preview any auditor's view."""
    con = _con()
    if A.is_auditor(user):
        uid = user["id"]
    elif auditor_id and A.can(user, "approve"):
        uid = auditor_id
    else:
        raise HTTPException(400, "auditor_id is required to preview an auditor's view")
    who = _auditor(con, uid)
    now = _iso(_now())
    rows = [dict(r) for r in con.execute(
        f"SELECT * FROM auditor_shares s WHERE s.auditor_id=? AND {_active_sql()} ORDER BY s.shared_at DESC", (uid, now))]
    regs = {r["id"]: dict(r) for r in con.execute(
        """SELECT r.id, r.title, r.short_title, coalesce(nullif(r.regulator_short,''), r.regulator, '') AS regulator,
                  count(g.requirement_id) FILTER (WHERE g.status <> 'NOT_APPLICABLE') AS applicable,
                  count(g.requirement_id) FILTER (WHERE g.status IN ('PARTIAL','GAP','NOT_COVERED')) AS unmet
             FROM regulations r LEFT JOIN gap_assessments g ON g.regulation_id = r.id
            WHERE r.id = ANY(?) GROUP BY r.id, r.title, r.short_title, r.regulator_short, r.regulator""",
        ([s["ref"] for s in rows if s["kind"] == "regulation"],))}
    company = con.execute("SELECT legal_name FROM company_profile ORDER BY id LIMIT 1").fetchone()
    return {
        "auditor": {k: who[k] for k in ("id", "name", "email")},
        "company": company[0] if company else None,
        "regulations": [{**_public_share(con, s, False), "regulation": regs.get(s["ref"])}
                        for s in rows if s["kind"] == "regulation"],
        "documents": [_public_share(con, s) for s in rows if s["kind"] != "regulation"],
        "preview": not A.is_auditor(user),
    }


@router.get("/shared/{sid}/download")
def download(sid: str, user: dict | None = AUDIT):
    con = _con()
    s = con.execute(f"SELECT * FROM auditor_shares s WHERE s.id=? AND {_active_sql()}", (sid, _iso(_now()))).fetchone()
    if not s or s["kind"] == "regulation":
        raise HTTPException(404, "not shared, revoked or expired")
    s = dict(s)
    if A.is_auditor(user) and s["auditor_id"] != user["id"]:
        raise HTTPException(404, "not shared, revoked or expired")
    if not A.is_auditor(user) and not A.can(user, "approve"):
        raise HTTPException(403, "only the auditor it was shared with, or a compliance manager, can open it")
    path = _share_file(con, s)
    if not path:
        raise HTTPException(410, "the file is no longer on this server — ask the hospital to share it again")
    actor = (user or {}).get("email", "anonymous")
    log(con, actor, "auditor_download" if A.is_auditor(user) else "auditor_share_preview", s["id"],
        {"title": s["title"], "kind": s["kind"], "ref": s["ref"], "file": path.name, "auditor_id": s["auditor_id"]})
    name = s["file_name"] or path.name
    return FileResponse(path, filename=name, media_type=s["content_type"] or mimetypes.guess_type(name)[0]
                        or "application/octet-stream")


# ---------------------------------------------------------------- the hospital's side
@router.get("/admin/overview")
def overview(_: dict | None = MANAGE):
    con = _con()
    now = _iso(_now())
    auditors = [dict(r) for r in con.execute(
        f"""SELECT u.id, u.name, u.email, u.active, u.last_login_at, u.created_at,
                   count(s.id) FILTER (WHERE s.kind='regulation' AND {_active_sql()}) AS regulations,
                   count(s.id) FILTER (WHERE s.kind<>'regulation' AND {_active_sql()}) AS documents
              FROM users u LEFT JOIN auditor_shares s ON s.auditor_id = u.id
             WHERE u.role = ANY(?) GROUP BY u.id ORDER BY u.created_at""", (now, now, A.EXTERNAL_ROLES))]
    pending = {r[0]: r[1] for r in con.execute(
        "SELECT auditor_id, count(*) FROM auditor_requests WHERE status='PENDING' GROUP BY 1")}
    for a in auditors:
        a["pending"] = pending.get(a["id"], 0)
    regulations = [dict(r) for r in con.execute(
        """SELECT g.regulation_id AS id, r.title, r.short_title,
                  coalesce(nullif(r.regulator_short,''), r.regulator, '') AS regulator,
                  count(*) FILTER (WHERE g.status <> 'NOT_APPLICABLE') AS applicable,
                  count(*) FILTER (WHERE g.status IN ('PARTIAL','GAP','NOT_COVERED')) AS unmet
             FROM gap_assessments g JOIN regulations r ON r.id = g.regulation_id
            GROUP BY g.regulation_id, r.title, r.short_title, r.regulator_short, r.regulator
           HAVING count(*) FILTER (WHERE g.status <> 'NOT_APPLICABLE') > 0
            ORDER BY count(*) FILTER (WHERE g.status IN ('PARTIAL','GAP','NOT_COVERED')) DESC""")]
    documents = [{**dict(r), "available": _doc_file(con, r["id"]) is not None} for r in con.execute(
        """SELECT id, name, kind, document_type, status, source, version, uploaded_at
             FROM company_documents ORDER BY (source LIKE 'Generated%'), name""")]
    return {"auditors": auditors, "regulations": regulations, "documents": documents,
            "limits": {"maxUploadMb": MAX_UPLOAD // (1024 * 1024), "types": sorted(ALLOWED_EXT)}}


@router.get("/admin/auditors/{uid}")
def auditor_detail(uid: str, _: dict | None = MANAGE):
    con = _con()
    who = _auditor(con, uid)
    shares = [_public_share(con, dict(r)) for r in con.execute(
        "SELECT * FROM auditor_shares WHERE auditor_id=? ORDER BY shared_at DESC", (uid,))]
    activity = [dict(r) for r in con.execute(
        """SELECT e.action, e.entity_id, e.actor, e.detail, e.at FROM audit_events e
            WHERE e.actor = ? OR e.entity_id IN (SELECT id FROM auditor_shares WHERE auditor_id = ?)
               OR (e.action LIKE 'auditor_%' AND e.detail LIKE ?)
            ORDER BY e.at DESC LIMIT 200""", (who["email"], uid, f'%"auditor_id": "{uid}"%'))]
    for a in activity:
        try:
            a["detail"] = json.loads(a["detail"] or "{}")
        except ValueError:
            pass
    requests = [_public_request(con, dict(r), admin=True) for r in con.execute(
        "SELECT * FROM auditor_requests WHERE auditor_id=? ORDER BY (status='PENDING') DESC, created_at DESC", (uid,))]
    return {"auditor": who, "shares": shares, "activity": activity, "requests": requests}


@router.post("/admin/auditors/{uid}/shares")
def add_shares(uid: str, payload: dict = Body(...), user: dict | None = MANAGE):
    con = _con()
    who = _auditor(con, uid)
    kind = payload.get("kind")
    refs = [str(r) for r in (payload.get("refs") or []) if r]
    if kind not in ("regulation", "document") or not refs:
        raise HTTPException(400, "kind must be 'regulation' or 'document', with at least one ref")
    note = (payload.get("note") or "").strip()[:500] or None
    expires = _expiry(payload.get("expires_on"))
    made = _create_shares(con, who, kind, refs, note, expires, user)
    return {"created": len(made), "skipped_already_shared": len(refs) - len(made)}


def _create_shares(con, who: dict, kind: str, refs: list[str], note: str | None, expires: str | None,
                   user: dict | None) -> list[str]:
    """Share regulations or documents with one auditor; already-shared refs are skipped. Returns the new share ids."""
    uid = who["id"]
    if kind == "regulation":
        found = {r[0]: r[1] for r in con.execute(
            "SELECT id, coalesce(nullif(short_title,''), title) FROM regulations WHERE id = ANY(?)", (refs,))}
    else:
        found = {r[0]: r[1] for r in con.execute("SELECT id, name FROM company_documents WHERE id = ANY(?)", (refs,))}
    missing = [r for r in refs if r not in found]
    if missing:
        raise HTTPException(400, f"unknown {kind}: {', '.join(missing[:5])}")
    now = _iso(_now())
    already = {r[0] for r in con.execute(
        f"SELECT ref FROM auditor_shares s WHERE s.auditor_id=? AND s.kind=? AND {_active_sql()}", (uid, kind, now))}
    made = []
    for ref in refs:
        if ref in already:
            continue
        sid = f"shr-{secrets.token_hex(6)}"
        fname = None
        if kind == "document":
            p = _doc_file(con, ref)
            fname = p.name if p else None
        con.execute(
            """INSERT INTO auditor_shares (id,auditor_id,kind,ref,title,note,file_name,content_type,
                 shared_by,shared_by_name,shared_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, uid, kind, ref, found[ref], note, fname, mimetypes.guess_type(fname or "")[0],
             (user or {}).get("id", "system"), (user or {}).get("name") or (user or {}).get("email"), now, expires))
        made.append(sid)
        log(con, (user or {}).get("email", "system"), "auditor_share", sid,
            {"auditor_id": uid, "auditor": who["email"], "kind": kind, "ref": ref, "title": found[ref],
             "expires_at": expires, "note": note})
    con.commit()
    return made


@router.post("/admin/auditors/{uid}/files")
async def upload_file(uid: str, file: UploadFile = File(...), note: str = Form(""), expires_on: str = Form(""),
                      user: dict | None = MANAGE):
    con = _con()
    who = _auditor(con, uid)
    name = Path(file.filename or "file").name
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"file type {ext or '(none)'} is not accepted — use {', '.join(sorted(ALLOWED_EXT))}")
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"the file is larger than {MAX_UPLOAD // (1024 * 1024)} MB")
    if not data:
        raise HTTPException(400, "the file is empty")
    expires = _expiry(expires_on or None)
    sid = f"shr-{secrets.token_hex(6)}"
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    stored = f"{sid}{ext}"
    (FILES_DIR / stored).write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    title = re.sub(r"[_]+", " ", Path(name).stem).strip() or name
    now = _iso(_now())
    con.execute(
        """INSERT INTO auditor_shares (id,auditor_id,kind,ref,title,note,file_name,file_size,content_type,sha256,
             shared_by,shared_by_name,shared_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (sid, uid, "file", stored, title, (note or "").strip()[:500] or None, name, len(data),
         file.content_type or mimetypes.guess_type(name)[0], digest,
         (user or {}).get("id", "system"), (user or {}).get("name") or (user or {}).get("email"), now, expires))
    con.commit()
    log(con, (user or {}).get("email", "system"), "auditor_share", sid,
        {"auditor_id": uid, "auditor": who["email"], "kind": "file", "file": name, "size": len(data),
         "sha256": digest, "expires_at": expires})
    return {"id": sid, "title": title, "file_name": name, "file_size": len(data), "sha256": digest}


@router.post("/admin/shares/{sid}/revoke")
def revoke(sid: str, user: dict | None = MANAGE):
    con = _con()
    s = con.execute("SELECT * FROM auditor_shares WHERE id=?", (sid,)).fetchone()
    if not s:
        raise HTTPException(404, "no such share")
    if s["revoked_at"]:
        return {"revoked": sid, "already": True}
    now = _iso(_now())
    con.execute("UPDATE auditor_shares SET revoked_at=?, revoked_by=? WHERE id=?",
                (now, (user or {}).get("email", "system"), sid))
    con.commit()
    log(con, (user or {}).get("email", "system"), "auditor_revoke", sid,
        {"auditor_id": s["auditor_id"], "kind": s["kind"], "ref": s["ref"], "title": s["title"]})
    return {"revoked": sid, "at": now}


# ---------------------------------------------------------------- the auditor asks
REQUEST_KINDS = ("regulation", "document", "other")


def _charted(con) -> dict[str, dict]:
    """Regulations with an impact cascade — the ones a regulation request can be granted for."""
    return {r["id"]: dict(r) for r in con.execute(
        """SELECT g.regulation_id AS id, r.title, r.short_title,
                  coalesce(nullif(r.regulator_short,''), r.regulator, '') AS regulator
             FROM gap_assessments g JOIN regulations r ON r.id = g.regulation_id
            GROUP BY g.regulation_id, r.title, r.short_title, r.regulator_short, r.regulator
           HAVING count(*) FILTER (WHERE g.status <> 'NOT_APPLICABLE') > 0""")}


def _files_for(con, codes: list[str]) -> list[dict]:
    """The hospital documents on record that hold these policy / SOP / form / control codes."""
    row = con.execute("SELECT payload FROM cascade_graph WHERE id='company'").fetchone()
    docs = json.loads(row[0]).get("docs", {}) if row else {}
    names = {docs[c]["f"] for c in codes if c in docs and docs[c].get("f")}
    out = []
    for d in con.execute("SELECT id, name, storage_path FROM company_documents WHERE storage_path IS NOT NULL"):
        if Path(d["storage_path"]).name in names:
            out.append({"id": d["id"], "name": d["name"], "file": Path(d["storage_path"]).name})
    return out


_STOP = {"the", "and", "for", "with", "from", "under", "rules", "act", "of", "in", "on", "to", "a", "an",
         "regulation", "regulations", "guidelines", "standards", "standard", "hospital", "hospitals", "india", "indian"}


def _words(t: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", (t or "").lower()) if len(w) > 2 and w not in _STOP]


def _library_matches(con, title: str, regulator: str = "", limit: int = 6) -> list[dict]:
    """
    Regulations in the library that look like what the auditor asked for — so a
    request for something "not in the library" that IS there under another name,
    or was added after the request, is one click to share.
    """
    words = _words(title)[:8]
    if not words:
        return []
    hits = " + ".join(["(lower(r.title) LIKE ?)::int"] * len(words))
    pats = tuple(f"%{w}%" for w in words)
    # the titles sharing the most words first, so a common word ("management") cannot crowd out the match
    rows = con.execute(
        f"""SELECT * FROM (SELECT r.id, r.title, r.short_title, r.created_at,
                                  coalesce(nullif(r.regulator_short,''), r.regulator, '') AS regulator, ({hits}) AS hits
                             FROM regulations r) x
             WHERE hits > 0 ORDER BY hits DESC LIMIT 300""", pats).fetchall()
    charted = _charted(con)
    want, by = set(words), set(_words(regulator))
    scored = []
    for r in rows:
        # the title decides; the issuer only breaks ties ("1899" and "Code" alone are not a match)
        overlap = len(want & set(_words(f"{r['title']} {r['short_title'] or ''}"))) / len(want)
        if overlap < 0.6:
            continue
        sim = difflib.SequenceMatcher(None, title.lower(), (r["title"] or "").lower()).ratio()
        bonus = 0.1 if by and by & set(_words(r["regulator"])) else 0.0
        scored.append((round(overlap * 0.7 + sim * 0.3 + bonus, 3), r))
    scored.sort(key=lambda x: -x[0])
    return [{"id": r["id"], "title": r["title"], "regulator": r["regulator"], "added": r["created_at"],
             "ready": r["id"] in charted, "score": sc} for sc, r in scored[:limit]]


def _public_request(con, r: dict, admin: bool = False) -> dict:
    try:
        r["context"] = json.loads(r.get("context") or "{}")
    except ValueError:
        r["context"] = {}
    # a regulation the auditor named that the library did not have: what the library has now that may be it
    if admin and r["kind"] == "regulation" and not r.get("ref") and r["status"] == "PENDING":
        r["suggestions"] = _library_matches(con, r["title"], r["context"].get("regulator") or "")
    return r


def _me(user: dict | None) -> dict:
    if not A.is_auditor(user):
        raise HTTPException(403, "only an auditor account makes requests")
    return user


@router.get("/catalogue")
def catalogue(q: str = Query("", max_length=100), user: dict | None = AUDIT):
    """Regulations an auditor may ask for: title and regulator only, with whether each is already shared or asked for."""
    me = _me(user)
    con = _con()
    needle = q.strip().lower()
    if len(needle) < 2:
        return {"items": [], "note": "Type at least two letters."}
    shared = shared_regulation_ids(con, me["id"])
    asked = {r[0] for r in con.execute(
        "SELECT ref FROM auditor_requests WHERE auditor_id=? AND kind='regulation' AND status='PENDING'", (me["id"],))}
    hits = [r for r in _charted(con).values()
            if needle in f"{r['title']} {r['short_title'] or ''} {r['regulator']}".lower()]
    hits.sort(key=lambda r: (not r["title"].lower().startswith(needle), r["title"]))
    return {"items": [{"id": r["id"], "title": r["title"], "regulator": r["regulator"],
                       "shared": r["id"] in shared, "requested": r["id"] in asked} for r in hits[:25]],
            "more": max(0, len(hits) - 25)}


@router.get("/requests")
def my_requests(user: dict | None = AUDIT):
    me = _me(user)
    con = _con()
    return {"items": [_public_request(con, dict(r)) for r in con.execute(
        "SELECT * FROM auditor_requests WHERE auditor_id=? ORDER BY created_at DESC", (me["id"],))]}


@router.post("/requests")
def make_request(payload: dict = Body(...), user: dict | None = AUDIT):
    """
    An auditor asks for more:
      {kind: regulation, ref, message}            a regulation's impact cascade
      {kind: regulation, title, regulator?, reference?, message}
                                                  one the hospital has not added to its library yet
      {kind: document, ref: '<reg>|<code>', message}  the documents behind one obligation of a shared regulation
      {kind: other, title, message}               anything else, in its own words
    """
    me = _me(user)
    con = _con()
    kind = payload.get("kind")
    message = (payload.get("message") or "").strip()[:1000] or None
    context: dict = {}
    if kind == "regulation" and not payload.get("ref"):
        # not in the hospital's library: the auditor names it; the hospital adds it, then shares it
        ref = None
        title = (payload.get("title") or "").strip()[:200]
        if len(title) < 3:
            raise HTTPException(400, "name the regulation or standard")
        context = {"not_in_library": True, "regulator": (payload.get("regulator") or "").strip()[:120],
                   "reference": (payload.get("reference") or "").strip()[:300]}
        dup = con.execute("""SELECT * FROM auditor_requests WHERE auditor_id=? AND kind='regulation' AND ref IS NULL
                             AND status='PENDING' AND lower(title)=lower(?)""", (me["id"], title)).fetchone()
        if dup:
            return _public_request(con, dict(dup))
    elif kind == "regulation":
        ref = str(payload.get("ref") or "")
        reg = _charted(con).get(ref)
        if not reg:
            raise HTTPException(400, "that regulation cannot be requested")
        if ref in shared_regulation_ids(con, me["id"]):
            raise HTTPException(409, "already shared with you")
        title = reg["short_title"] or reg["title"]
        context = {"regulation_id": ref, "regulator": reg["regulator"]}
    elif kind == "document":
        ref = str(payload.get("ref") or "")
        rid, _, code = ref.partition("|")
        if rid not in shared_regulation_ids(con, me["id"]):
            raise HTTPException(403, "documents can be asked for only on a regulation shared with you")
        g = con.execute("SELECT item_code, obligation, requirement_text, covered_by FROM gap_assessments "
                        "WHERE regulation_id=? AND item_code=?", (rid, code)).fetchone()
        if not g:
            raise HTTPException(400, "no such obligation in that regulation")
        codes = json.loads(g["covered_by"] or "[]")
        files = _files_for(con, codes)
        title = f"Supporting documents for {code}"
        context = {"regulation_id": rid, "item_code": code, "obligation": (g["obligation"] or g["requirement_text"] or "")[:300],
                   "codes": codes, "files": files}
    elif kind == "other":
        ref = None
        title = (payload.get("title") or "").strip()[:200]
        if len(title) < 3:
            raise HTTPException(400, "say what you need")
    else:
        raise HTTPException(400, f"kind must be one of {', '.join(REQUEST_KINDS)}")
    if ref:
        dup = con.execute("SELECT * FROM auditor_requests WHERE auditor_id=? AND kind=? AND ref=? AND status='PENDING'",
                          (me["id"], kind, ref)).fetchone()
        if dup:
            return _public_request(con, dict(dup))
    rq = f"req-{secrets.token_hex(6)}"
    con.execute("""INSERT INTO auditor_requests (id,auditor_id,kind,ref,title,message,status,created_at,context)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (rq, me["id"], kind, ref, title, message, "PENDING", _iso(_now()), json.dumps(context, ensure_ascii=False)))
    con.commit()
    log(con, me["email"], "auditor_request", rq, {"auditor_id": me["id"], "kind": kind, "ref": ref, "title": title,
                                                  "message": message})
    try:
        from . import notifications as N
        # critical: an auditor waiting during an assessment is urgent, and the bell lists critical first
        N.push(con, kind="auditor_request", severity="critical", role="compliance_manager", dedupe_key=f"auditor-request:{rq}",
               title=f"Auditor {me['name']} requests: {title}", body=message or "", link="/auditor-access")
    except Exception:                                            # noqa: BLE001 — the request stands without the alert
        pass
    return _public_request(con, dict(con.execute("SELECT * FROM auditor_requests WHERE id=?", (rq,)).fetchone()))


@router.post("/requests/{rid}/withdraw")
def withdraw(rid: str, user: dict | None = AUDIT):
    me = _me(user)
    con = _con()
    r = con.execute("SELECT * FROM auditor_requests WHERE id=? AND auditor_id=?", (rid, me["id"])).fetchone()
    if not r or r["status"] != "PENDING":
        raise HTTPException(404, "no pending request with that id")
    con.execute("UPDATE auditor_requests SET status='WITHDRAWN', decided_at=? WHERE id=?", (_iso(_now()), rid))
    con.commit()
    log(con, me["email"], "auditor_request_withdrawn", rid, {"auditor_id": me["id"], "title": r["title"]})
    return {"withdrawn": rid}


@router.get("/admin/pending")
def pending_count(_: dict | None = MANAGE):
    con = _con()
    return {"pending": con.execute("SELECT count(*) FROM auditor_requests WHERE status='PENDING'").fetchone()[0]}


@router.get("/admin/requests")
def all_requests(status: str = Query("PENDING"), _: dict | None = MANAGE):
    con = _con()
    where, p = ("WHERE q.status=?", (status.upper(),)) if status.upper() != "ALL" else ("", ())
    return {"items": [_public_request(con, dict(r), admin=True) for r in con.execute(
        f"""SELECT q.*, u.name AS auditor_name, u.email AS auditor_email FROM auditor_requests q
              JOIN users u ON u.id = q.auditor_id {where} ORDER BY q.created_at DESC LIMIT 500""", p)]}


def _decide(con, rid: str) -> dict:
    r = con.execute("SELECT * FROM auditor_requests WHERE id=?", (rid,)).fetchone()
    if not r:
        raise HTTPException(404, "no such request")
    if r["status"] != "PENDING":
        raise HTTPException(409, f"this request is already {r['status'].lower()}")
    return _public_request(con, dict(r))


@router.post("/admin/requests/{rid}/approve")
def approve(rid: str, payload: dict = Body(default={}), user: dict | None = MANAGE):
    """A regulation request shares it; a document request shares the files on record; any other is marked as sent."""
    con = _con()
    r = _decide(con, rid)
    who = _auditor(con, r["auditor_id"])
    note = (payload.get("note") or "").strip()[:500] or None
    expires = _expiry(payload.get("expires_on"))
    made: list[str] = []
    if r["kind"] == "regulation" and not r["ref"]:
        # named by the auditor, not in the library when asked: the hospital says which regulation it is
        chosen = str(payload.get("regulation_id") or "")
        if not chosen:
            raise HTTPException(400, "choose the regulation in your library that this request is for")
        if chosen not in _charted(con):
            raise HTTPException(409, "that regulation has no impact cascade yet; it can be shared once it has been assessed")
        r["ref"] = chosen
        con.execute("UPDATE auditor_requests SET ref=? WHERE id=?", (chosen, rid))
        made = _create_shares(con, who, "regulation", [chosen], note, expires, user)
    elif r["kind"] == "regulation":
        made = _create_shares(con, who, "regulation", [r["ref"]], note, expires, user)
    elif r["kind"] == "document":
        ids = [f["id"] for f in (r["context"].get("files") or [])]
        if ids:
            made = _create_shares(con, who, "document", ids, note or f"Requested for {r['context'].get('item_code')}",
                                  expires, user)
    now = _iso(_now())
    con.execute("""UPDATE auditor_requests SET status='APPROVED', decided_at=?, decided_by=?, decided_by_name=?,
                   decision_note=?, share_id=? WHERE id=?""",
                (now, (user or {}).get("email", "system"), (user or {}).get("name") or (user or {}).get("email"),
                 note, ",".join(made) or None, rid))
    con.commit()
    log(con, (user or {}).get("email", "system"), "auditor_request_approved", rid,
        {"auditor_id": who["id"], "title": r["title"], "kind": r["kind"], "ref": r["ref"], "shares": made, "note": note})
    return {"approved": rid, "shared": len(made)}


@router.post("/admin/requests/{rid}/decline")
def decline(rid: str, payload: dict = Body(default={}), user: dict | None = MANAGE):
    con = _con()
    r = _decide(con, rid)
    note = (payload.get("note") or "").strip()[:500]
    if len(note) < 3:
        raise HTTPException(400, "give the auditor a reason")
    con.execute("""UPDATE auditor_requests SET status='DECLINED', decided_at=?, decided_by=?, decided_by_name=?,
                   decision_note=? WHERE id=?""",
                (_iso(_now()), (user or {}).get("email", "system"), (user or {}).get("name") or (user or {}).get("email"),
                 note, rid))
    con.commit()
    log(con, (user or {}).get("email", "system"), "auditor_request_declined", rid,
        {"auditor_id": r["auditor_id"], "title": r["title"], "note": note})
    return {"declined": rid}
