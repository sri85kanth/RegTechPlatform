"""Ingest the hospital authority documents.

These come from the hospital authority register workbook: 1,097 PDFs, each with
the authority that issued it, a topic, and the official URL it was downloaded
from. That is better provenance than the TeamLease batch had, so it is carried
into the record rather than dropped — official_document_url is the real source,
not a guess.

Everything downstream of registration is ingest_teamlease's, imported rather
than copied: the full-text fallback for documents with no numbered structure,
the NUL/surrogate stripping, the deferred OCR, and the per-worker reconnect.
Those were each written for a failure this batch can hit too.

    python ingest_hospital.py --shards 6 --shard 0 --gate-file output/gate.json
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import ingest_teamlease as T

HERE = Path(__file__).parent
MANIFEST = HERE / "input" / "hospital_manifest.csv"
DOCS_DIR = HERE / "output" / "documents"
SECTOR = "Healthcare & Hospitals"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

# The Documents sheet names issuers by short code; the Authority register sheet
# spells them out and gives each a type, but only for the codes it covers. These
# are the central bodies it does not, written out once here so a region is
# derived from something stated rather than assumed silently.
CENTRAL = {
    "AERB": "Atomic Energy Regulatory Board",
    "CDSCO": "Central Drugs Standard Control Organisation",
    "CEA": "Central Electricity Authority",
    "CPCB": "Central Pollution Control Board",
    "DGHS": "Directorate General of Health Services",
    "ICMR": "Indian Council of Medical Research",
    "INC": "Indian Nursing Council",
    "IPC": "Indian Pharmacopoeia Commission",
    "IRDAI": "Insurance Regulatory and Development Authority of India",
    "MCA": "Ministry of Corporate Affairs",
    "MeitY": "Ministry of Electronics and Information Technology",
    "MoHFW": "Ministry of Health and Family Welfare",
    "NABH": "National Accreditation Board for Hospitals & Healthcare Providers",
    "NCAHP": "National Commission for Allied and Healthcare Professions",
    "NDMA": "National Disaster Management Authority",
    "NHRC": "National Human Rights Commission",
    "NMC": "National Medical Commission",
    "NPPA": "National Pharmaceutical Pricing Authority",
    "PCI": "Pharmacy Council of India",
    "Legal Metrology": "Department of Legal Metrology",
}


def state_of(auth_type: str) -> str | None:
    m = re.search(r"State\s*\(([^)]+)\)", auth_type or "")
    return m.group(1).strip() if m else None


def register_one(con, d: dict) -> None:
    from ingest_harvest import instrument_type
    rid, title = d["id"], d["title"]
    authority = d["authority"] or ""
    full = CENTRAL.get(authority, authority)
    state = state_of(d.get("authority_type", ""))
    rtype = instrument_type(title)
    con.execute(
        """INSERT INTO regulations
             (id, title, regulator, regulator_short, regulation_type, sector,
              jurisdiction, country, state, source_url, official_document_url,
              ingestion_status, status, source_verified, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (id) DO UPDATE SET
             title=EXCLUDED.title, regulator=EXCLUDED.regulator,
             regulator_short=EXCLUDED.regulator_short, sector=EXCLUDED.sector,
             state=EXCLUDED.state, source_url=EXCLUDED.source_url,
             official_document_url=EXCLUDED.official_document_url,
             updated_at=EXCLUDED.updated_at""",
        (rid, title, full, authority, rtype, SECTOR, "India", "India", state,
         d.get("authority_site") or d.get("official_url"), d.get("official_url"),
         "DISCOVERED", "Active", 0, _now(), _now()))
    con.execute("""INSERT INTO regulation_sectors (regulation_id, sector, derived_from, evidence)
                   VALUES (?,?,?,?) ON CONFLICT DO NOTHING""",
                (rid, SECTOR, "HOSPITAL_REGISTER", d.get("topic") or authority))
    if state:
        region = (state, "STATE", "STATE_SPECIFIC", "AUTHORITY_TYPE")
    else:
        # central bodies, standard-setters and professional councils: all-India.
        # derived_from records which of the two it was, so the assumption is
        # auditable rather than buried.
        region = ("*", "ALL", "ALL_INDIA",
                  "AUTHORITY_TYPE" if d.get("authority_type") else "AUTHORITY_DEFAULT")
    con.execute("""INSERT INTO regulation_regions
                     (regulation_id, state_ut, region_kind, coverage, derived_from, evidence)
                   VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING""",
                (rid, region[0], region[1], region[2], region[3],
                 d.get("authority_type") or authority))
    con.execute("""INSERT INTO regulation_types (regulation_id, type, source_type)
                   VALUES (?,?,?) ON CONFLICT DO NOTHING""",
                (rid, rtype, "Hospital authority register"))
    con.commit()


def ingest_one(d: dict) -> tuple[str, str, float, str]:
    from regulatory_ingestion import pipeline
    t0 = time.time()
    con = T._worker_con()
    rid = d["id"]
    try:
        register_one(con, d)
        reg = con.execute("SELECT id, title, regulator_short, official_document_url "
                          "FROM regulations WHERE id=?", (rid,)).fetchone()
        if not T.extract_validated(con, reg):
            con.commit()
            st = con.execute("SELECT ingestion_status FROM regulations WHERE id=?",
                             (rid,)).fetchone()[0]
            return rid, st or "FAILED", time.time() - t0, ""
        pipeline.process(con, rid)
        st = con.execute("SELECT ingestion_status FROM regulations WHERE id=?",
                         (rid,)).fetchone()[0]
        return rid, st, time.time() - t0, ""
    except Exception as e:  # noqa: BLE001 — one bad PDF must not stop the batch
        try:
            con = T._worker_con()
            con.rollback()
            pipeline.set_status(con, rid, "FAILED")
            pipeline.log(con, rid, "process", "FAILED", f"{type(e).__name__}: {e}")
            con.commit()
        except Exception:  # noqa: BLE001
            pass
        return rid, "FAILED", time.time() - t0, f"{type(e).__name__}: {e}"[:300]


def shard_of(rid: str, shards: int) -> int:
    """Which shard owns this document — decided by the id, not by its position.

    Sharding on `enumerate(pending)` looked equivalent and was not: the pending
    list shrinks as documents finish, so two shards listing it seconds apart
    compute different positions for the same document and both take it. 97
    documents were processed twice that way, the second one dying on
    "duplicate key value violates unique constraint sections_pkey". A hash of
    the id gives every shard the same answer whenever it asks.
    """
    return int(hashlib.blake2b(rid.encode(), digest_size=4).hexdigest(), 16) % shards


def ocr_backlog(con, rows: list[dict]) -> list[dict]:
    """The scans parked as OCR_REQUIRED during the main pass.

    Their extraction JSON (if any) is dropped so extract_one re-reads the PDF
    with OCR enabled rather than trusting the empty text layer that parked them.
    """
    ids = {r[0] for r in con.execute(
        "SELECT id FROM regulations WHERE id LIKE ? AND ingestion_status = 'OCR_REQUIRED'",
        ("ha-%",)).fetchall()}
    out = [d for d in rows if d["id"] in ids and (DOCS_DIR / f"{d['id']}.pdf").exists()]
    for d in out:
        (HERE / "output" / "extracted" / f"{d['id']}.json").unlink(missing_ok=True)
    return out


def pending(con, rows: list[dict], retry_failed: bool) -> list[dict]:
    done = ("MAPPED", "OCR_REQUIRED") if retry_failed else \
           ("MAPPED", "OCR_REQUIRED", "FAILED", "FAILED_FETCH")
    marks = ",".join("?" for _ in done)
    have = {r[0] for r in con.execute(
        f"SELECT id FROM regulations WHERE id LIKE ? AND ingestion_status IN ({marks})",
        ("ha-%",) + done).fetchall()}
    return [d for d in rows if d["id"] not in have and (DOCS_DIR / f"{d['id']}.pdf").exists()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", type=int, default=1)
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--follow", action="store_true")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--poll", type=int, default=120)
    ap.add_argument("--gate-file", required=True)
    ap.add_argument("--gate-drift-ok", action="store_true")
    ap.add_argument("--ocr-pass", action="store_true",
                    help="re-read the OCR_REQUIRED scans with OCR enabled; run few shards "
                         "so tesseract finishes inside its per-page timeout")
    a = ap.parse_args()

    import gate_offboard
    from regulatory_ingestion.db import connect
    rows = list(csv.DictReader(MANIFEST.open(encoding="utf-8-sig")))
    con = connect()
    names = [r[0] for r in con.execute("SELECT name FROM company_entities").fetchall()]
    try:
        generic = gate_offboard.load(con, Path(a.gate_file), names)
    except SystemExit as e:
        if not a.gate_drift_ok:
            raise
        g = json.loads(Path(a.gate_file).read_text())
        corpus = con.execute(
            "SELECT COUNT(DISTINCT regulation_id) FROM obligations").fetchone()[0]
        print(f"{_now()}  gate drift accepted: computed against {g['corpus']} regulations, "
              f"corpus now {corpus}; {len(g['generic'])} generic names. ({e})", flush=True)
        generic = set(g["generic"])
    con.commit()

    T._init_worker(generic, defer_ocr=not a.ocr_pass)
    tally: dict[str, int] = {}
    seen: set[str] = set()
    t_start = time.time()
    while True:
        found = ocr_backlog(con, rows) if a.ocr_pass else pending(con, rows, a.retry_failed)
        con.commit()
        todo = [d for d in found
                if shard_of(d["id"], a.shards) == a.shard and d["id"] not in seen]
        if a.limit:
            todo = todo[:max(0, a.limit - len(seen))]
        if todo:
            print(f"{_now()}  shard {a.shard}/{a.shards}: {len(todo)} documents", flush=True)
            for d in todo:
                seen.add(d["id"])
                rid, st, secs, detail = ingest_one(d)
                tally[st] = tally.get(st, 0) + 1
                n = sum(tally.values())
                rate = n / max(1.0, time.time() - t_start) * 3600
                print(f"[{n}] {rid:<52} {st:<13} {secs:6.1f}s ({rate:.0f}/h) {detail}",
                      flush=True)
        if (a.limit and len(seen) >= a.limit) or not a.follow:
            break
        if not todo:
            if not pending(con, rows, a.retry_failed):
                break
            time.sleep(a.poll)
    print(json.dumps({"shard": a.shard, "tally": tally,
                      "seconds": round(time.time() - t_start, 1)}))


if __name__ == "__main__":
    main()
