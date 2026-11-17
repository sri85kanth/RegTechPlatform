"""
The company's logo — shown on the Companies screen and in the company menu.

Kept on the company's own profile row (company_profile.logo) as a small data
URL, so every company workspace has its own and nothing needs a file store or
a public URL. The browser shrinks raster images to 256 px before sending; the
server only checks the type and the size. It is only ever shown through an
<img> element, where an SVG cannot run script, and SVGs carrying script or
event handlers are refused all the same.
"""
from __future__ import annotations

import base64
import re
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from . import company_db
from .api_auth import require

router = APIRouter(prefix="/api/company/logo", tags=["company"])
MAX_BYTES = 300_000
_DATA_URL = re.compile(r"^data:image/(png|jpeg|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$")
_ready = False


def _con():
    global _ready
    con = company_db.init()
    if not _ready:
        con.execute("ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS logo TEXT")
        con.commit()
        _ready = True
    return con


@router.get("", dependencies=[Depends(require("read"))])
def get_logo():
    r = _con().execute("SELECT logo FROM company_profile ORDER BY id LIMIT 1").fetchone()
    return {"logo": r[0] if r else None}


@router.put("", dependencies=[Depends(require("approve"))])
def set_logo(payload: dict[str, Any] = Body(...)):
    logo = str(payload.get("logo") or "").strip()
    m = _DATA_URL.match(logo)
    if not m:
        raise HTTPException(400, "the logo must be a PNG, JPG, WebP or SVG image")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception:                                                   # noqa: BLE001
        raise HTTPException(400, "the logo could not be read")
    if len(raw) > MAX_BYTES:
        raise HTTPException(400, f"the logo is larger than {MAX_BYTES // 1000} KB")
    if m.group(1) == "svg+xml" and re.search(rb"<script|\son\w+\s*=|javascript:", raw, re.I):
        raise HTTPException(400, "that SVG contains script; export it again as a plain image")
    con = _con()
    if not con.execute("UPDATE company_profile SET logo = ? WHERE id = (SELECT min(id) FROM company_profile)",
                       (logo,)).rowcount:
        raise HTTPException(409, "save the company profile first")
    company_db.log(con, "profile", "company logo changed", "", "api")
    con.commit()
    return {"saved": True}


@router.delete("", dependencies=[Depends(require("approve"))])
def remove_logo():
    con = _con()
    con.execute("UPDATE company_profile SET logo = NULL")
    company_db.log(con, "profile", "company logo removed", "", "api")
    con.commit()
    return {"removed": True}
