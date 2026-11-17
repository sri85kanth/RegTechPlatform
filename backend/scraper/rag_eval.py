#!/usr/bin/env python3
"""
Retrieval evaluation for the regulatory RAG.

    python3 rag_eval.py build           # sample a golden set -> rag_golden.json
    python3 rag_eval.py run             # score the current retriever
    python3 rag_eval.py run --k 10 --tag before-rerank

WHAT THE GOLDEN SET IS, AND IS NOT
----------------------------------
The pairs are DERIVED from relationships that already exist in the database,
not invented and not human-judged:

  requirements  a derived plain-language statement of an obligation, already
                carrying that obligation's id. Query = the statement,
                gold = any chunk of that obligation.
  definitions   a defined term and the section that defines it.
                Query = the term, gold = any chunk of that section.
  thresholds    a numeric limit already linked to its obligation.
                Query = the metric and value in words, gold = that obligation.

That measures a real property — can retrieval find the clause a derived fact
came from — and it is reproducible and honest. It is NOT the same as asking a
compliance officer to judge relevance. Treat these numbers as a regression
signal for changes to the retriever, not as an absolute quality score. Add
human-labelled cases to rag_golden.json over time; the runner does not care
where a case came from.
"""
import argparse
import json
import math
import pathlib
import random
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))

GOLDEN = pathlib.Path(__file__).parent / "rag_golden.json"
SEED = 20260904          # fixed, so build is reproducible


# ---------------------------------------------------------------- build

def build(n_req=90, n_def=30, n_thr=30) -> dict:
    from regulatory_ingestion.db import connect
    con = connect()
    rnd = random.Random(SEED)
    cases: list[dict] = []

    rows = con.execute("""
        SELECT r.statement, r.obligation_id
          FROM requirements r
         WHERE r.statement IS NOT NULL AND length(r.statement) BETWEEN 40 AND 320
           AND r.obligation_id IS NOT NULL
    """).fetchall()
    for st, oid in rnd.sample(rows, min(n_req, len(rows))):
        cases.append({"kind": "requirement", "query": st.strip(),
                      "gold_prefix": f"{oid}#", "gold_table": "obligations"})

    rows = con.execute("""
        SELECT term, source_section_id FROM definitions
         WHERE term IS NOT NULL AND length(term) BETWEEN 6 AND 90
           AND source_section_id IS NOT NULL
    """).fetchall()
    for term, sid in rnd.sample(rows, min(n_def, len(rows))):
        cases.append({"kind": "definition",
                      "query": f'What does "{term.strip()}" mean?',
                      "gold_prefix": f"{sid}#", "gold_table": "sections"})

    rows = con.execute("""
        SELECT metric, value, unit, currency, condition, obligation_id
          FROM thresholds WHERE obligation_id IS NOT NULL AND metric IS NOT NULL
    """).fetchall()
    for metric, val, unit, cur, cond, oid in rnd.sample(rows, min(n_thr, len(rows))):
        bits = [f"What is the {metric} limit"]
        if val:  bits.append(f"of {val}")
        if cur or unit: bits.append(str(cur or unit))
        if cond: bits.append(f"for {str(cond)[:60]}")
        cases.append({"kind": "threshold", "query": " ".join(bits).strip() + "?",
                      "gold_prefix": f"{oid}#", "gold_table": "obligations"})

    # One query, one case. "What does \"Authority\" mean?" was sampled twice —
    # two regulations define the term — and under single-gold scoring an
    # identical query with two golds guarantees one miss. Keep the first; a
    # future multi-gold scorer can merge instead of drop. (The 2026-09-05 set
    # predates this and is left untouched so its 24 runs stay comparable.)
    seen, unique = set(), []
    for c in cases:
        if c["query"] not in seen:
            seen.add(c["query"]); unique.append(c)
    cases = unique
    rnd.shuffle(cases)
    doc = {"seed": SEED, "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "note": "Derived pairs, not human relevance judgements. See rag_eval.py docstring.",
           "cases": cases}
    GOLDEN.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    by = {}
    for c in cases:
        by[c["kind"]] = by.get(c["kind"], 0) + 1
    print(f"wrote {GOLDEN.name}: {len(cases)} cases  " +
          "  ".join(f"{k}={v}" for k, v in sorted(by.items())))
    return doc


