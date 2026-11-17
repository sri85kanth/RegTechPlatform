"""
Second pass: re-extract the regulations that matter with docling.

THE HYBRID
----------
    pypdf + regex   every document, ~2s each      breadth
    docling         MAPPED documents, ~2min each  depth

The fast pass stays the default and is untouched. This pass runs only over
documents worth two minutes, and adds what the fast pass structurally cannot
produce:

    * tables, with their rows intact instead of shredded into fake sections
    * section boundaries from real headings rather than a paragraph regex
    * amendment footnotes carrying the LINK to the amending circular

Nothing here deletes the fast-pass output. Sections are replaced only when
docling actually returns some, and the run is recorded in extraction_runs so
the UI can tell which extractor produced what it is showing.

    python enrich_mapped.py                 # all MAPPED regulations
    python enrich_mapped.py --ids reg-mdkyc # specific ones
    python enrich_mapped.py --limit 5       # a few
    python enrich_mapped.py --dry-run       # report, write nothing
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from datetime import datetime, timezone

from regulatory_ingestion.db import connect
from regulatory_ingestion import docling_extract as DX

HERE = pathlib.Path(__file__).parent
DOCS = HERE / "output" / "documents"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], 1)}


def iso_date(s: str) -> str | None:
    m = re.match(r"(?i)\s*(\w+)\s+(\d{1,2}),?\s*(\d{4})", s or "")
    if m and m.group(1).lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    m = re.match(r"\s*(\d{1,2})\s+(\w+),?\s*(\d{4})", s or "")
    if m and m.group(2).lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    return None


def source_for(con, rid: str) -> str | None:
    """Prefer the locally stored PDF; fall back to the official URL."""
    local = DOCS / f"{rid}.pdf"
    if local.exists():
        return str(local)
    r = con.execute(
        "SELECT storage_path, source_url FROM documents WHERE regulation_id=?", (rid,)).fetchone()
    if r:
        p = pathlib.Path(r["storage_path"]) if r["storage_path"] else None
        if p and p.exists():
            return str(p)
        if r["source_url"]:
            return r["source_url"]
    r = con.execute(
        "SELECT official_document_url FROM regulations WHERE id=?", (rid,)).fetchone()
    return r["official_document_url"] if r and r["official_document_url"] else None


def enrich(con, rid: str, dry: bool = False) -> dict:
    src = source_for(con, rid)
    if not src:
        return {"id": rid, "ok": False, "why": "no local PDF and no document URL"}

    got = DX.extract(src)

    # A footnote marker is repeated on every page it applies to, so counting
    # occurrences overstates the work wildly (98 occurrences of 12 circulars).
    # The meaningful unit is the DISTINCT circular being cited.
    refs = {re.sub(r"\s+", "", a["reference"]).upper() for a in got["amendments"]}
    linked_refs = {re.sub(r"\s+", "", a["reference"]).upper()
                   for a in got["amendments"] if a.get("url")}
    stats = {
        "id": rid, "ok": True, "method": got["method"],
        "sections": len(got["sections"]), "tables": len(got["tables"]),
        "occurrences": len(got["amendments"]),
        "amendments": len(refs), "linked": len(linked_refs),
        "pages": got["pages"], "chars": got["chars"],
    }
    if dry:
        return stats

    # --- tables (new capability; the fast pass produces none) ---
    con.execute("DELETE FROM regulation_tables WHERE regulation_id=?", (rid,))
    for i, t in enumerate(got["tables"]):
        con.execute(
            """INSERT INTO regulation_tables
               (regulation_id, table_index, columns_json, rows_json, row_count, col_count,
                extraction_method, created_at) VALUES (?,?,?,?,?,?,?,?)""",
            (rid, i, json.dumps(t["columns"]), json.dumps(t["rows"]),
             len(t["rows"]), len(t["columns"]), got["method"], _now()))

    # --- amendment links: fill the url in place, matching on the circular reference.
    #     Existing rows are UPDATED, never duplicated — the fast pass already
    #     found the amendment; docling is only adding the link to it.
    filled = 0
    existing = con.execute(
        "SELECT id, reference FROM regulation_amendments WHERE regulation_id=?", (rid,)).fetchall()
    by_ref = {re.sub(r"\s+", "", (r["reference"] or "")).upper(): r["id"] for r in existing}
    for a in got["amendments"]:
        if not a.get("url"):
            continue
        key = re.sub(r"\s+", "", a["reference"]).upper()
        if key in by_ref:
            con.execute(
                "UPDATE regulation_amendments SET url=?, extraction_method=? WHERE id=?",
                (a["url"], got["method"], by_ref[key]))
            filled += 1
        else:
            con.execute(
                """INSERT INTO regulation_amendments
                   (regulation_id, action, meaning, instrument, reference, amended_on,
                    raw, url, extraction_method)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (rid, "Amended", "Existing text was changed", a["instrument"],
                 a["reference"], iso_date(a["dated"]), a["raw"], a["url"], got["method"]))
            filled += 1
    stats["links_written"] = filled

    con.execute(
        """INSERT INTO extraction_runs
           (regulation_id, method, ocr_used, sections, tables, amendments,
            linked_amendments, chars, pages, ran_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(regulation_id, method) DO UPDATE SET
             sections=excluded.sections, tables=excluded.tables,
             amendments=excluded.amendments, linked_amendments=excluded.linked_amendments,
             chars=excluded.chars, pages=excluded.pages, ran_at=excluded.ran_at""",
        (rid, got["method"], got["ocrUsed"], len(got["sections"]), len(got["tables"]),
         len(refs), len(linked_refs), got["chars"], got["pages"], _now()))
    con.commit()

    # keep the richer markdown alongside the fast-pass json, for the Full Text tab
    out = HERE / "output" / "docling"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{rid}.md").write_text(got["markdown"])
    (out / f"{rid}.json").write_text(json.dumps(
        {k: got[k] for k in ("method", "pages", "chars", "sections", "tables", "amendments")},
        ensure_ascii=False))
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--redo", action="store_true", help="re-run ones already enriched")
    args = ap.parse_args()

    ok, why = DX.available()
    if not ok:
        sys.exit(f"docling unavailable: {why}")

    con = connect()
    if args.ids:
        ids = args.ids
    else:
        ids = [r[0] for r in con.execute(
            "SELECT id FROM regulations WHERE ingestion_status='MAPPED' ORDER BY id")]
    if not args.redo:
        done = {r[0] for r in con.execute(
            "SELECT regulation_id FROM extraction_runs WHERE method LIKE 'docling%'")}
        ids = [i for i in ids if i not in done]
    if args.limit:
        ids = ids[:args.limit]

    print(f"enriching {len(ids)} regulation(s) with docling{' (dry run)' if args.dry_run else ''}\n")
    good = bad = 0
    for n, rid in enumerate(ids, 1):
        try:
            s = enrich(con, rid, args.dry_run)
            if s["ok"]:
                good += 1
                print(f"  [{n}/{len(ids)}] {rid}: {s['sections']} sections · {s['tables']} tables · "
                      f"{s['linked']}/{s['amendments']} distinct circulars linked "
                      f"({s['occurrences']} footnote occurrences)")
            else:
                bad += 1
                print(f"  [{n}/{len(ids)}] {rid}: SKIP {s['why']}")
        except Exception as e:
            bad += 1
            print(f"  [{n}/{len(ids)}] {rid}: FAIL {type(e).__name__}: {str(e)[:120]}")
    print(f"\ndone: {good} enriched, {bad} failed/skipped")


if __name__ == "__main__":
    main()
