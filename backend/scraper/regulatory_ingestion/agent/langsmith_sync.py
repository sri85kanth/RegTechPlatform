"""
Push the retrieval golden set and the human judgements to LangSmith as datasets,
so `langsmith.evaluation.evaluate()` can score the graph against them from a
developer machine. Development tooling only: LangSmith is US-hosted SaaS and
these files contain clause text, so this never runs on the production box —
it refuses without LANGSMITH_API_KEY and prints what it would send.

    python3 -m regulatory_ingestion.agent.langsmith_sync            # dry run
    LANGSMITH_API_KEY=... python3 -m regulatory_ingestion.agent.langsmith_sync --push
"""
from __future__ import annotations
import json, os, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parents[2]
GOLDEN = HERE / "rag_golden.json"
JUDGE = HERE / "rag_judgements.jsonl"


def examples() -> dict[str, list[dict]]:
    out = {"company-brain-retrieval-golden": [], "company-brain-human-judgements": []}
    if GOLDEN.exists():
        for c in json.loads(GOLDEN.read_text())["cases"]:
            out["company-brain-retrieval-golden"].append(
                {"inputs": {"query": c["query"]}, "outputs": {"gold_prefix": c["gold_prefix"], "kind": c["kind"]}})
    if JUDGE.exists():
        by: dict[str, dict] = {}
        for line in JUDGE.read_text().splitlines():
            if line.strip():
                j = json.loads(line); by.setdefault(j["query"], {})[j["source_id"]] = j["label"]
        for q, labels in by.items():
            out["company-brain-human-judgements"].append({"inputs": {"query": q}, "outputs": {"labels": labels}})
    return out


def main(push: bool) -> int:
    ex = examples()
    for name, rows in ex.items():
        print(f"  {name}: {len(rows)} examples")
    if not push:
        print("  dry run — pass --push with LANGSMITH_API_KEY set to upload"); return 0
    if not os.environ.get("LANGSMITH_API_KEY"):
        print("  refusing: LANGSMITH_API_KEY is not set"); return 1
    from langsmith import Client
    c = Client()
    for name, rows in ex.items():
        if not rows: continue
        ds = next((d for d in c.list_datasets(dataset_name=name)), None) or c.create_dataset(name)
        c.create_examples(inputs=[r["inputs"] for r in rows], outputs=[r["outputs"] for r in rows], dataset_id=ds.id)
        print(f"  pushed {len(rows)} -> {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main("--push" in sys.argv))
