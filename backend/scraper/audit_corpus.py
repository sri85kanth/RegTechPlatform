"""
READ-ONLY audit of the regulation corpus. Executes no writes of any kind.

Duplicate detection uses several signals, never title similarity alone, and
requires agreement in BOTH directions. One-way overlap is what once scored
"Consumer Protection Act, 2019" at 1.0 against a TRAI telecom regulation: every
significant token of the short title appeared somewhere inside the long one.
Jaccard makes the comparison symmetric, so a short title can no longer be
"contained" by an unrelated long one.

Harmless differences are normalised away before comparison — a leading "The",
punctuation, and the year written with or without a comma. Everything else is
left alone.
"""
from __future__ import annotations

import argparse
import collections
import json
import re

from regulatory_ingestion.db import connect

STOP = {"the", "of", "and", "a", "an", "for", "in", "on", "to", "act", "rules",
        "regulations", "regulation", "rule", "amendment", "india", "indian", "state"}
STRONG = 0.60      # two-way token agreement
YEAR = re.compile(r"\b(1[89]\d{2}|20\d{2})\b")


def norm(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"^the\s+", "", s)
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tok(s: str) -> set[str]:
    return {t for t in norm(s).split() if len(t) > 2 and t not in STOP}


def years(s: str) -> set[str]:
    return set(YEAR.findall(s or ""))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.parse_args()
    con = connect()
    n = lambda q, *p: con.execute(q, p).fetchone()[0]

    # ---------------------------------------------------------- 1. totals
    totals = {
        "regulations": n("SELECT COUNT(*) FROM regulations"),
        "sections": n("SELECT COUNT(*) FROM sections"),
        "obligations": n("SELECT COUNT(*) FROM obligations"),
        "requirements": n("SELECT COUNT(*) FROM requirements"),
        "register_records": n("SELECT COUNT(*) FROM source_register"),
        "documents": n("SELECT COUNT(*) FROM documents"),
    }
    by_status = {r["ingestion_status"]: r["c"] for r in con.execute(
        "SELECT ingestion_status, COUNT(*) c FROM regulations GROUP BY 1 ORDER BY 2 DESC")}

    # ---------------------------------------------------------- 2. stubs
    # "Empty" means it carries none of the things ingestion produces.
    empty_stub_rows = [dict(r) for r in con.execute("""
        SELECT r.id, r.title, r.ingestion_status, r.source_url, r.official_document_url
          FROM regulations r
         WHERE NOT EXISTS (SELECT 1 FROM sections s    WHERE s.regulation_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM obligations o WHERE o.regulation_id = r.id)
           AND NOT EXISTS (SELECT 1 FROM documents d   WHERE d.regulation_id = r.id)
         ORDER BY r.id""")]

    # ---------------------------------------------------------- 3. orphans
    orphan_register = [dict(r) for r in con.execute("""
        SELECT sr.id, sr.instrument, sr.regulation_id FROM source_register sr
         WHERE sr.regulation_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM regulations r WHERE r.id = sr.regulation_id)""")]

    dangling_children = {
        "sections": n("""SELECT COUNT(*) FROM sections s WHERE NOT EXISTS
                         (SELECT 1 FROM regulations r WHERE r.id = s.regulation_id)"""),
        "obligations": n("""SELECT COUNT(*) FROM obligations o WHERE NOT EXISTS
                            (SELECT 1 FROM regulations r WHERE r.id = o.regulation_id)"""),
        "documents": n("""SELECT COUNT(*) FROM documents d WHERE NOT EXISTS
                          (SELECT 1 FROM regulations r WHERE r.id = d.regulation_id)"""),
        "requirements": n("""SELECT COUNT(*) FROM requirements rq WHERE NOT EXISTS
                             (SELECT 1 FROM regulations r WHERE r.id = rq.regulation_id)"""),
    }

    # ---------------------------------------------------------- 4. duplicates
    regs = [dict(r) for r in con.execute("""
        SELECT id, title, regulator, regulator_short, regulation_type, jurisdiction,
               source_url, official_document_url, reference_number, ingestion_status
          FROM regulations WHERE title IS NOT NULL""")]
    for r in regs:
        r["_tok"] = tok(r["title"])
        r["_yr"] = years(r["title"])
        r["_norm"] = norm(r["title"])

    # Block by shared year (or by a shared rare token when no year) so this is
    # not 1.7M full comparisons on a machine with almost no CPU to spare.
    buckets: dict[str, list[dict]] = collections.defaultdict(list)
    for r in regs:
        keys = r["_yr"] or {t for t in sorted(r["_tok"])[:2]}
        for k in keys or {"_none"}:
            buckets[k].append(r)

    seen: set[tuple[str, str]] = set()
    pairs = []
    for group in buckets.values():
        if len(group) > 400:            # a bucket this size is not evidence
            continue
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                key = tuple(sorted((a["id"], b["id"])))
                if key in seen:
                    continue
                seen.add(key)
                ta, tb = a["_tok"], b["_tok"]
                if not ta or not tb:
                    continue
                j = len(ta & tb) / len(ta | tb)          # two-way
                if j < STRONG and a["_norm"] != b["_norm"]:
                    continue
                # corroborating signals — never title alone
                sig = {
                    "identical_normalised_title": a["_norm"] == b["_norm"],
                    "same_year": bool(a["_yr"] and a["_yr"] == b["_yr"]),
                    "year_conflict": bool(a["_yr"] and b["_yr"] and a["_yr"] != b["_yr"]),
                    "same_regulator": (a["regulator_short"] or a["regulator"] or "") ==
                                      (b["regulator_short"] or b["regulator"] or ""),
                    "same_type": (a["regulation_type"] or "") == (b["regulation_type"] or ""),
                    "same_source_url": bool(a["source_url"]) and a["source_url"] == b["source_url"],
                    "same_document_url": bool(a["official_document_url"]) and
                                         a["official_document_url"] == b["official_document_url"],
                }
                if sig["year_conflict"]:
                    continue                              # different vintages are different laws
                pairs.append({"a": a["id"], "b": b["id"], "jaccard": round(j, 3),
                              "a_title": a["title"][:70], "b_title": b["title"][:70],
                              "signals": sig,
                              "a_status": a["ingestion_status"], "b_status": b["ingestion_status"]})

    # payload each side carries, so nothing is called a duplicate blind
    def payload(rid: str) -> dict:
        return {
            "sections": n("SELECT COUNT(*) FROM sections WHERE regulation_id=?", rid),
            "obligations": n("SELECT COUNT(*) FROM obligations WHERE regulation_id=?", rid),
            "documents": n("SELECT COUNT(*) FROM documents WHERE regulation_id=?", rid),
        }
    for p in pairs:
        p["a_payload"] = payload(p["a"])
        p["b_payload"] = payload(p["b"])

    out = {
        "totals": totals, "by_status": by_status,
        "empty_stubs": len(empty_stub_rows),
        "empty_stub_sample": empty_stub_rows[:10],
        "orphan_register_entries": len(orphan_register),
        "orphan_register_sample": orphan_register[:10],
        "dangling_children": dangling_children,
        "duplicate_pairs": len(pairs),
        "duplicates": sorted(pairs, key=lambda p: -p["jaccard"]),
    }
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
