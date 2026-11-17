"""
Integration endpoints.

Secrets are write-only: they are accepted on POST and never appear in any
response. Status is never asserted — /test reaches the real system and reports
what happened, and /sync writes only what it actually collected.
"""
import pathlib
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile

from . import company_db, integrations as I, upload_store as U
from .api_auth import require
from .db import connect

router = APIRouter(prefix="/api/integrations", tags=["integrations"])

# Every route below carries a capability. This router previously had none, so
# with enforcement on the rest of the API answering 401, /api/integrations still
# answered 200 to anyone who could reach the port — enough to read connections,
# post a credential, trigger a sync into the graph, or delete a connection.
# Reads need `read`; anything that changes config, reaches an external system or
# writes to disk needs `approve`.
READ = Depends(require("read"))
WRITE = Depends(require("approve"))


def _con():
    return I.init(connect())


@router.get("/catalogue")
def catalogue(user=READ):
    """Which systems we can talk to, and what each one actually contributes."""
    connectors = I.runtime_catalogue()
    return {
        "connectors": connectors,
        "readyNow": [c["id"] for c in connectors if c["ready"]],
        # The UI renders a scheme picker from this rather than hardcoding a list
        # that would drift from what _http actually supports.
        "authSchemes": [{"id": k, "hint": v} for k, v in I.AUTH_SCHEMES.items()],
        "note": "Connectors marked ready can be used now. The rest need an OAuth client "
                "or API credential for your tenant before they can be exercised.",
    }


@router.get("")
def list_integrations(user=READ):
    con = _con()
    out = I.listing(con)
    for i in out:
        i["syncs"] = I.syncs(con, i["id"], limit=5)
        # Whether "Sync" can ever see new files, or is re-reading a frozen copy.
        i["is_upload_snapshot"] = (i.get("connector") == "folder"
                                   and _is_upload_snapshot(i.get("config") or {}))
    return {"items": out, "total": len(out)}


@router.post("")
def create(payload: dict[str, Any] = Body(...), user=WRITE):
    connector = payload.get("connector", "")
    if connector not in I.BY_ID:
        raise HTTPException(400, f"unknown connector {connector!r}")
    label = (payload.get("label") or I.BY_ID[connector]["name"]).strip()
    config = payload.get("config") or {}
    # A path connector is checked here, not only on /test. Saving an unusable
    # path produced connections like "dfsdfds" that sat in the list as FAILED —
    # the error belongs on the form the path was typed into.
    if I.BY_ID[connector]["auth"] == "path":
        raw = (config.get("path") or "").strip()
        if not raw:
            raise HTTPException(400, "A folder path is required.")
        cand = pathlib.Path(raw).expanduser()
        if not cand.exists():
            raise HTTPException(400, f"{cand} does not exist on the server.")
        if not cand.is_dir():
            raise HTTPException(400, f"{cand} is a file, not a folder.")
        config["path"] = str(cand)
    else:
        # Caught on the form, where the address was typed, rather than as a
        # "connection refused" on the first test.
        try:
            I.check_public_url(config.get("url") or "")
        except I.NotPublicURL as e:
            raise HTTPException(400, str(e))
    try:
        # A pasted key picks up stray whitespace; no key legitimately starts or
        # ends with a space, and one that does is rejected as a different key.
        return I.add(_con(), connector=connector, label=label,
                     config=config, secret=(payload.get("secret") or "").strip() or None)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{iid}/test")
def test(iid: str, user=WRITE):
    try:
        return I.test(_con(), iid)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/{iid}/secret")
def change_secret(iid: str, payload: dict[str, Any] = Body(...), user=WRITE):
    """
    Replace a connection's key without deleting the connection.

    Before this, the only way to correct a wrong key was to delete the
    connection and build it again — and a key that is rotated, as a partner's
    should be, would have needed the same. Write-only like every secret here:
    the response carries the connection, never the key.
    """
    con = _con()
    row = I.get(con, iid)
    if not row:
        raise HTTPException(404, "no such connection")
    if I.BY_ID.get(row["connector"], {}).get("auth") == "path":
        raise HTTPException(400, "A folder connection has no key.")
    secret = (payload.get("secret") or "").strip()
    if not secret:
        raise HTTPException(400, "Paste the key.")
    I.set_secret(con, iid, secret)
    I._set_status(con, iid, "NOT_CONNECTED", "Key changed — test the connection.")
    return I.get(con, iid)


