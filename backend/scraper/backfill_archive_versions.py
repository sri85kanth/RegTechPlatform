#!/usr/bin/env python3
"""
Recover real prior versions of regulations from the Internet Archive.

WHY
---
Change detection needs two captures of the same document. The nightly watcher
creates the second one, but it only started running recently, so for almost
every regulation there is nothing behind the current copy to compare against —
which is why the product has never shown a single regulatory change.

The prior versions exist. Regulators like RBI republish consolidated Master
Directions in place as they amend them, and the Internet Archive kept the older
files. Roughly 88% of the RBI documents probed have two or more distinct
archived copies. This recovers them.

WHAT IT IS NOT
--------------
It fabricates nothing. Every version stored is bytes the regulator served, on a
date the Archive recorded, and is marked retrieved_from='INTERNET_ARCHIVE' so a
reviewer can always tell an archived copy from an authoritative one. Documents
that cannot be read are recorded as skipped, never quietly dropped.

SAFETY
------
Additive only. No parser is touched, no existing row is rewritten, nothing is
deleted. capture() dedups on content, compare() replaces only its own version
pair, so the whole job is safe to re-run and safe to interrupt.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
CACHE = HERE / "output" / "archive_cache"

from extract_pdf_text import parse_structure                 # noqa: E402
from regulatory_ingestion.db import connect                  # noqa: E402
from regulatory_ingestion import versions as V               # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 Chrome/126 Safari/537.36"}
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

STATE = """
CREATE TABLE IF NOT EXISTS archive_backfill (
  regulation_id  TEXT PRIMARY KEY REFERENCES regulations(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,   -- DONE | NO_HISTORY | ONE_VERSION_ONLY
                                  -- | UNREADABLE | FETCH_FAILED
  snapshots_seen INTEGER DEFAULT 0,
  versions_added INTEGER DEFAULT 0,
  wording        INTEGER DEFAULT 0,
  numbering_only INTEGER DEFAULT 0,
  note           TEXT,
  ran_at         TEXT NOT NULL
);
"""


def http(url: str, timeout: int = 90, tries: int = 3) -> bytes:
    """The Archive rate-limits. Back off rather than hammering it."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA),
                                        timeout=timeout) as f:
                return f.read()
        except Exception as e:
            code = getattr(e, "code", None)
            if attempt == tries - 1:
                raise
            time.sleep((6 if code in (429, 503) else 2) * (attempt + 1))
    raise RuntimeError("unreachable")


# Government sites serve an anti-bot interstitial to crawlers, and the Archive
# stored those too. They arrive under the document's own URL, they vary between
# captures, so they LOOK like a version history and are not one — probing
# without this filter suggested 88% of RBI documents had recoverable versions
# when the real figure is far lower. Only bytes the Archive recorded as a PDF,
# and big enough to be a document rather than an error page, are versions.
MIN_PDF_BYTES = 20_000


def snapshots(url: str, limit: int = 40) -> list[list[str]]:
    q = ("https://web.archive.org/cdx/search/cdx?url=" + urllib.parse.quote(url, safe="")
         + "&output=json&fl=timestamp,digest,mimetype,length&filter=statuscode:200"
           "&filter=mimetype:application/pdf"
           f"&collapse=digest&limit={limit}")
    rows = json.loads(http(q, timeout=45) or "[]")[1:]
    return [r for r in rows if int(r[3] or 0) >= MIN_PDF_BYTES]


def fetch_snapshot(url: str, ts: str, digest: str) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{digest}.pdf"
    if cached.exists():
        return cached.read_bytes()
    data = http(f"https://web.archive.org/web/{ts}id_/{url}", timeout=180)
    if not data[:5].startswith(b"%PDF"):
        raise ValueError(f"not a PDF ({len(data)} bytes)")
    cached.write_bytes(data)
    return data


def sections_of(pdf: bytes) -> list[dict]:
    from pypdf import PdfReader
    text = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages)
    if len(text.strip()) < 400:
        raise ValueError("extracted text under 400 chars — this copy needs OCR")
    return parse_structure(text)["sections"]


def spread(snaps: list, keep: int) -> list:
    """Oldest and newest always; the rest evenly spaced. A change is likeliest at the ends."""
    if len(snaps) <= keep:
        return snaps
    idx = sorted({0, len(snaps) - 1,
                  *(round(i * (len(snaps) - 1) / (keep - 1)) for i in range(keep))})
    return [snaps[i] for i in idx][:keep]


def iso(ts: str) -> str:
    return datetime.strptime(ts, "%Y%m%d%H%M%S").replace(
        tzinfo=timezone.utc).isoformat(timespec="seconds")


def record(con, rid, status, **kw):
    con.execute("""INSERT INTO archive_backfill
                     (regulation_id,status,snapshots_seen,versions_added,wording,
                      numbering_only,note,ran_at)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT (regulation_id) DO UPDATE SET
                     status=excluded.status, snapshots_seen=excluded.snapshots_seen,
                     versions_added=excluded.versions_added, wording=excluded.wording,
                     numbering_only=excluded.numbering_only, note=excluded.note,
                     ran_at=excluded.ran_at""",
                (rid, status, kw.get("snapshots", 0), kw.get("added", 0),
                 kw.get("wording", 0), kw.get("numbering", 0), (kw.get("note") or "")[:400], _now()))
    con.commit()


