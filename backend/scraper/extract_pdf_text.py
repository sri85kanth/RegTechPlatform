"""
Stage 2 — PDF text extraction + clause parsing.

Downloads official regulation PDFs (from the scraped library), extracts their
text with pypdf, parses CHAPTER / numbered-section structure, and writes:

  output/extracted/<id>.json    — full structured text per document
  output/extracted/index.json   — what has been extracted (id → summary)
  → both mirrored to ../company-brain-app/public/data/extracted/

Incremental: already-extracted ids are skipped, so it can run in daily batches
(--limit N). Honesty rules: text comes only from the official PDF; documents
that fail to download/parse are recorded in the index with their error.

Usage:
  ./.venv/bin/python extract_pdf_text.py --limit 30
  ./.venv/bin/python extract_pdf_text.py --ids reg-mdkyc rbi-md-13141
"""
import argparse
import io
import json
import os
import time
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

import requests
from pypdf import PdfReader

HERE = Path(__file__).parent
LIB = HERE / "output" / "regulations.json"
OUT_DIR = HERE / "output" / "extracted"
DOCS_STORE = HERE / "output" / "documents"
APP_DIR = HERE.parent / "company-brain-app" / "public" / "data" / "extracted"
APP_DOCS = HERE.parent / "company-brain-app" / "public" / "data" / "documents"
INDEX = OUT_DIR / "index.json"

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}

# The company's tracked regulation — extracted first, keyed by its app entity id
# so the Regulation Detail page can load it directly.
TRACKED = [{
    "id": "reg-mdkyc",
    "title": "Master Direction – Know Your Customer (KYC) Direction, 2016",
    "regulatorShort": "RBI",
    "pdfUrl": "https://www.rbi.org.in/commonman/Upload/English/Notification/PDFs/MD18KYCF6E92C82E1E1419D87323E3869BC9F13.pdf",
}]

CHAPTER_RE = re.compile(r"^\s*CHAPTER\s+([IVXLC]+|\d+)\b[\s:.-]*(.*)$", re.I)
SECTION_RE = re.compile(r"^\s*(\d{1,3})\.\s+(.*)$")


def parse_structure(text: str) -> dict:
    """Split raw PDF text into chapters and numbered sections (clauses)."""
    chapters, sections = [], []
    cur = None            # current section dict
    cur_chapter = None
    last_no = 0

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        m_ch = CHAPTER_RE.match(line)
        if m_ch:
            cur_chapter = {"no": m_ch.group(1).upper(), "title": m_ch.group(2).strip()[:160], "sections": []}
            chapters.append(cur_chapter)
            continue
        m_s = SECTION_RE.match(line)
        # accept a section start only if numbering is plausibly sequential
        if m_s:
            no = int(m_s.group(1))
            if 0 < no <= last_no + 40 and (no > last_no or no <= 3):
                if cur:
                    cur["text"] = cur["text"].strip()
                cur = {"no": no, "title": m_s.group(2).strip()[:180], "text": m_s.group(2).strip() + "\n"}
                sections.append(cur)
                if cur_chapter is not None:
                    cur_chapter["sections"].append(no)
                last_no = max(last_no, no)
                continue
        if cur is not None:
            cur["text"] += line + "\n"

    if cur:
        cur["text"] = cur["text"].strip()
    # a section "title" is just its first line — trim it to the first sentence-ish chunk
    for s in sections:
        s["title"] = re.split(r"(?<=[a-z0-9])\.\s", s["title"], maxsplit=1)[0][:150]
        s["chars"] = len(s["text"])
    return {"chapters": chapters, "sections": sections}


# ---------------------------------------------------------------- other families
# One grammar parsed Master Directions and silently produced 0 sections for
# everything shaped differently (a FEMA notification, a DGFT handbook chapter,
# a TRAI corrigendum, a CERT-In direction letter — all real failures from the
# corpus). Each family below matches a marker style actually observed in those
# documents; nothing invents structure where no markers exist.

DECIMAL_RE = re.compile(r"^\s*(\d{1,2}\.\d{2}[A-Za-z]?)\s+(\S.*)$")        # 10.00 Objective (DGFT)
PAREN_NUM_RE = re.compile(r"^\s*\((\d{1,3})\)\s+(\S.*)$")                  # (1) ... (TRAI corrigenda)
ITEM_RE = re.compile(r"^\s*(?:\(([ivxlc]{1,6})\)|([a-z])\)|(\d{1,2})\.)\s+(\S.*)$", re.I)  # (i) / a) / 1. (gov letters)