@router.post("/{iid}/sync")
def sync(iid: str, user=WRITE):
    con = _con()
    try:
        run = I.sync(con, iid, company_db)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"run": run, "integration": I.get(con, iid)}


@router.get("/{iid}/syncs")
def sync_history(iid: str, limit: int = 20, user=READ):
    return {"items": I.syncs(_con(), iid, limit)}


@router.delete("/{iid}")
def delete(iid: str, user=WRITE):
    con = _con()
    if not I.get(con, iid):
        raise HTTPException(404, "no such integration")
    I.remove(con, iid)
    return {"deleted": iid}


def _is_upload_snapshot(cfg: dict) -> bool:
    """
    A folder produced by the browser upload is a COPY taken at upload time, not
    a window onto the user's directory — upload_store says so in as many words.
    Re-collecting therefore re-reads the same frozen files forever, and files
    added to the original folder afterwards can never appear. Callers need to
    know which kind of folder they are looking at so the UI can stop implying
    that Sync will fetch anything new.
    """
    path = str((cfg or {}).get("path") or "")
    try:
        return bool(path) and pathlib.Path(path).resolve().is_relative_to(U.ROOT.resolve())
    except Exception:
        return False


@router.post("/upload")
async def upload_folder(
    files: list[UploadFile] = File(...),
    paths: list[str] = Form(default=[]),
    label: str = Form(default="Uploaded folder"),
    into: str = Form(default=""),
    user=WRITE,
):
    """
    Take a folder from the browser and report the server path it landed on.

    A browser cannot disclose an absolute path — a folder picker yields file
    contents and relative paths ("Compliance/01-people.csv"), never the parent
    directory. So the only way "upload a folder and use its path" can work is
    for the server to receive the bytes and answer with where it put them. The
    result is an ordinary directory the folder connector syncs like any other.

    `paths` carries each file's webkitRelativePath in the same order as `files`.
    It is attacker-controllable, so it is sanitised per segment and the final
    write target is re-checked against the upload root.
    """
    if not files:
        raise HTTPException(400, "No files received.")
    if len(files) > U.MAX_FILES:
        raise HTTPException(400, f"Too many files ({len(files)}); the limit is {U.MAX_FILES}.")

    # A 414-file folder used to be one multipart request. On a slow uplink to a
    # loaded host the browser gave up part-way and nginx logged 499 — the client
    # closing the connection — and every file was lost with it. The client now
    # sends batches; the first creates the folder and the rest name it here, so
    # a dropped batch costs that batch alone and can be retried.
    dest = U.existing_batch_dir(into)
    if dest is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        dest = U.target_dir(label, stamp)

    # One unusable file must not cost the other four hundred. Every file is
    # attempted; a duplicate path is overwritten (the newer copy is the one the
    # user just chose), and anything that cannot be written is recorded by name
    # and reported back rather than raised. The upload stops early only if it
    # would exceed the size ceiling, and even then it keeps what it already
    # wrote and says where it stopped.
    written = replaced = total = 0
    skipped: list[str] = []
    stopped_at: str | None = None
    for idx, f in enumerate(files):
        raw = paths[idx] if idx < len(paths) else (f.filename or "")
        rel = U.safe_relpath(raw)
        if rel is None:
            skipped.append(raw or f"<file {idx}>")
            continue
        try:
            body = await f.read()
        except Exception:                       # noqa: BLE001 — a bad part, not a bad upload
            skipped.append(raw)
            continue
        if total + len(body) > U.MAX_BYTES:
            stopped_at = raw
            break
        total += len(body)
        try:
            target = U.resolve_inside(dest, rel)
        except ValueError:
            skipped.append(raw)
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            existed = target.exists()
            target.write_bytes(body)            # replaces an existing copy
            written += 1
            replaced += 1 if existed else 0
        except Exception:                       # noqa: BLE001
            skipped.append(raw)

    if not written:
        raise HTTPException(400, "Nothing usable was uploaded.")

    return {
        "replaced": replaced,
        "stoppedAt": stopped_at,
        "sizeLimitMb": U.MAX_BYTES // (1024 * 1024),
        "path": str(dest),
        "files": written,
        "bytes": total,
        "skipped": skipped,
        # Said plainly so the UI can pass it on: this is a copy taken now, and
        # re-collecting re-reads the copy rather than the user's machine.
        "note": "A snapshot on the server. Collecting again re-reads these files; "
                "it does not return to your computer for changes.",
    }
