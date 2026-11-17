"""
Fetch and extract documents for regulations that ALREADY exist in the corpus,
here rather than on the server, and leave the artifacts where the server's
pipeline looks for them.

Why: a document costs ~130 seconds of download and pypdf on the VPS (96% CPU
steal) against ~2 seconds here. ingest_backlog.py and pipeline.process both
reuse `output/documents/<id>.pdf` and `output/extracted/<id>.json` when they
exist, so once these are rsynced across, the server run is database work only.
Same code, same extractor, same PDF bytes — the server still hashes the file
itself.

Input is `id|url|title` lines, which is what a psql -At -F'|' query produces:

    ssh VPS "sudo -u postgres psql -At -F'|' company_brain -c \\
      \\"SELECT id, official_document_url, title FROM regulations
          WHERE ...\\"" > targets.txt
    python prefetch_local.py targets.txt --workers 8

A target whose URL filename plainly contradicts its title is NOT fetched. Those
are bad resolutions from an earlier crawl, and attaching the text of one Act to
the title of another is worse than leaving the row without a document.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent
EXTRACTED = HERE / "output" / "extracted"

STOP = {"the", "act", "of", "and", "for", "in", "on", "to", "a", "an", "rules",
        "regulations", "amendment", "india", "indian", "no", "or"}


def significant(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", (title or "").lower())
            if len(w) > 3 and w not in STOP}


def url_words(url: str) -> set[str]:
    stem = Path(urlparse(url).path).stem.lower()
    return {w for w in re.split(r"[^a-z]+", stem) if len(w) > 3}


def mismatched(title: str, url: str) -> str | None:
    """A filename that names a DIFFERENT instrument than the title.

    Only fires when the filename carries real words AND none of them appear in
    the title — `a2019_30.pdf` or `196233.pdf` say nothing either way and pass.
    One-way similarity is not used to merge anything here; this only refuses.
    """
    uw = url_words(url)
    if not uw or uw <= {"bitstream", "pdf", "file", "final", "upload", "document"}:
        return None
    tw = significant(title)
    if tw and not (uw & tw):
        return f"filename {sorted(uw)} shares no word with the title"
    return None


def work(item: tuple[str, str, str]) -> dict:
    rid, url, title = item
    sys.path.insert(0, str(HERE))
    import extract_pdf_text as X
    t = time.time()
    try:
        doc = X.extract_one({"id": rid, "title": title, "regulatorShort": "", "pdfUrl": url})
    except Exception as e:                              # noqa: BLE001 — reported per document
        return {"id": rid, "error": f"{type(e).__name__}: {e}"[:200], "seconds": round(time.time() - t, 1)}
    EXTRACTED.mkdir(parents=True, exist_ok=True)
    (EXTRACTED / f"{rid}.json").write_text(json.dumps(doc, ensure_ascii=False))
    return {"id": rid, "pages": doc["pages"], "chars": doc["chars"],
            "sections": len(doc["sections"]), "method": doc["method"],
            "seconds": round(time.time() - t, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", help="file of id|url|title lines")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()

    items, refused = [], []
    for line in Path(a.targets).read_text().splitlines():
        parts = line.split("|")
        if len(parts) < 3 or not parts[1].startswith("http"):
            continue
        rid, url, title = parts[0], parts[1], "|".join(parts[2:])
        why = mismatched(title, url)
        if why:
            refused.append((rid, title, url, why))
        else:
            items.append((rid, url, title))

    for rid, title, url, why in refused:
        print(f"REFUSED {rid}\n    title : {title[:78]}\n    url   : {url[:78]}\n    reason: {why}")
    if refused:
        print()

    print(f"fetching {len(items)} documents with {a.workers} workers", flush=True)
    t0 = time.time()
    ok = 0
    with ProcessPoolExecutor(a.workers) as ex:
        for r in ex.map(work, items):
            if r.get("error"):
                print(f"  FAIL {r['id']}  {r['error'][:90]}", flush=True)
            else:
                ok += 1
                print(f"  ok   {r['id']}  {r['pages']:>4}p {r['sections']:>4} sections  "
                      f"{r['seconds']:>5.1f}s  {r['method'][:40]}", flush=True)
    el = time.time() - t0
    print(f"\n{ok}/{len(items)} extracted in {el:.0f}s ({el / max(len(items), 1):.1f}s per document)"
          f" · refused {len(refused)}")


if __name__ == "__main__":
    main()