# ---------------------------------------------------------------- metrics

def _ndcg_at(hits: list[bool], k: int) -> float:
    """Binary relevance, one relevant item per query, so IDCG is always 1.0."""
    for i, hit in enumerate(hits[:k]):
        if hit:
            return 1.0 / math.log2(i + 2)
    return 0.0


def _resolvers() -> dict:
    """
    Map a derived chunk back to the obligation it restates.

    Indexing requirements, thresholds and timing rules put paraphrases of
    obligations into the index. A hit on the requirement derived from obligation
    X *is* a hit on X — it is the same duty in plainer words — but the raw
    source_id does not say so, and scoring by source_id alone counted 16 of 17
    correct answers as misses.

    This is backward-compatible with every earlier run: before the derived
    corpus existed no result carried these source tables, so their scores are
    unaffected and the history stays comparable.
    """
    from regulatory_ingestion.db import connect
    con = connect()
    out = {}
    # a derived row -> the obligation it restates
    for table in ("requirements", "thresholds", "timing_rules"):
        try:
            out[table] = {str(r[0]): r[1] for r in con.execute(
                f"SELECT id, obligation_id FROM {table} WHERE obligation_id IS NOT NULL")}
        except Exception:
            out[table] = {}
    # a definition -> the section that defines the term. Same reasoning as
    # above and the same trap: a definition case's gold is the SECTION, so
    # returning the correct definition chunk was scoring as a miss.
    try:
        out["definitions"] = {str(r[0]): r[1] for r in con.execute(
            "SELECT id, source_section_id FROM definitions "
            "WHERE source_section_id IS NOT NULL")}
    except Exception:
        out["definitions"] = {}
    # The retriever collapses identical clauses that RBI reissues across sibling
    # Master Directions, keeping one and listing the rest in also_in. When the
    # kept copy is the sibling's, the gold obligation's TEXT is on screen under
    # a different id. Credit that by fingerprint — the same letters-only
    # normalisation the collapse itself uses.
    import re as _re
    norm = lambda t: _re.sub(r"[^a-z0-9]+", "", (t or "").lower())[:400]
    try:
        out["_gold_text"] = {r[0]: norm(r[1]) for r in con.execute(
            "SELECT id, description FROM obligations WHERE description IS NOT NULL")}
    except Exception:
        out["_gold_text"] = {}
    out["_norm"] = norm
    return out


def _matches(row: dict, gold_prefix: str, res: dict) -> bool:
    sid = str(row.get("source_id", ""))
    if sid.startswith(gold_prefix):
        return True
    m = res.get(row.get("source_table"))
    if m:
        oid = m.get(sid.split("#", 1)[0])
        if oid and f"{oid}#".startswith(gold_prefix):
            return True
    # same clause, sibling regulation (see _resolvers)
    # Prefix, not equality: an obligation chunk carries mandatory_action,
    # Responsible: and Frequency: after the description, so its fingerprint
    # runs past the gold's. 200 letters of identical clause is not a coincidence.
    gold_fp = res.get("_gold_text", {}).get(gold_prefix.rstrip("#"), "")[:200]
    if len(gold_fp) >= 80:
        body = (row.get("content") or "").split("\n", 1)[-1]
        if res["_norm"](body).startswith(gold_fp):
            return True
    return False


