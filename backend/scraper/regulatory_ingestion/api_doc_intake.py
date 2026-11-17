"""
Document intake endpoints — a folder of documents, sorted into the company structure.

  POST /api/intake/batches                start sorting a folder (an upload, or a connected folder)
  GET  /api/intake/batches                every upload, newest first
  GET  /api/intake/batches/{id}           one upload: progress, what was found, the items
  GET  /api/intake/items/{id}             one item: the evidence for each decision, the text read
  PATCH /api/intake/items/{id}            fix its type, department, title or owner (optionally remembered)
  POST /api/intake/items/save             file the chosen items into the company structure
  POST /api/intake/items/skip             leave the chosen items out
  POST /api/intake/batches/{id}/undo      remove what an upload filed, while still unverified
  GET  /api/intake/departments            the departments an item can be placed in
  GET  /api/intake/rules · DELETE /rules/{id}   what intake has been taught

Reading needs `read`; anything that writes to the company structure needs `approve`,
the same as collecting a folder does.
"""
from __future__ import annotations

import json
import pathlib

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from . import company_db, doc_intake as DI, upload_store as U
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/intake", tags=["intake"])
READ = Depends(require("read"))
WRITE = Depends(require("approve"))


def _con():
    con = connect()
    company_db.init(con)
    return DI.init(con)


def _actor(user) -> str:
    return (user or {}).get("email") or "anonymous"


def _allowed_root(con, path: str) -> pathlib.Path:
    """Only the upload area and folders already connected as integrations can be read."""
    try:
        p = pathlib.Path(path).expanduser().resolve()
    except Exception:                                           # noqa: BLE001
        raise HTTPException(400, "That path cannot be read.")
    bases = [U.ROOT.resolve()]
    for r in con.execute("SELECT config FROM integrations WHERE connector='folder'"):
        try:
            cp = json.loads(r["config"] or "{}").get("path")
            if cp:
                bases.append(pathlib.Path(cp).expanduser().resolve())
        except (TypeError, ValueError):
            pass
    if not any(p == b or p.is_relative_to(b) for b in bases):
        raise HTTPException(403, "Only an uploaded folder or a connected folder can be sorted.")
    if not p.is_dir():
        raise HTTPException(404, "That folder is no longer on the server.")
    return p


def _batch(r) -> dict:
    d = dict(r)
    d.pop("options", None)
    return d


def _item(r, full: bool = False) -> dict:
    d = dict(r)
    for k in ("people", "refs", "reasons"):
        try:
            d[k] = json.loads(d.get(k) or "[]")
        except ValueError:
            d[k] = []
    if not full:
        d.pop("text", None)
    return d


@router.post("/batches")
def start_batch(body: dict = Body(...), user=WRITE):
    con = _con()
    root = _allowed_root(con, str(body.get("path") or ""))
    label = (str(body.get("label") or "") or root.name)[:120]
    bid = DI.start(root=str(root), label=label, actor=_actor(user), integration_id=body.get("integration_id"),
                   use_llm=body.get("use_llm", True) is not False)
    return {"id": bid}


@router.get("/batches")
def list_batches(user=READ):
    con = _con()
    rows = con.execute("SELECT * FROM intake_batches ORDER BY created_at DESC LIMIT 100").fetchall()
    return {"items": [_batch(r) for r in rows]}


@router.get("/batches/{bid}")
def get_batch(bid: str, user=READ):
    con = _con()
    b = con.execute("SELECT * FROM intake_batches WHERE id=?", (bid,)).fetchone()
    if not b:
        raise HTTPException(404, "No such upload.")
    items = [_item(r) for r in con.execute(
        "SELECT * FROM intake_items WHERE batch_id=? ORDER BY file, part", (bid,))]
    by_type: dict[str, int] = {}
    by_dept: dict[str, dict] = {}
    people = {"matched": 0, "unmatched": 0}
    for it in items:
        if it["status"] in ("DUPLICATE", "SKIPPED", "UNDONE"):
            continue
        by_type[it["doc_type"]] = by_type.get(it["doc_type"], 0) + 1
        key = it["department"] or "—"
        d = by_dept.setdefault(key, {"name": it["department"] or "", "status": it["department_status"], "count": 0})
        d["count"] += 1
        for p in it["people"]:
            people["matched" if p.get("entity_id") else "unmatched"] += 1
    return {
        "batch": _batch(b), "items": items,
        "summary": {
            "types": sorted(({"type": k, "count": v} for k, v in by_type.items()), key=lambda x: -x["count"]),
            "departments": sorted(by_dept.values(), key=lambda x: -x["count"]),
            "people": people,
            "status": {s: sum(1 for i in items if i["status"] == s)
                       for s in ("SAVED", "REVIEW", "READY", "ON_RECORD", "DUPLICATE", "SKIPPED", "UNDONE")},
        },
    }