def _parse_marked(text: str, marker_re, number_of) -> list[dict]:
    sections, cur = [], None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        m = marker_re.match(line)
        if m:
            if cur:
                cur["text"] = cur["text"].strip()
            no, rest = number_of(m)
            cur = {"no": no, "title": rest.strip()[:180], "text": rest.strip() + "\n"}
            sections.append(cur)
        elif cur is not None:
            cur["text"] += line + "\n"
    if cur:
        cur["text"] = cur["text"].strip()
    for s2 in sections:
        s2["title"] = re.split(r"(?<=[a-z0-9])\.\s", s2["title"], maxsplit=1)[0][:150]
        s2["chars"] = len(s2["text"])
    return sections


# ---------------------------------------------------------------- layout front
# Running headers/footers repeat on most pages and leak into section text
# ("SCOMET: Special Chemicals..." eleven times in one DGFT chapter). Strip any
# short line that recurs across pages BEFORE the grammars see the text — and
# when the text is still shapeless, route the document through docling's
# layout model (regulatory_ingestion/docling_extract.py), whose section
# headers come from a layout model rather than a regex.

LAYOUT_ROUTE = os.environ.get("EXTRACT_LAYOUT_ROUTE", "1") not in ("0", "false", "no")
LAYOUT_MAX_PAGES = int(os.environ.get("EXTRACT_LAYOUT_MAX_PAGES", "80"))


def _strip_furniture(pages: list[str]) -> tuple[str, int]:
    """Remove short lines that repeat across pages (headers, footers, banners)."""
    if len(pages) < 3:
        return "\n".join(pages), 0
    from collections import Counter
    def norm(l: str) -> str:
        # digit-folding catches "Page 3 of 8" — but only for SHORT lines;
        # a sentence that differs only by a number is content, not furniture
        base = re.sub(r"\s+", " ", l).strip().lower()
        return re.sub(r"\d+", "#", base) if len(base.split()) <= 6 else base
    seen = Counter()
    for pg in pages:
        for l in {norm(x) for x in pg.splitlines() if x.strip() and len(x.strip()) <= 120}:
            seen[l] += 1
    threshold = max(3, int(len(pages) * 0.6))
    furniture = {l for l, c in seen.items() if c >= threshold}
    if not furniture:
        return "\n".join(pages), 0
    removed, kept = 0, []
    for pg in pages:
        for x in pg.splitlines():
            if x.strip() and len(x.strip()) <= 120 and norm(x) in furniture:
                removed += 1
            else:
                kept.append(x)
        kept.append("")
    return "\n".join(kept), removed