def _warn_if_dirty_index(threshold: float = 0.01) -> None:
    """
    pgvector's HNSW keeps deleted rows in the graph until VACUUM, and they still
    burn ef_search candidates. Run 22 was scored seconds after a 20,854-row
    delete and reported recall@10 0.533 on cases that measured 0.700 once the
    table was vacuumed. A number taken against a dirty index measures the
    garbage, not the retriever — so say so, loudly, before scoring.
    """
    try:
        from regulatory_ingestion import rag
        live, dead = rag.connect_pg().execute(
            "SELECT n_live_tup, n_dead_tup FROM pg_stat_user_tables WHERE relname='chunks'"
        ).fetchone()
    except Exception:
        return
    if live and dead / live > threshold:
        print(f"\n  !! chunks has {dead:,} dead tuples ({100*dead/live:.1f}% of {live:,}).\n"
              f"  !! HNSW recall is depressed until VACUUM ANALYZE chunks runs (~11 min).\n"
              f"  !! This score will understate the retriever. Run rag.prune() first.\n",
              flush=True)


def _merge_multigold(cases: list[dict]) -> list[dict]:
    """
    One query, a SET of correct answers.

    10 of the 162 authored cases share a query with another case — mostly
    templated thresholds like "What is the percentage limit of 50 %?", which
    four different obligations answer. Scoring each copy against its own single
    gold guarantees misses the retriever cannot avoid: the templated-threshold
    bucket has a hard ceiling of 0.667 under that rule. Merging makes a hit any
    gold in the top-k and ranks by the best-placed gold. Opt-in, so the 24
    single-gold runs in the history stay comparable.
    """
    merged: dict[str, dict] = {}
    for c in cases:
        m = merged.setdefault(c["query"], {**c, "golds": []})
        m["golds"].append((c["gold_prefix"], c["gold_table"]))
    return list(merged.values())


JUDGEMENTS = pathlib.Path(__file__).parent / "rag_judgements.jsonl"


def run_human(k=10, tag="", path: pathlib.Path | None = None) -> dict:
    """
    Score against what a PERSON said was relevant — rag_inspect.py --judge.

    Labels are graded: 2 relevant, 1 partial, 0 not. Per judged query we re-run
    retrieval and report precision@k (share of returned chunks a person marked
    relevant or partial), recall (share of chunks the person marked relevant
    that are still returned), and nDCG@k with graded gains. Unjudged chunks in
    a result count as 0 — so judge the whole top-k, not just the hits.
    """
    path = path or JUDGEMENTS
    if not path.exists():
        print(f"no judgements at {path.name} — run: python3 rag_inspect.py \"question\" --judge"); return {}
    from regulatory_ingestion import rag
    by_q: dict[str, dict[str, int]] = {}
    for line in path.read_text().splitlines():
        if not line.strip(): continue
        j = json.loads(line); by_q.setdefault(j["query"], {})[j["source_id"]] = j["label"]
    P = R = N = 0.0
    print(f"  {'query':<52}{'prec@'+str(k):>8}{'recall':>8}{'ndcg':>7}")
    print("  " + "-" * 75)
    for q, labels in by_q.items():
        res = rag.search(q, k=k)
        gains = [labels.get(str(r.get("source_id")), 0) for r in res]
        prec = sum(1 for g in gains if g > 0) / max(len(res), 1)
        relevant = {sid for sid, g in labels.items() if g == 2}
        rec = (sum(1 for r in res if str(r.get("source_id")) in relevant) / len(relevant)) if relevant else 1.0
        dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains[:k]))
        ideal = sorted(labels.values(), reverse=True)[:k]
        idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal)) or 1.0
        nd = dcg / idcg
        P += prec; R += rec; N += nd
        print(f"  {q[:50]:<52}{prec:>8.2f}{rec:>8.2f}{nd:>7.3f}")
    n = max(len(by_q), 1)
    out = {"tag": tag or "human", "scorer": "human", "k": k, "queries": len(by_q),
           f"precision@{k}": round(P / n, 4), "recall": round(R / n, 4), f"ndcg@{k}": round(N / n, 4)}
    print("  " + "-" * 75)
    print(f"  {'MEAN over ' + str(len(by_q)) + ' judged queries':<52}{out[f'precision@{k}']:>8.2f}{out['recall']:>8.2f}{out[f'ndcg@{k}']:>7.3f}")
    with (pathlib.Path(__file__).parent / "rag_eval_history.jsonl").open("a") as f:
        f.write(json.dumps({**out, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}) + "\n")
    return out


