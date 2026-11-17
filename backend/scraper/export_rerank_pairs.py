"""
Training pairs for reranker fine-tuning, labelled by the eval harness itself.

For every golden query: retrieve top-30, label each chunk with the SAME
matching logic rag_eval scores with (so training truth == eval truth), keep
up to 3 positives and the 6 highest-ranked negatives — the "hard" ones that
outranked gold. Queries are split by hash: ~20% held out, never trained on;
the tuned model is judged on those and adopted only if it wins there.

    python export_rerank_pairs.py            # writes output/rerank_pairs.jsonl
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import rag_eval as REV
from regulatory_ingestion import rag

OUT = Path(__file__).parent / "output"
PAIRS = OUT / "rerank_pairs.jsonl"
HELDOUT = OUT / "rerank_heldout_queries.json"


def main() -> None:
    doc = json.loads(REV.GOLDEN.read_text())
    cases = REV._merge_multigold(doc["cases"])
    res_map = REV._resolvers()
    n_pos = n_neg = 0
    heldout: list[str] = []
    with PAIRS.open("w") as f:
        for i, c in enumerate(cases, 1):
            q = c["query"]
            split = "heldout" if int(hashlib.sha1(q.encode()).hexdigest(), 16) % 5 == 0 else "train"
            if split == "heldout":
                heldout.append(q)
            golds = [g for g, _ in c["golds"]] if "golds" in c else [c["gold_prefix"]]
            try:
                res = rag.search(q, k=30)
            except Exception as e:  # noqa: BLE001
                print(f"  ! {i}: {e}")
                continue
            pos = [r for r in res if any(REV._matches(r, g, res_map) for g in golds)][:3]
            neg = [r for r in res if not any(REV._matches(r, g, res_map) for g in golds)][:6]
            if not pos:
                continue          # a query the retriever cannot ground teaches nothing
            for r, label in [(r, 1) for r in pos] + [(r, 0) for r in neg]:
                text = (r.get("content") or "")[:1200]
                if not text.strip():
                    continue
                f.write(json.dumps({"query": q, "text": text, "label": label, "split": split}) + "\n")
                n_pos += label
                n_neg += 1 - label
            if i % 25 == 0:
                print(f"  {i}/{len(cases)}…", flush=True)
    HELDOUT.write_text(json.dumps(heldout, indent=1))
    print(json.dumps({"cases": len(cases), "pairs_pos": n_pos, "pairs_neg": n_neg,
                      "heldout_queries": len(heldout), "pairs_file": str(PAIRS)}))


if __name__ == "__main__":
    main()
