"""
Embed the RAG corpus off the server.

WHY
---
Measured on the deployment, 11 Sep 2026, for one batch of 64 chunks:

    model load                        760.7s   (once per process)
    encode 64 chunks                  231.4s   ~3.6s each
    insert 64 rows (HNSW + 2 GIN)     249.6s   ~3.9s each

So a batch costs about eight minutes, and the 15,881 sections just ingested are
tens of thousands of chunks — weeks at that rate. The cost splits almost evenly
between the embedding model and the index maintenance on insert, which means
moving only the model off the box fixes half the problem.

The same model on the laptop, same day:

    model load                          6.6s   (against 760.7s)
    encode, batches of 256           162.4 chunks/second
    encode, batches of 64             46.1 chunks/second

against 0.28 chunks/second on the server: 580x. Thirty thousand chunks is three
minutes here and thirty hours there.

Both halves are addressed: the encoding happens on the laptop, and the rows
arrive through COPY into a table whose HNSW index has been dropped for the load
and rebuilt once at the end rather than maintained across 30,000 inserts.

Nothing about the content changes. The same chunk generators produce the same
text, the same model produces the same vectors — the model name and dimension
are written into index_runs exactly as rag.index() writes them, so a later run
can tell what produced what.

    # on the server
    python embed_offboard.py --export            # writes output/embed_todo.jsonl
    # on the laptop, after scp-ing that file
    python embed_offboard.py --embed             # writes output/embed_done.jsonl
    # back on the server
    python embed_offboard.py --import --rebuild-index
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

HERE = Path(__file__).parent
TODO = HERE / "output" / "embed_todo.jsonl"
DONE = HERE / "output" / "embed_done.jsonl"

# Fields carried across; they mirror the columns rag.index() writes.
CARRY = ("corpus", "source_table", "source_id", "regulation_id", "entity_id",
         "domain", "title", "section_number", "content", "url", "app_path")


def export(corpora: tuple[str, ...], limit: int, match: str = "") -> None:
    """Everything whose exact text is not already embedded, as JSONL.

    `match` narrows to chunks whose regulation_id matches a LIKE pattern,
    so one newly ingested set can be embedded without exporting the whole
    outstanding backlog.
    """
    import re as _re
    _rx = None
    if match:
        _rx = _re.compile("^" + _re.escape(match).replace("%", ".*").replace("_", ".") + "$")
    from regulatory_ingestion import rag
    scon, pcon = rag._sqlite(), rag.connect_pg()
    gens = {"regulatory": rag.regulatory_chunks,
            "company": rag.company_chunks,
            "derived": rag.derived_chunks}

    TODO.parent.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    t0 = time.time()
    with TODO.open("w") as out:
        for corpus in corpora:
            batch: list[dict] = []

            def keep(c):
                if _rx is None:
                    return True
                return bool(c.get("regulation_id")) and bool(_rx.match(c["regulation_id"]))

            def flush(batch):
                nonlocal written, skipped
                if not batch:
                    return
                keys = [(c["source_table"], c["source_id"], rag._h(c["content"])) for c in batch]
                have = {(r[0], r[1], r[2]) for r in pcon.execute(
                    """SELECT source_table, source_id, content_hash FROM chunks
                       WHERE (source_table, source_id) IN (
                         SELECT * FROM unnest(%s::text[], %s::text[]))""",
                    ([k[0] for k in keys], [k[1] for k in keys])).fetchall()}
                for c, k in zip(batch, keys):
                    if k in have:
                        skipped += 1
                        continue
                    row = {f: c.get(f) for f in CARRY}
                    row["content_hash"] = k[2]
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                    written += 1

            # Pass the pattern INTO the generator so it filters in SQL. Calling
            # it unscoped and rejecting afterwards still reads and chunks the
            # whole corpus: measured 2h55m at 99.8% CPU for a third of one table.
            # Only regulatory_chunks takes the argument; keep() remains as the
            # backstop for the generators that do not.
            try:
                stream = gens[corpus](scon, match) if match else gens[corpus](scon)
            except TypeError:
                stream = gens[corpus](scon)
            for c in stream:
                if not keep(c):
                    continue
                batch.append(c)
                if len(batch) >= 512:
                    flush(batch); batch = []
                    print(f"    {corpus}: {written} to embed, {skipped} already indexed", flush=True)
                if limit and written >= limit:
                    break
            flush(batch)
    print(f"{written} chunks need embedding ({skipped} already indexed) · {time.time() - t0:.0f}s")
    print(f"  {TODO}")


def embed(batch_size: int) -> None:
    """Encode locally. The heavy half, on hardware that can do it."""
    from sentence_transformers import SentenceTransformer
    from regulatory_ingestion.rag import MODEL_NAME, DIMS

    rows = [json.loads(l) for l in TODO.read_text().splitlines() if l.strip()]
    print(f"{len(rows)} chunks · model {MODEL_NAME}", flush=True)
    t0 = time.time()
    m = SentenceTransformer(MODEL_NAME)
    print(f"  model loaded in {time.time() - t0:.0f}s", flush=True)

    t0 = time.time()
    with DONE.open("w") as out:
        for i in range(0, len(rows), batch_size):
            chunk = rows[i:i + batch_size]
            vecs = m.encode([c["content"] for c in chunk],
                            normalize_embeddings=True, show_progress_bar=False)
            for c, v in zip(chunk, vecs):
                if len(v) != DIMS:
                    raise SystemExit(f"model returned {len(v)} dims, the column expects {DIMS}")
                c["embedding"] = [float(x) for x in v]
                out.write(json.dumps(c, ensure_ascii=False) + "\n")
            done = min(i + batch_size, len(rows))
            print(f"  {done}/{len(rows)}  {done / (time.time() - t0):.0f} chunks/s", flush=True)
    print(f"{len(rows)} embedded in {time.time() - t0:.0f}s\n  {DONE}")


def load(rebuild_index: bool) -> None:
    """COPY the rows in. The HNSW index is the expensive half of an insert, so
    it is dropped for the load and rebuilt once — see the measurements above."""
    from regulatory_ingestion import rag
    pcon = rag.connect_pg()
    n_lines = sum(1 for _ in DONE.open())
    print(f"{n_lines} rows to load", flush=True)

    idx = pcon.execute(
        "SELECT indexdef FROM pg_indexes WHERE tablename='chunks' AND indexname='idx_chunks_hnsw'"
    ).fetchone()
    if rebuild_index and idx:
        print("  dropping idx_chunks_hnsw for the load", flush=True)
        pcon.execute("DROP INDEX idx_chunks_hnsw"); pcon.commit()

    cols = list(CARRY) + ["content_hash", "embedding", "token_estimate"]
    t0 = time.time()
    loaded = 0
    with pcon.cursor() as cur:
        cur.execute("""CREATE TEMP TABLE chunk_load (LIKE chunks INCLUDING DEFAULTS)
                       ON COMMIT DROP""")
        with cur.copy(f"COPY chunk_load ({','.join(cols)}) FROM STDIN") as cp:
            for line in DONE.open():
                if not line.strip():
                    continue
                r = json.loads(line)
                r["token_estimate"] = len(r["content"]) // 4
                r["embedding"] = "[" + ",".join(f"{x:.7g}" for x in r["embedding"]) + "]"
                cp.write_row([r.get(c) for c in cols])
                loaded += 1
        cur.execute(f"""INSERT INTO chunks ({','.join(cols)})
                        SELECT {','.join(cols)} FROM chunk_load
                        ON CONFLICT (source_table, source_id, content_hash) DO NOTHING""")
        inserted = cur.rowcount
    pcon.commit()
    print(f"  copied {loaded}, inserted {inserted} · {time.time() - t0:.0f}s", flush=True)

    if rebuild_index and idx:
        print("  rebuilding idx_chunks_hnsw (this is the slow part)", flush=True)
        t0 = time.time()
        pcon.execute("SET maintenance_work_mem = '2GB'")
        pcon.execute(idx[0]); pcon.commit()
        print(f"  index rebuilt in {time.time() - t0:.0f}s", flush=True)

    total = pcon.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    print(f"chunks now: {total:,}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--embed", action="store_true")
    ap.add_argument("--import", dest="do_import", action="store_true")
    ap.add_argument("--rebuild-index", action="store_true",
                    help="drop the HNSW index for the load and rebuild it after")
    ap.add_argument("--corpora", default="regulatory,company,derived")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--match", default="",
                    help="only chunks whose regulation_id matches this LIKE "
                         "pattern, e.g. 'nabh-%%'. Composes with the existing "
                         "skip-if-already-embedded behaviour.")
    ap.add_argument("--batch", type=int, default=256)
    a = ap.parse_args()

    if a.export:
        export(tuple(c.strip() for c in a.corpora.split(",") if c.strip()), a.limit, a.match)
    elif a.embed:
        embed(a.batch)
    elif a.do_import:
        load(a.rebuild_index)
    else:
        ap.error("pick one of --export / --embed / --import")


if __name__ == "__main__":
    main()
