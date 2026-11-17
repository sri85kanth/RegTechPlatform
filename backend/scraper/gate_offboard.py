"""
Compute the precision gate off the server.

matcher.frozen_precision_gate computes one generic-name set per batch, which is
the right shape — but the computation itself is 1,143 entity names tested
against 107,507 obligation texts, and where it runs decides whether that takes
seconds or an hour.

Measured 11 Sep 2026 on the same data:

    laptop                         36 seconds
    deployment (96% CPU steal,
      about half a core)          ~50 minutes

Same arithmetic, same answer. So: dump the two inputs, compute the set where
there is a CPU, and hand the result back. The gate file records the corpus size
it was computed against and the names it was given, and the loader refuses a
file that does not match the corpus it is about to be used on — a gate computed
against a different corpus is not a shortcut, it is a wrong answer.

    # server
    python gate_offboard.py --export                 # output/gate_input.jsonl.gz
    # laptop, after scp
    python gate_offboard.py --compute                # output/gate.json
    # server, after scp back
    python ingest_harvest.py --apply --gate-file output/gate.json
"""
from __future__ import annotations

import argparse
import gzip
import json
import time
from pathlib import Path

HERE = Path(__file__).parent
GATE_INPUT = HERE / "output" / "gate_input.jsonl.gz"
GATE = HERE / "output" / "gate.json"


def export() -> None:
    from regulatory_ingestion.db import connect
    con = connect()
    names = [r[0] for r in con.execute("SELECT name FROM company_entities").fetchall()]
    n_obl, corpus = con.execute(
        "SELECT COUNT(*), COUNT(DISTINCT regulation_id) FROM obligations").fetchone()
    GATE_INPUT.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rows = 0
    with gzip.open(GATE_INPUT, "wt", encoding="utf-8") as out:
        out.write(json.dumps({"_meta": True, "names": names,
                              "obligations": n_obl, "corpus": corpus}) + "\n")
        cur = con.execute(
            "SELECT regulation_id, "
            "lower(coalesce(title,'') || ' ' || coalesce(description,'')) FROM obligations")
        while True:
            batch = cur.fetchmany(2000)
            if not batch:
                break
            for rid, text in batch:
                out.write(json.dumps([rid, text or ""], ensure_ascii=False) + "\n")
                rows += 1
    size = GATE_INPUT.stat().st_size
    print(f"{rows:,} obligations · {len(names)} names · corpus {corpus}")
    print(f"  {GATE_INPUT}  ({size / 1e6:.1f} MB gzipped, {time.time() - t0:.0f}s)")


def compute() -> None:
    from regulatory_ingestion.precision import generic_names

    meta = None
    seen: dict[str, set] = {}
    probes: list[tuple[str, str]] = []
    t0 = time.time()
    with gzip.open(GATE_INPUT, "rt", encoding="utf-8") as fh:
        for line in fh:
            rec = json.loads(line)
            if meta is None:
                meta = rec
                wanted = {}
                for n in meta["names"]:
                    n = (n or "").strip()
                    if n:
                        wanted[n] = n.lower()
                seen = {n: set() for n in wanted}
                probes = list(wanted.items())
                continue
            rid, text = rec
            if not text:
                continue
            for original, needle in probes:
                if needle in text:
                    seen[original].add(rid)
    df = {n: len(ids) for n, ids in seen.items()}
    generic = generic_names(df, meta["corpus"])
    GATE.write_text(json.dumps({
        "computed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "corpus": meta["corpus"], "obligations": meta["obligations"],
        "name_count": len(meta["names"]), "seconds": round(time.time() - t0, 1),
        "generic": sorted(generic),
    }, ensure_ascii=False, indent=1))
    print(f"{len(df)} names scanned in {time.time() - t0:.0f}s")
    print(f"  {len(generic)} judged generic against a corpus of {meta['corpus']}")
    print(f"  {GATE}")


def load(con, path: Path, names: list[str]) -> set[str]:
    """Read a precomputed gate, refusing one that does not fit this corpus."""
    g = json.loads(Path(path).read_text())
    n_obl, corpus = con.execute(
        "SELECT COUNT(*), COUNT(DISTINCT regulation_id) FROM obligations").fetchone()
    # The gate is a ratio against the corpus. Tolerate the drift a batch itself
    # causes; refuse anything that has moved enough to change an answer.
    if abs(corpus - g["corpus"]) > max(25, g["corpus"] // 50):
        raise SystemExit(
            f"gate file was computed against {g['corpus']} regulations, the corpus now "
            f"has {corpus} — recompute it rather than matching against a stale gate")
    if g["name_count"] != len(names):
        raise SystemExit(
            f"gate file covers {g['name_count']} entity names, this company now has "
            f"{len(names)} — recompute it")
    print(f"gate loaded: {len(g['generic'])} generic names, computed {g['computed_at']} "
          f"against {g['corpus']} regulations in {g['seconds']}s", flush=True)
    return set(g["generic"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--compute", action="store_true")
    a = ap.parse_args()
    if a.export:
        export()
    elif a.compute:
        compute()
    else:
        ap.error("pick --export or --compute")


if __name__ == "__main__":
    main()
