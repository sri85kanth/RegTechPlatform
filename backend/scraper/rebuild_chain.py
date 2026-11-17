#!/usr/bin/env python3
"""
Relink obligations to the section that contains them, then derive requirements —
for every regulation that holds obligations, in batches.

Batched on purpose: a whole-corpus pass holds all 1,093,818 sections' text in
memory at once, and an unscoped extract_clauses --apply DELETEs every
requirement in the system, cascading through company_requirement_instances.
Each batch is a scoped, re-runnable rebuild of its own regulations.
"""
import subprocess, sys, time
sys.path.insert(0, "/srv/company-brain/scraper")
from regulatory_ingestion.db import connect

BATCH = 1000
PY = "/srv/company-brain/.venv/bin/python"
HERE = "/srv/company-brain/scraper"

con = connect()
regs = [r["id"] for r in con.execute(
    "SELECT DISTINCT regulation_id AS id FROM obligations ORDER BY 1").fetchall()]
before_req = con.execute("SELECT COUNT(*) FROM requirements").fetchone()[0]
before_regs = con.execute("SELECT COUNT(DISTINCT regulation_id) FROM requirements").fetchone()[0]
print(f"[chain] {len(regs):,} regulations hold obligations; "
      f"{before_req:,} requirements across {before_regs:,} regulations today", flush=True)

t_start = time.time()
for i in range(0, len(regs), BATCH):
    batch = regs[i:i + BATCH]
    ids = ",".join(batch)
    t0 = time.time()
    r1 = subprocess.run([PY, "relink_obligations.py", "--ids", ids, "--apply"],
                        cwd=HERE, capture_output=True, text=True)
    r2 = subprocess.run([PY, "extract_clauses.py", "--ids", ids, "--apply"],
                        cwd=HERE, capture_output=True, text=True)
    if r1.returncode or r2.returncode:
        print(f"[chain] batch {i // BATCH + 1} FAILED\n{r1.stderr[-800:]}\n{r2.stderr[-800:]}", flush=True)
        raise SystemExit(1)
    moved = (r1.stdout.strip().splitlines() or [""])[-1]
    wrote = [l for l in r2.stdout.splitlines() if l.startswith("written:")]
    print(f"[chain] batch {i // BATCH + 1:>2}/{(len(regs) + BATCH - 1) // BATCH} "
          f"({len(batch)} regs, {time.time() - t0:5.1f}s) {moved} | {wrote[0] if wrote else '—'}",
          flush=True)

con2 = connect()
after_req = con2.execute("SELECT COUNT(*) FROM requirements").fetchone()[0]
after_regs = con2.execute("SELECT COUNT(DISTINCT regulation_id) FROM requirements").fetchone()[0]
print(f"[chain] done in {(time.time() - t_start) / 60:.1f} min: "
      f"{before_req:,} -> {after_req:,} requirements, "
      f"{before_regs:,} -> {after_regs:,} regulations", flush=True)
