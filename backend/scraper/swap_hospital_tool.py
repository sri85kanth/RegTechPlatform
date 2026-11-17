"""Move the hospital documents' vectors from staging into the live `chunks` table.

Only rows whose regulation_id starts with 'ha-' — the TeamLease vectors stay
staged until their own embedding finishes.

The question this script answers before it commits to anything is whether the
HNSW index has to come out. embed_offboard's notes measured ~3.9 s per inserted
row with the index live, which would make 16k rows a 17-hour job — but that was
measured with the box at load 50+. So it inserts one small batch first, times
it, and reports. Dropping an index the running app searches is not something to
do on the strength of a number measured under different conditions.

    python swap_hospital.py --probe 500      # measure, insert only that batch
    python swap_hospital.py --apply          # move the rest
"""
from __future__ import annotations

import argparse
import sys
import time

sys.path.insert(0, "/srv/company-brain/scraper")
from regulatory_ingestion import rag  # noqa: E402

PREFIX = "ha-%"


def staged_count(p) -> int:
    return p.execute("SELECT COUNT(*) FROM chunks_staging WHERE regulation_id LIKE %s",
                     (PREFIX,)).fetchone()[0]


def move(p, batch: int) -> tuple[int, float]:
    """Move one batch; returns (rows inserted, seconds)."""
    t0 = time.time()
    with p.cursor() as cur:
        cur.execute(
            """WITH picked AS (
                 SELECT ctid FROM chunks_staging
                  WHERE regulation_id LIKE %s ORDER BY ctid LIMIT %s),
               moved AS (
                 DELETE FROM chunks_staging s USING picked
                  WHERE s.ctid = picked.ctid
                  RETURNING s.corpus, s.source_table, s.source_id, s.regulation_id,
                            s.entity_id, s.domain, s.title, s.section_number, s.content,
                            s.token_estimate, s.url, s.app_path, s.content_hash, s.embedding)
               INSERT INTO chunks (corpus, source_table, source_id, regulation_id, entity_id,
                                   domain, title, section_number, content, token_estimate,
                                   url, app_path, content_hash, embedding)
               SELECT * FROM moved
               ON CONFLICT (source_table, source_id, content_hash) DO NOTHING""",
            (PREFIX, batch))
        n = cur.rowcount
    p.commit()
    return n, time.time() - t0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", type=int, default=0, help="insert this many rows and time it")
    ap.add_argument("--apply", action="store_true", help="move everything still staged")
    ap.add_argument("--batch", type=int, default=2000)
    a = ap.parse_args()

    p = rag.connect_pg()
    total = staged_count(p)
    live = p.execute("SELECT COUNT(*) FROM chunks WHERE regulation_id LIKE %s",
                     (PREFIX,)).fetchone()[0]
    print(f"hospital vectors: {total:,} staged, {live:,} already live")

    if a.probe:
        n, secs = move(p, a.probe)
        rate = n / secs if secs else 0
        print(f"probe: inserted {n:,} rows in {secs:.1f}s "
              f"({secs / max(n, 1) * 1000:.1f} ms/row, {rate:.0f} rows/s)")
        print(f"  at that rate the remaining {staged_count(p):,} would take "
              f"{staged_count(p) / max(rate, 0.01) / 60:.1f} min with the index left in place")
        return

    if not a.apply:
        print("(nothing written — pass --probe N or --apply)")
        return

    moved, t0 = 0, time.time()
    while True:
        n, secs = move(p, a.batch)
        if not n:
            break
        moved += n
        left = staged_count(p)
        print(f"  moved {moved:,} · {left:,} left · {n / max(secs, 0.01):.0f} rows/s", flush=True)
    live = p.execute("SELECT COUNT(*) FROM chunks WHERE regulation_id LIKE %s",
                     (PREFIX,)).fetchone()[0]
    print(f"done: {moved:,} moved in {time.time() - t0:.0f}s · {live:,} hospital chunks now live")


if __name__ == "__main__":
    main()
