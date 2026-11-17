#!/usr/bin/env python3
"""
Look at what retrieval returns for a real question, and record whether it was
relevant — so the harness can score against YOUR judgement, not a derived one.

    python3 rag_inspect.py "How long must KYC records be retained?"
    python3 rag_inspect.py "How long must KYC records be retained?" --judge
    python3 rag_inspect.py "..." --judge --labels 1:y,2:p,3:n     # non-interactive

For each result you see: rank · reranker score · which arms found it (vector /
keyword / reference — two arms agreeing is a stronger signal than one) · the
share of your query's words that literally appear in the chunk · the regulation
and clause · the text itself (the whole parent clause when the hit was a slice).

--judge asks y / p / n per result (relevant / partially / not) and appends to
rag_judgements.jsonl. `rag_eval.py run --human` then scores precision@k and
graded nDCG against those labels. Judge the CLAUSE, not the ranking: "does this
text answer the question as a compliance officer would want it answered?"
"""
import argparse, json, pathlib, re, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from regulatory_ingestion import rag

JUDGE = pathlib.Path(__file__).parent / "rag_judgements.jsonl"
STOP = {"the","a","an","of","for","to","in","on","and","or","is","are","be","what","how","which",
        "does","do","must","shall","should","when","who","with","by","that","this","it","its"}

def terms(q): return {w for w in re.findall(r"[a-z0-9]+", q.lower()) if w not in STOP and len(w) > 2}

def show(q, res):
    qt = terms(q)
    for i, r in enumerate(res, 1):
        body = (r.get("parent") or r.get("content") or "").split("\n", 1)[-1]
        body = re.sub(r"\s+", " ", body).strip()
        hit = len(qt & terms(body)) / max(len(qt), 1)
        extra = []
        if r.get("also_in"): extra.append(f"same clause in {len(r['also_in'])} other regulation(s)")
        if r.get("restatements"): extra.append(f"{r['restatements']} restatement(s) folded in")
        print(f"\n  #{i}  rerank {r.get('rerank', 0):+.2f}   found by {r.get('matched_by','?'):<18} "
              f"query words present {hit:>3.0%}   {r['source_table']} · {r.get('regulation_id') or '-'}"
              + (f" · s.{r['section_number']}" if r.get("section_number") else ""))
        print(f"      {(r.get('title') or '')[:100]}")
        if extra: print(f"      ({'; '.join(extra)})")
        print("      " + (body[:520] + ("…" if len(body) > 520 else "")).replace("\n", " "))

def judge(q, res, labels=None):
    got = {}
    if labels:
        for part in labels.split(","):
            k, v = part.split(":"); got[int(k)] = v.strip().lower()[0]
    rows = []
    for i, r in enumerate(res, 1):
        lab = got.get(i)
        while lab not in ("y", "p", "n"):
            lab = input(f"  #{i} relevant? [y]es / [p]artial / [n]o / [s]kip rest: ").strip().lower()[:1]
            if lab == "s": break
        if lab == "s": break
        rows.append({"query": q, "rank": i, "source_id": r["source_id"], "source_table": r["source_table"],
                     "regulation_id": r.get("regulation_id"), "label": {"y": 2, "p": 1, "n": 0}[lab],
                     "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    with JUDGE.open("a") as f:
        for row in rows: f.write(json.dumps(row, ensure_ascii=False) + "\n")
    rel = sum(1 for r in rows if r["label"] == 2); part = sum(1 for r in rows if r["label"] == 1)
    print(f"\n  saved {len(rows)} judgement(s) -> {JUDGE.name}   relevant {rel} · partial {part} · not {len(rows)-rel-part}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query"); ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--judge", action="store_true"); ap.add_argument("--labels", default=None)
    a = ap.parse_args()
    res = rag.search(a.query, k=a.k)
    print(f"\n  \"{a.query}\"   {len(res)} results")
    show(a.query, res)
    if a.judge or a.labels: judge(a.query, res, a.labels)