def _needs_layout(structure: dict, npages: int, chars: int) -> str | None:
    """The reason to spend ~1-2 s/page on the layout model, or None."""
    substantial = [x for x in structure["sections"] if x.get("chars", 0) > 40]
    if structure.get("family") == "none" and chars >= 2000 and npages >= 3:
        return "no grammar matched real text"
    if npages >= 8 and len(substantial) < max(2, npages // 15):
        return f"{len(substantial)} sections over {npages} pages"
    return None


def _layout_extract(local_pdf: str) -> dict | None:
    from regulatory_ingestion import docling_extract as DX
    ok, _ = DX.available()
    if not ok:
        return None
    return DX.extract(local_pdf)


def parse_any_structure(text: str) -> dict:
    """
    Try the Master-Direction grammar first, then the other observed families;
    keep whichever finds the most real structure. A document with no markers
    stays sectionless — honesty over fabricated anchors.
    """
    best = parse_structure(text)
    best_family = "numbered" if best["sections"] else "none"
    candidates = [
        ("decimal", _parse_marked(text, DECIMAL_RE, lambda m: (m.group(1), m.group(2)))),
        ("paren", _parse_marked(text, PAREN_NUM_RE, lambda m: (f"({m.group(1)})", m.group(2)))),
        ("items", _parse_marked(
            text, ITEM_RE,
            lambda m: ((f"({m.group(1)})" if m.group(1) else (f"{m.group(2)})" if m.group(2) else m.group(3))),
                       m.group(4)))),
    ]
    for family, secs in candidates:
        # require real structure: at least 3 marked blocks with some body text
        substantial = [x for x in secs if x["chars"] > 40]
        if len(substantial) >= 3 and len(substantial) > len(best["sections"]):
            best = {"chapters": [], "sections": secs}
            best_family = family
    best["family"] = best_family
    return best


# requests' `timeout` bounds a single socket operation, not the transfer. A host
# that sends one byte every 80 seconds restarts that clock forever, so the read
# never returns and the run never moves on: two ingestion jobs sat in exactly
# that state for hours, 0.6% CPU, parked in poll(), with nothing in the log to
# say so. A download therefore carries three separate limits now.
CONNECT_TIMEOUT = 20        # reaching the host at all
STALL_TIMEOUT = 45          # silence between chunks once it is talking
TRANSFER_DEADLINE = 900     # the whole body, however slowly it is paced


class TransferTooSlow(TimeoutError):
    """
    The body never finished arriving inside TRANSFER_DEADLINE.

    Its own class, not a bare TimeoutError: urllib3 can let a raw socket
    timeout through unwrapped, and that is a transient read worth retrying —
    the opposite of this, which is a host that will trickle again next time.
    """


def fetch(url: str, attempts: int = 4) -> bytes:
    """
    Return the response body.

    Government sites throttle sustained crawling and then refuse connections
    outright. A refusal is almost never a bad document — it is us going too
    fast — so back off and retry rather than recording a permanent failure.

    The deadline is deliberately generous: a legitimate 12 MB gazette PDF has
    been measured arriving at 24 KB/s, which is nearly nine minutes of honest
    transfer. What it rules out is the unbounded case. A transfer that breaches
    the deadline is NOT retried — a host trickling bytes will trickle them
    again, and three more attempts would cost an hour to learn nothing.
    """
    last = None
    for i in range(attempts):
        try:
            with requests.get(url, headers=HEADERS, stream=True,
                              timeout=(CONNECT_TIMEOUT, STALL_TIMEOUT)) as r:
                if r.status_code in (429, 502, 503, 504):
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                r.raise_for_status()
                started, body = time.monotonic(), bytearray()
                for chunk in r.iter_content(64 * 1024):
                    body += chunk
                    if time.monotonic() - started > TRANSFER_DEADLINE:
                        raise TransferTooSlow(
                            f"transfer still unfinished after {TRANSFER_DEADLINE}s "
                            f"({len(body) // 1024} KB received) — abandoned")
                return bytes(body)
        except TransferTooSlow:
            raise
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError,
                requests.exceptions.ChunkedEncodingError) as e:
            last = e
            if i == attempts - 1:
                break
            time.sleep(2 ** i * 3)          # 3s, 6s, 12s
    raise last