def run(k=10, tag="", limit=0, multigold=False, queries: set | None = None) -> dict:
    from regulatory_ingestion import rag
    if not GOLDEN.exists():
        print("no golden set — run: python3 rag_eval.py build"); return {}
    doc = json.loads(GOLDEN.read_text())
    cases = doc["cases"][:limit] if limit else doc["cases"]
    if multigold:
        cases = _merge_multigold(cases)
    if queries:
        cases = [c for c in cases if c["query"] in queries]

    _warn_if_dirty_index()
    res_map = _resolvers()
    agg: dict[str, list] = {}
    recall = ndcg = mrr = 0.0
    t0 = time.time()
    for i, c in enumerate(cases, 1):
        try:
            res = rag.search(c["query"], k=k)
        except Exception as e:
            print(f"  ! case {i} failed: {e}"); continue
        golds = [g for g, _ in c["golds"]] if "golds" in c else [c["gold_prefix"]]
        hits = [any(_matches(r, g, res_map) for g in golds) for r in res]
        r_ = 1.0 if any(hits) else 0.0
        n_ = _ndcg_at(hits, k)
        m_ = 1.0 / (hits.index(True) + 1) if any(hits) else 0.0
        recall += r_; ndcg += n_; mrr += m_
        agg.setdefault(c["kind"], []).append((r_, n_, m_))
        if i % 25 == 0:
            print(f"  {i}/{len(cases)}…", flush=True)

    n = max(len(cases), 1)
    took = time.time() - t0
    out = {"tag": tag, "k": k, "cases": len(cases), "scorer": "multigold" if multigold else "single",
           f"recall@{k}": round(recall / n, 4),
           f"ndcg@{k}": round(ndcg / n, 4),
           f"mrr@{k}": round(mrr / n, 4),
           "seconds": round(took, 1), "per_query_ms": round(1000 * took / n)}

    print(f"\n  {'RETRIEVAL':<14}{'recall@'+str(k):>10}{'ndcg@'+str(k):>10}{'mrr':>8}{'n':>6}")
    print(f"  {'-'*48}")
    for kind, vals in sorted(agg.items()):
        m = len(vals)
        print(f"  {kind:<14}{sum(v[0] for v in vals)/m:>10.3f}"
              f"{sum(v[1] for v in vals)/m:>10.3f}{sum(v[2] for v in vals)/m:>8.3f}{m:>6}")
    print(f"  {'-'*48}")
    print(f"  {'OVERALL':<14}{out[f'recall@{k}']:>10.3f}{out[f'ndcg@{k}']:>10.3f}"
          f"{out[f'mrr@{k}']:>8.3f}{len(cases):>6}")
    print(f"\n  {out['per_query_ms']} ms/query" + (f"   tag: {tag}" if tag else ""))

    hist = pathlib.Path(__file__).parent / "rag_eval_history.jsonl"
    with hist.open("a") as f:
        f.write(json.dumps({**out, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}) + "\n")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["build", "run"])
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--tag", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--multigold", action="store_true",
                    help="merge same-query cases; a hit is any of their golds in the top-k")
    ap.add_argument("--human", action="store_true",
                    help="score against rag_judgements.jsonl from rag_inspect.py --judge")
    ap.add_argument("--judgements", default=None, help="alternate judgements file (for --human)")
    ap.add_argument("--queries-file", default=None,
                    help="JSON list of query strings — score only these cases (held-out A/B)")
    a = ap.parse_args()
    if a.cmd == "build":
        build()
    else:
        if a.human:
            run_human(k=a.k, tag=a.tag, path=pathlib.Path(a.judgements) if a.judgements else None)
        else:
            qs = set(json.loads(pathlib.Path(a.queries_file).read_text())) if a.queries_file else None
            run(k=a.k, tag=a.tag, limit=a.limit, multigold=a.multigold, queries=qs)
