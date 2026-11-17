"""
Measured extraction precision — replacing "self-assigned 0.85 confidence" with
numbers someone can defend.

Two layers, honestly separated:

  metrics  Deterministic grounding checks over EVERY obligation:
             - does its section link resolve, within the same regulation?
             - does its description text actually occur in the linked section
               (whitespace/case-normalised containment)? An obligation whose
               words are not in its source is either paraphrased or fabricated,
               and the extractor claims to be verbatim — so this is a hard test.
             - does source_reference name a real section of the regulation?
           These are proxies a machine CAN check. They are not human precision.

  sample   A stratified review sheet (CSV) of obligations with their source
           text, for a person to grade; `--judge` records verdicts and computes
           the human precision figure. The machine never grades itself.

    python obligation_audit.py metrics
    python obligation_audit.py sample --n 40
    python obligation_audit.py judge            # interactive grading
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from regulatory_ingestion.db import connect

OUT = Path(__file__).parent / "output"
SHEET = OUT / "obligation_review.csv"
JUDGEMENTS = OUT / "obligation_judgements.jsonl"
_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")

_norm = lambda t: re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def metrics(limit: int = 0) -> dict:
    con = connect()
    obls = con.execute(
        """SELECT o.id, o.regulation_id, o.section_id, o.description, o.source_reference,
                  o.extraction_method
           FROM obligations o ORDER BY o.regulation_id, o.id""").fetchall()
    if limit:
        obls = obls[:limit]

    sec_text: dict[str, str] = {}
    sec_reg: dict[str, str] = {}
    reg_all_text: dict[str, str] = {}
    reg_secnos: dict[str, set] = defaultdict(set)
    for s in con.execute("SELECT id, regulation_id, section_number, section_text FROM sections"):
        sec_text[s["id"]] = _norm(s["section_text"])
        sec_reg[s["id"]] = s["regulation_id"]
        reg_all_text[s["regulation_id"]] = reg_all_text.get(s["regulation_id"], "") + " " + sec_text[s["id"]]
        reg_secnos[s["regulation_id"]].add(str(s["section_number"]))

    n = len(obls)
    link_ok = grounded = grounded_anywhere = ref_ok = 0
    by_method: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for o in obls:
        linked = o["section_id"] in sec_reg and sec_reg[o["section_id"]] == o["regulation_id"]
        link_ok += linked
        d = _norm(o["description"])[:400]
        probe = d[:180] if len(d) > 180 else d
        g = bool(probe) and linked and probe in sec_text.get(o["section_id"], "")
        ga = g or (bool(probe) and probe in reg_all_text.get(o["regulation_id"], ""))
        grounded += g
        grounded_anywhere += ga
        by_method[o["extraction_method"] or "?"][0] += ga
        by_method[o["extraction_method"] or "?"][1] += 1
        m = re.search(r"\d+[A-Za-z]?", o["source_reference"] or "")
        ref_ok += bool(m and m.group(0) in reg_secnos.get(o["regulation_id"], set()))

    pct = lambda x: round(100 * x / n, 1) if n else 0.0
    return {
        "obligations": n,
        "sectionLinkValid_pct": pct(link_ok),
        "textGroundedInLinkedSection_pct": pct(grounded),
        "textGroundedAnywhereInRegulation_pct": pct(grounded_anywhere),
        "sourceReferenceResolves_pct": pct(ref_ok),
        "byMethod": {k: {"grounded_pct": round(100 * v[0] / v[1], 1), "n": v[1]}
                     for k, v in sorted(by_method.items())},
        "note": ("Machine-checkable grounding proxies, not human precision. "
                 "An obligation counted 'grounded' has its first 180 normalised characters "
                 "verbatim inside the regulation's stored text."),
        "at": _now(),
    }


def sample(n: int = 40, seed: int = 7) -> str:
    con = connect()
    rows = con.execute(
        """SELECT o.id, o.regulation_id, r.regulator_short, o.obligation_type,
                  o.title, o.description, o.source_reference, s.section_text
           FROM obligations o
           JOIN regulations r ON r.id = o.regulation_id
           LEFT JOIN sections s ON s.id = o.section_id""").fetchall()
    random.seed(seed)
    by_bucket: dict[tuple, list] = defaultdict(list)
    for r in rows:
        by_bucket[(r["regulator_short"], r["obligation_type"])].append(r)
    picked: list = []
    buckets = sorted(by_bucket.values(), key=len, reverse=True)
    while len(picked) < min(n, len(rows)) and buckets:
        for b in buckets:
            if b and len(picked) < n:
                picked.append(b.pop(random.randrange(len(b))))
        buckets = [b for b in buckets if b]
    OUT.mkdir(exist_ok=True)
    with SHEET.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["obligation_id", "regulation_id", "regulator", "type",
                    "obligation_title", "obligation_description", "source_reference",
                    "source_section_excerpt", "verdict (correct/partial/wrong)", "notes"])
        for r in picked:
            w.writerow([r["id"], r["regulation_id"], r["regulator_short"], r["obligation_type"],
                        (r["title"] or "")[:200], (r["description"] or "")[:500],
                        r["source_reference"] or "",
                        (r["section_text"] or "SECTION TEXT MISSING")[:700], "", ""])
    return str(SHEET)


def judge() -> None:
    if not SHEET.exists():
        raise SystemExit("run `sample` first")
    done = set()
    if JUDGEMENTS.exists():
        done = {json.loads(l)["obligation_id"] for l in JUDGEMENTS.open() if l.strip()}
    rows = list(csv.DictReader(SHEET.open()))
    with JUDGEMENTS.open("a") as out:
        for r in rows:
            if r["obligation_id"] in done:
                continue
            print(f"\n— {r['obligation_id']}  ({r['regulator']} · {r['type']})")
            print("  OBLIGATION:", r["obligation_description"][:300])
            print("  SOURCE:    ", r["source_section_excerpt"][:300])
            v = input("  verdict [c]orrect / [p]artial / [w]rong / [s]kip / [q]uit: ").strip().lower()
            if v == "q":
                break
            if v == "s":
                continue
            verdict = {"c": "correct", "p": "partial", "w": "wrong"}.get(v)
            if not verdict:
                continue
            out.write(json.dumps({"obligation_id": r["obligation_id"], "verdict": verdict,
                                  "at": _now()}) + "\n")
    graded = [json.loads(l) for l in JUDGEMENTS.open() if l.strip()]
    if graded:
        c = sum(1 for g in graded if g["verdict"] == "correct")
        p = sum(1 for g in graded if g["verdict"] == "partial")
        print(f"\nhuman-graded precision so far: {c}/{len(graded)} correct "
              f"({round(100*c/len(graded),1)}%), {p} partial — over {len(graded)} graded")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["metrics", "sample", "judge"])
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    if a.cmd == "metrics":
        print(json.dumps(metrics(a.limit), indent=1))
    elif a.cmd == "sample":
        print("wrote", sample(a.n))
    else:
        judge()