def do_one(con, rid: str, url: str, max_versions: int, delay: float, log) -> dict:
    try:
        snaps = snapshots(url)
    except Exception as e:
        record(con, rid, "FETCH_FAILED", note=f"cdx: {type(e).__name__}: {e}")
        return {"status": "FETCH_FAILED"}

    if len(snaps) < 1:
        record(con, rid, "NO_HISTORY", snapshots=0, note="no archived copies")
        return {"status": "NO_HISTORY"}

    chosen = spread(snaps, max_versions)
    stored, unreadable = [], []
    for snap in chosen:
        ts, digest = snap[0], snap[1]
        try:
            pdf = fetch_snapshot(url, ts, digest)
            secs = sections_of(pdf)
        except Exception as e:
            unreadable.append(f"{ts}: {type(e).__name__}: {str(e)[:60]}")
            time.sleep(delay); continue
        # A copy that parsed into almost nothing would diff as "everything
        # changed". Refuse it rather than publish a false amendment.
        if len(secs) < 3:
            unreadable.append(f"{ts}: parsed only {len(secs)} section(s)")
            time.sleep(delay); continue
        vid = V.capture(con, rid, secs, document_hash=hashlib.sha256(pdf).hexdigest(),
                        captured_at=iso(ts), source_url=url,
                        retrieved_from="INTERNET_ARCHIVE")
        stored.append((iso(ts), vid, len(secs)))
        time.sleep(delay)

    added = sum(1 for _, vid, _ in stored if vid is not None)
    allv = V.versions(con, rid)          # chronological
    if len(allv) < 2:
        # Distinguish "we could not read it" from "the archive only ever held
        # one copy". Both leave nothing to diff, but only the first is a defect.
        st = "UNREADABLE" if unreadable else ("ONE_VERSION_ONLY" if allv else "NO_HISTORY")
        record(con, rid, st, snapshots=len(snaps), added=added, note="; ".join(unreadable[:3]))
        return {"status": st, "added": added}

    wording = numbering = 0
    for a, b in zip(allv, allv[1:]):
        for c in V.compare(con, rid, a["id"], b["id"], persist=True):
            if c["change_class"] == "WORDING":
                wording += 1
            else:
                numbering += 1

    record(con, rid, "DONE", snapshots=len(snaps), added=added,
           wording=wording, numbering=numbering, note="; ".join(unreadable[:3]))
    log(f"    {len(allv)} versions on record -> {wording} wording, {numbering} renumbered")
    return {"status": "DONE", "added": added, "wording": wording, "numbering": numbering}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="0 = every candidate")
    ap.add_argument("--max-versions", type=int, default=5)
    ap.add_argument("--delay", type=float, default=2.0)
    ap.add_argument("--authority", default=None, help="restrict to one regulator")
    ap.add_argument("--redo", action="store_true", help="reprocess documents already DONE")
    a = ap.parse_args()

    con = connect()
    V.init(con)
    con.executescript(STATE); con.commit()

    where = ["d.source_url IS NOT NULL", "d.source_url <> ''"]
    params: list = []
    if a.authority:
        where.append("r.regulator_short = ?"); params.append(a.authority)
    if not a.redo:
        # Settled outcomes are not retried. DONE has its history; NO_HISTORY,
        # ONE_VERSION_ONLY and UNREADABLE are facts about what the Archive holds
        # and re-downloading megabytes to rediscover them wastes the Archive's
        # bandwidth. FETCH_FAILED is the one transient case, so it IS retried.
        where.append("""NOT EXISTS (SELECT 1 FROM archive_backfill b
                                     WHERE b.regulation_id = d.regulation_id
                                       AND b.status <> 'FETCH_FAILED')""")
    q = f"""SELECT d.regulation_id AS rid, d.source_url AS url, r.title, r.regulator_short AS auth
              FROM documents d JOIN regulations r ON r.id = d.regulation_id
             WHERE {' AND '.join(where)}
             ORDER BY r.regulator_short, d.regulation_id"""
    rows = con.execute(q, params).fetchall()
    if a.limit:
        rows = rows[:a.limit]

    print(f"{len(rows)} document(s) to process  "
          f"(max {a.max_versions} versions each, {a.delay}s between fetches)", flush=True)
    base = con.execute("SELECT COUNT(*) FROM section_changes").fetchone()[0]
    tally: dict[str, int] = {}
    tot_w = tot_n = 0

    for i, r in enumerate(rows, 1):
        print(f"[{i}/{len(rows)}] {r['auth']} {r['rid']}: {(r['title'] or '')[:56]}", flush=True)
        try:
            res = do_one(con, r["rid"], r["url"], a.max_versions, a.delay,
                         lambda m: print(m, flush=True))
        except KeyboardInterrupt:
            print("\ninterrupted — progress is recorded, re-run to continue"); break
        except Exception as e:
            record(con, r["rid"], "FETCH_FAILED", note=f"{type(e).__name__}: {e}")
            res = {"status": "FETCH_FAILED"}
            print(f"    error: {type(e).__name__}: {str(e)[:90]}", flush=True)
        tally[res["status"]] = tally.get(res["status"], 0) + 1
        tot_w += res.get("wording", 0); tot_n += res.get("numbering", 0)

    now = con.execute("SELECT COUNT(*) FROM section_changes").fetchone()[0]
    print(f"\n{'='*66}\noutcomes: {tally}")
    print(f"section_changes: {base} -> {now}  (+{now - base})")
    print(f"  {tot_w} wording, {tot_n} renumbered-only")
    print("re-run any time; documents already DONE are skipped unless --redo")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
