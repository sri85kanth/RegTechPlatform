"""
Upload a regulation from the app and follow it live.

  POST   /api/reg-uploads            multipart: file (+ title, regulator, regulation_type,
                                     jurisdiction, attach_to) -> queued job
  GET    /api/reg-uploads            jobs, newest first, with stage / progress / counts
  GET    /api/reg-uploads/llm        is the local LLM reachable
  GET    /api/reg-uploads/{id}       one job with its log
  POST   /api/reg-uploads/{id}/retry re-queue a failed job (cached LLM answers are reused)
  DELETE /api/reg-uploads/{id}       remove the job and everything it added

The work itself runs in reg_upload.py's queue runner, a separate process.
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from . import reg_upload as R
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/reg-uploads", tags=["regulation upload"])
READ = Depends(require("read"))
WRITE = Depends(require("propose"))
ADMIN = Depends(require("approve"))

ALLOWED = {".pdf", ".docx", ".txt", ".md", ".html", ".htm"}
MAX_BYTES = 80 * 1024 * 1024


def _con():
    return R.init(connect())


def _out(r) -> dict:
    d = dict(r)
    d["counts"] = json.loads(d.get("counts") or "{}")
    d["log"] = json.loads(d.get("log") or "[]")
    return d


@router.get("")
def jobs(user=READ):
    rows = _con().execute("SELECT * FROM reg_uploads ORDER BY created_at DESC LIMIT 50").fetchall()
    alive = R.runner_alive()
    # A job left QUEUED or RUNNING with no runner was interrupted (a restart, a
    # shutdown). Start the runner again: it re-queues the job and resumes from
    # the answers cached in the job folder, so nothing already read is redone.
    if not alive and any(r["status"] in ("QUEUED", "RUNNING") for r in rows):
        R.kick()
        alive = True
    return {"items": [_out(r) for r in rows], "runner": alive}


@router.get("/llm")
def llm(user=READ):
    ok, msg = R.llm_up()
    return {"ok": ok, "detail": msg}


@router.get("/{jid}")
def job(jid: str, user=READ):
    r = _con().execute("SELECT * FROM reg_uploads WHERE id=?", (jid,)).fetchone()
    if not r:
        raise HTTPException(404, "no such upload")
    return _out(r)


@router.post("")
async def upload(file: UploadFile = File(...), title: str = Form(default=""), regulator: str = Form(default=""),
                 regulation_type: str = Form(default=""), jurisdiction: str = Form(default=""),
                 attach_to: str = Form(default=""), user=WRITE):
    name = re.sub(r"[^\w.\- ()]+", "_", (file.filename or "regulation").split("/")[-1].split("\\")[-1])[:150]
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if ext not in ALLOWED:
        raise HTTPException(400, f"Upload a PDF, DOCX or text file (got {ext or 'no extension'}).")
    body = await file.read()
    if not body:
        raise HTTPException(400, "The file is empty.")
    if len(body) > MAX_BYTES:
        raise HTTPException(400, f"The file is larger than {MAX_BYTES // 1024 // 1024} MB.")
    con = _con()
    attach_to = attach_to.strip()
    if attach_to:
        reg = con.execute("SELECT id, title FROM regulations WHERE id=?", (attach_to,)).fetchone()
        if not reg:
            raise HTTPException(400, f"No regulation {attach_to!r}.")
        rid, title = reg["id"], title.strip() or reg["title"]
    else:
        base = "upl-" + (R.slug(title or name.rsplit(".", 1)[0])[:60] or "regulation")
        rid, n = base, 2
        while con.execute("SELECT 1 FROM regulations WHERE id=?", (rid,)).fetchone() or \
                con.execute("SELECT 1 FROM reg_uploads WHERE regulation_id=?", (rid,)).fetchone():
            rid, n = f"{base}-{n}", n + 1
    jid = secrets.token_hex(4)
    d = R.ROOT / jid
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(body)
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    con.execute(
        """INSERT INTO reg_uploads (id,regulation_id,attach,filename,title,regulator,regulation_type,jurisdiction,
             status,stage,message,counts,log,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (jid, rid, 1 if attach_to else 0, name, title.strip(), regulator.strip(), regulation_type.strip(),
         jurisdiction.strip(), "QUEUED", "queued", "Waiting to start", json.dumps({"bytes": len(body)}), "[]",
         (user or {}).get("email") if isinstance(user, dict) else getattr(user, "email", None), ts, ts))
    con.commit()
    R.kick()
    return _out(con.execute("SELECT * FROM reg_uploads WHERE id=?", (jid,)).fetchone())


@router.post("/{jid}/retry")
def retry(jid: str, user=WRITE):
    con = _con()
    r = con.execute("SELECT status FROM reg_uploads WHERE id=?", (jid,)).fetchone()
    if not r:
        raise HTTPException(404, "no such upload")
    if r["status"] in ("QUEUED", "RUNNING") and R.runner_alive():
        raise HTTPException(409, "This upload is already being processed.")
    con.execute("UPDATE reg_uploads SET status='QUEUED', message='Waiting to start', finished_at=NULL WHERE id=?", (jid,))
    con.commit()
    R.kick()
    return {"queued": jid}


@router.delete("/{jid}")
def delete(jid: str, user=ADMIN):
    con = _con()
    r = con.execute("SELECT status FROM reg_uploads WHERE id=?", (jid,)).fetchone()
    if not r:
        raise HTTPException(404, "no such upload")
    if r["status"] == "RUNNING" and R.runner_alive():
        raise HTTPException(409, "Wait for this upload to finish (or fail) before removing it.")
    return R.remove(con, jid)
