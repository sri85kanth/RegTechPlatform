"""
Uploaded folders.

The folder connector reads a path ON THE SERVER. A browser can never hand us an
absolute path — a folder picker yields file contents and relative paths like
"Compliance/01-people.csv", never "/Users/you/Compliance" — so "upload a folder
and use its path" only works if the server takes the bytes and reports back
where it put them. That is what this does.

The result is a real directory the folder connector syncs exactly like a mounted
one. It is a SNAPSHOT, not a live link: re-collecting re-reads what was uploaded,
it does not go back to the user's machine. Callers should say so rather than let
"Collect now" imply a freshness it does not have.
"""
from __future__ import annotations

import os
import pathlib
import re
import unicodedata

# Everything uploaded lives under one root, so a traversal bug cannot reach past
# it and cleanup is a single directory. A company workspace (tenancy.py) sets
# CB_UPLOADS_DIR to its own folder, so one company's files are never under
# another's root.
ROOT = pathlib.Path(os.environ.get("CB_UPLOADS_DIR") or pathlib.Path(__file__).parent.parent / "output" / "uploads")

MAX_FILES = 2000
# 200 MB was below a real document corpus: the hospital folder alone is 107 MB
# and grows as files are added. nginx no longer caps the body and the volume has
# ~160 GB free, so the limit that matters is disk, not an arbitrary constant.
MAX_BYTES = 1024 * 1024 * 1024       # 1 GB per upload


def existing_batch_dir(raw: str) -> pathlib.Path | None:
    """
    Resolve a caller-supplied upload folder, or refuse.

    A folder upload is now sent in batches so that one stalled connection costs
    a batch rather than all 414 files. Every batch after the first names the
    folder the first one created, which means an attacker-controllable path
    reaches the filesystem — so it is resolved and required to sit directly
    under ROOT. Anything else returns None and the caller starts a new folder.
    """
    if not raw:
        return None
    try:
        target = pathlib.Path(raw).expanduser().resolve()
        root = ROOT.resolve()
    except Exception:
        return None
    if target.parent != root or not target.is_dir():
        return None
    return target


def _safe_segment(seg: str) -> str:
    """One path segment, stripped of anything that could escape the root."""
    seg = unicodedata.normalize("NFKD", seg)
    seg = seg.replace("\x00", "")
    seg = re.sub(r"[/\\]", "_", seg)          # no separators survive a segment
    if seg in ("", ".", ".."):
        return "_"
    return seg[:120]


def safe_relpath(raw: str) -> pathlib.PurePosixPath | None:
    """
    Sanitise a browser-supplied relative path.

    webkitRelativePath is attacker-controllable, so this never trusts it: each
    segment is sanitised individually and '..' can never survive. Returns None
    when nothing usable is left.
    """
    raw = (raw or "").strip().replace("\\", "/")
    # _safe_segment already turns "..", "." and empties into "_", so no
    # traversal segment survives to be filtered afterwards.
    parts = [_safe_segment(p) for p in raw.split("/") if p not in ("", ".")]
    if not parts:
        return None
    return pathlib.PurePosixPath(*parts)


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "folder").lower()).strip("-")
    return (s or "folder")[:40]


def target_dir(name: str, stamp: str) -> pathlib.Path:
    d = ROOT / f"{slug(name)}-{stamp}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def resolve_inside(base: pathlib.Path, rel: pathlib.PurePosixPath) -> pathlib.Path:
    """
    Final guard. Even with per-segment sanitising, the written path is resolved
    and checked to be under base — a defence that does not depend on the string
    handling above being perfect.
    """
    full = (base / rel).resolve()
    base_r = base.resolve()
    if not str(full).startswith(str(base_r) + "/") and full != base_r:
        raise ValueError(f"refusing to write outside the upload root: {rel}")
    return full