@router.get("/items/{iid}")
def get_item(iid: str, user=READ):
    con = _con()
    r = con.execute("SELECT * FROM intake_items WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "No such document.")
    d = _item(r, full=True)
    d["text"] = (d.get("text") or "")[:20000]
    if d.get("entity_id"):
        e = con.execute("SELECT id, domain, name, verification FROM company_entities WHERE id=?",
                        (d["entity_id"],)).fetchone()
        d["entity"] = dict(e) if e else None
    if d.get("existing_entity_id"):
        e = con.execute("SELECT id, domain, name, verification FROM company_entities WHERE id=?",
                        (d["existing_entity_id"],)).fetchone()
        d["existing"] = dict(e) if e else None
    return d


@router.patch("/items/{iid}")
def correct_item(iid: str, body: dict = Body(...), user=WRITE):
    con = _con()
    r = con.execute("SELECT status FROM intake_items WHERE id=?", (iid,)).fetchone()
    if not r:
        raise HTTPException(404, "No such document.")
    if r["status"] not in ("REVIEW", "READY"):
        raise HTTPException(409, "Only a document waiting for review can be changed here.")
    changes = {k: body[k] for k in ("doc_type", "department", "title", "owner_id", "owner_text") if k in body}
    if "doc_type" in changes and changes["doc_type"] not in DI.HOME:
        raise HTTPException(400, f"Type must be one of: {', '.join(DI.TYPES)}.")
    try:
        out = DI.correct(con, iid, changes, actor=_actor(user), remember=bool(body.get("remember")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    out["item"] = _item(con.execute("SELECT * FROM intake_items WHERE id=?", (iid,)).fetchone())
    return out


def _ids(body: dict) -> list[str]:
    ids = [str(x) for x in (body.get("ids") or []) if x]
    if not ids:
        raise HTTPException(400, "Choose at least one document.")
    return ids[:2000]


@router.post("/items/save")
def save_items(body: dict = Body(...), user=WRITE):
    con = _con()
    ids = _ids(body)
    waiting = [r["id"] for r in con.execute(
        "SELECT id FROM intake_items WHERE id = ANY(?) AND status IN ('REVIEW','READY')", (ids,))]
    return DI.save(con, waiting, actor=_actor(user), how="reviewed")


@router.post("/items/skip")
def skip_items(body: dict = Body(...), user=WRITE):
    con = _con()
    ids = _ids(body)
    n = con.execute("""UPDATE intake_items SET status='SKIPPED', decided_by=?, updated_at=?
                        WHERE id = ANY(?) AND status IN ('REVIEW','READY')""",
                    (_actor(user), DI._now(), ids)).rowcount
    con.commit()
    for (bid,) in {(r["batch_id"],) for r in con.execute(
            "SELECT DISTINCT batch_id FROM intake_items WHERE id = ANY(?)", (ids,))}:
        DI._refresh_counts(con, bid)
    return {"skipped": n}


@router.post("/batches/{bid}/undo")
def undo_batch(bid: str, user=WRITE):
    con = _con()
    b = con.execute("SELECT status FROM intake_batches WHERE id=?", (bid,)).fetchone()
    if not b:
        raise HTTPException(404, "No such upload.")
    if b["status"] == "RUNNING":
        raise HTTPException(409, "This upload is still being sorted.")
    return DI.undo(con, bid, actor=_actor(user))


@router.get("/departments")
def departments(user=READ):
    con = _con()
    k = DI.Knowledge(con)
    return {"items": sorted(({"id": n["id"], "name": n["name"]} for n in k.depts.values()),
                            key=lambda x: x["name"].lower())}


@router.get("/rules")
def rules(user=READ):
    con = _con()
    return {"items": [dict(r) for r in con.execute("SELECT * FROM intake_rules ORDER BY created_at DESC")]}


@router.delete("/rules/{rid}")
def forget_rule(rid: str, user=WRITE):
    con = _con()
    n = con.execute("DELETE FROM intake_rules WHERE id=?", (rid,)).rowcount
    con.commit()
    if not n:
        raise HTTPException(404, "No such rule.")
    return {"ok": True}