def extract_one(item: dict) -> dict:
    # A previously stored copy is used as-is: the pipeline needs this exact file
    # for hashing anyway, and re-fetching is slow and a rate-limit risk.
    DOCS_STORE.mkdir(parents=True, exist_ok=True)
    cached = DOCS_STORE / f"{item['id']}.pdf"
    if cached.exists() and cached.stat().st_size > 3000:
        content = cached.read_bytes()
    else:
        content = fetch(item["pdfUrl"])
        if content[:5].startswith(b"%PDF"):
            cached.write_bytes(content)
    if not content[:5].startswith(b"%PDF"):
        raise RuntimeError("response is not a PDF")
    reader = PdfReader(io.BytesIO(content))
    pages = [p.extract_text() or "" for p in reader.pages]
    text, furniture = _strip_furniture(pages)
    method, ocr_used, note = "pypdf text layer", 0, None
    if furniture:
        method += f" · {furniture} furniture lines stripped"

    if len(text.strip()) < 400:
        # No usable text layer — a scan. Previously this raised and the document
        # was abandoned; now it falls through to OCR, which is the whole point of
        # the OCR_REQUIRED status the pipeline could set but never clear.
        from regulatory_ingestion import ocr as _ocr
        ok, why = _ocr.available()
        if not ok:
            raise RuntimeError(f"scanned PDF ({len(text.strip())} chars) and {why}")
        got = _ocr.ocr_pdf(content)
        text, method, ocr_used, note = got["text"], got["method"], 1, got["confidence_note"]

    structure = parse_any_structure(text)

    # the layout front: only when the cheap path visibly failed, only on
    # text-layer documents of sane size, and adopted only when strictly better
    reason = None if ocr_used else _needs_layout(structure, len(reader.pages), len(text))
    if LAYOUT_ROUTE and reason and len(reader.pages) <= LAYOUT_MAX_PAGES:
        try:
            lay = _layout_extract(str(cached))
        except Exception as e:  # noqa: BLE001 — the pypdf result still stands
            lay = None
            note = (note + " · " if note else "") + f"layout route failed: {type(e).__name__}"
        if lay:
            lsecs = [{"no": str(x.get("no") or ""), "title": x["title"],
                      "text": x["text"], "chars": len(x["text"])}
                     for x in lay["sections"] if len(x.get("text", "")) > 40]
            cur = [x for x in structure["sections"] if x.get("chars", 0) > 40]
            if len(lsecs) > len(cur):
                structure = {"chapters": [], "sections": lsecs, "family": "layout"}
                text = lay.get("markdown", text)
                method = f"docling layout ({reason})"
                note = (note + " · " if note else "") + \
                       f"layout model: {len(lsecs)} sections, {len(lay.get('tables', []))} tables"
    return {
        "id": item["id"],
        "title": item["title"],
        "regulatorShort": item.get("regulatorShort", ""),
        "pdfUrl": item["pdfUrl"],
        "extractedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pages": len(reader.pages),
        "chars": len(text),
        "chapters": structure["chapters"],
        "sections": structure["sections"],
        "structureFamily": structure.get("family", "numbered"),
        "method": method,
        "ocrUsed": ocr_used,
        # present only on OCR'd documents, so the UI can mark the text as machine-read
        **({"confidenceNote": note} if note else {}),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=25, help="max documents this run")
    ap.add_argument("--delay", type=float, default=1.0,
                    help="seconds between fetches — these are government servers, do not hammer them")
    ap.add_argument("--ids", nargs="*", help="extract only these ids")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = json.loads(INDEX.read_text()) if INDEX.exists() else {}

    lib = json.loads(LIB.read_text())["regulations"] if LIB.exists() else []
    candidates = TRACKED + [r for r in lib if r.get("pdfUrl")]
    if args.ids:
        candidates = [c for c in candidates if c["id"] in set(args.ids)]

    done = 0
    for item in candidates:
        if done >= args.limit:
            break
        if index.get(item["id"], {}).get("ok"):
            continue
        try:
            doc = extract_one(item)
            (OUT_DIR / f"{item['id']}.json").write_text(json.dumps(doc, ensure_ascii=False))
            index[item["id"]] = {"ok": True, "title": item["title"][:120], "sections": len(doc["sections"]),
                                 "chapters": len(doc["chapters"]), "pages": doc["pages"], "chars": doc["chars"],
                                 "method": doc["method"], "ocrUsed": doc.get("ocrUsed", 0),
                                 "extractedAt": doc["extractedAt"]}
            print(f"[ok] {item['id']}: {doc['pages']}p · {len(doc['sections'])} sections · {len(doc['chapters'])} chapters")
        except Exception as e:
            index[item["id"]] = {"ok": False, "title": item["title"][:120], "error": str(e)[:160],
                                 "extractedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            print(f"[FAIL] {item['id']}: {str(e)[:120]}")
        done += 1
        INDEX.write_text(json.dumps(index, indent=1, ensure_ascii=False))   # checkpoint each doc
        time.sleep(args.delay)

    INDEX.write_text(json.dumps(index, indent=1, ensure_ascii=False))
    # mark which ids have a locally cached official PDF (served same-origin by the app,
    # so the browser can render it inline — regulator sites block cross-origin embedding)
    for rid, v in index.items():
        v["pdf"] = (DOCS_STORE / f"{rid}.pdf").exists()
    INDEX.write_text(json.dumps(index, indent=1, ensure_ascii=False))
    # public/data was removed from the build (the app reads the API); only a
    # checkout that still has it gets the same-origin copies.
    if APP_DIR.parent.exists():
        APP_DIR.mkdir(parents=True, exist_ok=True)
        for f in OUT_DIR.glob("*.json"):
            shutil.copyfile(f, APP_DIR / f.name)
        APP_DOCS.mkdir(parents=True, exist_ok=True)
        for f in DOCS_STORE.glob("*.pdf"):
            dst = APP_DOCS / f.name
            if not dst.exists() or dst.stat().st_size != f.stat().st_size:
                shutil.copyfile(f, dst)
    ok = sum(1 for v in index.values() if v.get("ok"))
    print(f"[index] {ok} extracted / {len(index)} attempted → {APP_DIR}")


if __name__ == "__main__":
    main()
