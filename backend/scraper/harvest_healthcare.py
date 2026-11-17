"""
Harvest healthcare regulatory documents from the official Indian portals.

WHY THIS EXISTS SEPARATELY FROM scrape_regulations.py
-----------------------------------------------------
The registered sources cover finance, telecom, tax and environment. Healthcare
arrived only as a hand-made register (the hosp-* rows), so the corpus held two
CDSCO documents and two from the NMC. This walks the health ministry's own
portals and their regulators the way the other scrapers walk theirs.

WHY IT RUNS OFF THE SERVER
--------------------------
Measured on 11 Sep 2026, same 28 MB PDF, 40 pages of text extraction:

    VPS  1 worker  33.2s   4 workers 70.9s  → 0.056 documents/second
    Mac  1 worker   0.8s   4 workers  0.9s  → 4.64 documents/second

The VPS runs at 96% CPU steal, so it gains 1.9x from four workers where the
laptop gains 3.5x. Downloading and extracting there costs ~130s per document
and cannot be parallelised out. Doing it here and shipping the artifacts is
the same work by the same code — `extract_pdf_text.extract_one` — on hardware
that can actually run it. The server still hashes the bytes it receives.

HONESTY RULES (the same ones the rest of the pipeline keeps)
------------------------------------------------------------
- A link is a LEAD. Nothing is recorded as a document until the bytes have been
  fetched and start with %PDF. An HTML error page is a failure, not a document.
- Titles come from the anchor text or the PDF metadata. None are composed.
- Sections and obligations come from the shared extractor. This file creates
  none of its own.
- A URL that fails is reported with its reason and kept in the output, so a
  portal that breaks is visible rather than quietly missing.
- Duplicates are dropped on the sha256 of the actual bytes, never on title
  similarity.

    python harvest_healthcare.py --probe            # what each portal yields
    python harvest_healthcare.py --limit 120        # harvest, write artifacts
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
import urllib3
from bs4 import BeautifulSoup

HERE = Path(__file__).parent
DOCS_DIR = HERE / "output" / "documents"
EXTRACTED = HERE / "output" / "extracted"
REGISTER = HERE / "output" / "healthcare_harvest.json"

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 Chrome/126 Safari/537.36"}
PAGE_TIMEOUT = 25
PDF_TIMEOUT = 90
MAX_PDF_BYTES = 80 * 1024 * 1024


# ---------------------------------------------------------------- portals
# Every entry was probed from this machine on 11 Sep 2026. `depth: 1` means the
# seed is an index whose sub-pages are worth opening; `depth: 0` means take the
# PDFs on the page itself and stop.
PORTALS = [
    {"regulator": "Central Drugs Standard Control Organisation",
     "short": "CDSCO", "depth": 1,
     "seeds": ["https://cdsco.gov.in/opencms/opencms/en/Home/",
               "https://cdsco.gov.in/opencms/opencms/en/Acts-Rules/",
               "https://cdsco.gov.in/opencms/opencms/en/Notifications/Gazette-Notifications/",
               "https://cdsco.gov.in/opencms/opencms/en/Medical-Device-Diagnostics/Medical-Device-Diagnostics/",
               "https://cdsco.gov.in/opencms/opencms/en/Notifications/"]},
    {"regulator": "National Medical Commission",
     "short": "NMC", "depth": 1,
     "seeds": ["https://www.nmc.org.in/rules-regulations/",
               "https://www.nmc.org.in/rules-regulations/gazette-notifications/",
               "https://www.nmc.org.in/rules-regulations/acts-rules/"]},
    {"regulator": "Directorate General of Health Services",
     "short": "DGHS", "depth": 1,
     "seeds": ["https://dghs.mohfw.gov.in/"]},
    {"regulator": "Ministry of Health and Family Welfare",
     "short": "MoHFW", "depth": 1,
     "seeds": ["https://mohfw.gov.in/", "https://mohfw.gov.in/?q=acts-rules",
               "https://mohfw.gov.in/en/acts-rules-and-standards-health-sector"]},
    {"regulator": "Central Pollution Control Board",
     "short": "CPCB", "depth": 1,
     "seeds": ["https://cpcb.nic.in/rules/",
               "https://cpcb.nic.in/bio-medical-waste-rules/",
               "https://cpcb.nic.in/biomedical-waste-guidelines/",
               "https://cpcb.nic.in/hazardous-waste-rules/"]},
    {"regulator": "National Accreditation Board for Hospitals & Healthcare Providers",
     "short": "NABH", "depth": 1,
     "seeds": ["https://www.nabh.co/"]},
    {"regulator": "Indian Council of Medical Research",
     "short": "ICMR", "depth": 1,
     "seeds": ["https://www.icmr.gov.in/"]},
    {"regulator": "National Centre for Disease Control",
     "short": "NCDC", "depth": 1,
     "seeds": ["https://ncdc.mohfw.gov.in/"]},
    {"regulator": "Atomic Energy Regulatory Board",
     "short": "AERB", "depth": 1,
     "seeds": ["https://www.aerb.gov.in/english/"]},
    {"regulator": "National Health Mission",
     "short": "NHM", "depth": 1,
     "seeds": ["https://nhm.gov.in/"]},
    {"regulator": "National Health Systems Resource Centre",
     "short": "NHSRC", "depth": 1,
     "seeds": ["https://nhsrcindia.org/"]},
    {"regulator": "Central TB Division",
     "short": "CTD", "depth": 1,
     "seeds": ["https://tbcindia.mohfw.gov.in/"]},
    {"regulator": "Directorate General of Mines Safety",
     "short": "DGMS", "depth": 1,
     "seeds": ["https://dgms.gov.in/"]},
]

# An anchor becomes a candidate when its text or URL reads like an instrument.
# These are the words Indian regulators actually title documents with.
INSTRUMENT = re.compile(
    r"\b(act|acts|rule|rules|regulation|regulations|notification|notifications|"
    r"gazette|order|orders|guideline|guidelines|standard|standards|circular|"
    r"circulars|direction|directions|amendment|amendments|schedule|policy|"
    r"code|bye-?laws?|ordinance|manual|protocol|sop|advisory|advisories|"
    r"norms|criteria|requirement|requirements|framework|scheme)\b", re.I)

# Healthcare relevance. A document must touch the sector somewhere in its title
# or path, or come from a page whose own address already says health.
HEALTH = re.compile(
    r"\b(health|hospital|clinic|clinical|medical|medicine|medicines|drug|drugs|"
    r"pharma\w*|patient|patients|blood|transfus\w+|nursing|nurse|doctor|"
    r"physician|surgery|surgical|diagnost\w+|patholog\w+|laborator\w+|"
    r"bio-?medical|biomedical|device|devices|cosmetic|cosmetics|vaccine|"
    r"immunis\w+|immuniz\w+|infection|epidemic|disease|diseases|tuberculosis|"
    r"maternal|mater\w+|child|neonat\w+|radiat\w+|radiolog\w+|x-?ray|"
    r"telemedicine|ayush|ayurved\w+|homoeopath\w+|dental|dentist|"
    r"pndt|mtp|transplant\w+|organ|tissue|stem\s*cell|art|surrogacy|"
    r"antimicrobial|antibiotic|amr|sterilis\w+|steriliz\w+|waste|"
    r"nabh|nabl|icmr|cdsco|mohfw|dghs|aerb|accredit\w+|ethic\w+)\b", re.I)

# Pages that are obviously not instruments.
SKIP_URL = re.compile(
    r"(login|signin|captcha|search|sitemap|feedback|contact|tender|vacanc|"
    r"recruit|career|photo|gallery|video|rti-?request|hindi|\.jpg|\.png|\.gif|"
    r"\.zip|\.doc|\.xls|mailto:|javascript:|tel:)", re.I)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


# Anchor text on icmr.gov.in is the file size, not the document name — 18 of the
# first 100 harvested arrived titled "(146 KB)". A size is not a title, and a
# regulation called "(146 KB)" is worse than one named after its own file. So a
# title that carries no words is replaced, in order of authority, by the PDF's
# own /Title metadata and then by its filename. Nothing is composed here: both
# fallbacks are text the document itself carries.
SIZE_ONLY = re.compile(r"^[\s(\[]*\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?)[\s)\]]*$", re.I)
NOISE = re.compile(r"[_\-]+")


def wordless(title: str) -> bool:
    return bool(SIZE_ONLY.match(title or "")) or len(re.sub(r"[^A-Za-z]", "", title or "")) < 6


def from_filename(url: str) -> str:
    stem = Path(urlparse(url).path).stem
    stem = re.sub(r"^[0-9a-f]{8,}", "", stem)           # CMS hash prefixes
    return norm(NOISE.sub(" ", stem))[:300]


def strip_authoring_noise(title: str) -> str:
    """"Microsoft Word - Policy_Brief" is the authoring tool talking, not the
    document naming itself."""
    t = re.sub(r"^\s*(?:Microsoft\s+Word|Microsoft\s+PowerPoint|Adobe\s+\w+)\s*[-–]\s*", "", title, flags=re.I)
    t = re.sub(r"\.(?:docx?|pptx?|indd|cdr|pdf)\s*$", "", t, flags=re.I)
    return norm(t) or title


def better_title(title: str, url: str, pdf_path: Path | None = None) -> str:
    if not wordless(title):
        return title
    if pdf_path and pdf_path.exists():
        try:
            from pypdf import PdfReader
            meta = (PdfReader(str(pdf_path)).metadata or {}).get("/Title") or ""
            if not wordless(str(meta)):
                return strip_authoring_noise(norm(str(meta)))[:300]
        except Exception:                               # noqa: BLE001 — filename still stands
            pass
    return from_filename(url) or title


def reg_id(short: str, url: str) -> str:
    return f"hc-{short.lower()}-{hashlib.sha1(url.encode()).hexdigest()[:10]}"


# ------------------------------------------------------------------ crawl
# Several Indian regulator sites serve an incomplete certificate chain — the NMC
# and the AERB both fail python's verification while browsers accept them, because
# browsers carry intermediates these servers forget to send. Refusing them costs
# the corpus the Code of Medical Ethics and every radiation-safety document. So:
# verify first, always; on a verification error retry once without it and RECORD
# that on the document, so an unverified transport is visible in the data rather
# than silently equivalent to a verified one. The sha256 is still of the bytes we
# actually received.
def request(url: str, timeout: int, **kw) -> tuple[requests.Response, bool]:
    try:
        return requests.get(url, headers=HEADERS, timeout=timeout, **kw), True
    except requests.exceptions.SSLError:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        return requests.get(url, headers=HEADERS, timeout=timeout, verify=False, **kw), False


def get(url: str, timeout: int = PAGE_TIMEOUT) -> requests.Response | None:
    try:
        r, _ = request(url, timeout, allow_redirects=True)
        return r if r.status_code == 200 else None
    except requests.RequestException:
        return None


def links_on(url: str) -> tuple[list[tuple[str, str]], list[str]]:
    """(pdf_links, page_links) — anchor text kept with each PDF URL."""
    r = get(url)
    if not r or "html" not in r.headers.get("content-type", ""):
        return [], []
    soup = BeautifulSoup(r.text, "html.parser")
    host = urlparse(url).netloc
    pdfs: list[tuple[str, str]] = []
    pages: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or SKIP_URL.search(href):
            continue
        full = urljoin(r.url, href)
        if urlparse(full).scheme not in ("http", "https"):
            continue
        text = norm(a.get_text())
        if re.search(r"\.pdf(\?|$)", full, re.I):
            pdfs.append((full, text))
        elif urlparse(full).netloc == host and INSTRUMENT.search(text + " " + full):
            pages.append(full)
    return pdfs, pages


def harvest_links(portal: dict, per_portal_cap: int) -> list[dict]:
    """Seeds first, then one level into sub-indexes that look like instrument lists."""
    seen_pages: set[str] = set()
    found: dict[str, dict] = {}

    def take(pdfs, origin):
        for full, text in pdfs:
            if full in found:
                continue
            title = text or Path(urlparse(full).path).stem.replace("_", " ").replace("-", " ")
            blob = f"{title} {full}"
            if not HEALTH.search(blob) and not HEALTH.search(origin):
                continue
            if not INSTRUMENT.search(blob):
                continue
            found[full] = {"url": full, "title": norm(title)[:300],
                           "regulator": portal["regulator"], "short": portal["short"],
                           "origin": origin}

    frontier = list(portal["seeds"])
    for depth in range(portal["depth"] + 1):
        nxt: list[str] = []
        with ThreadPoolExecutor(8) as ex:
            futs = {ex.submit(links_on, u): u for u in frontier if u not in seen_pages}
            for f in as_completed(futs):
                u = futs[f]
                seen_pages.add(u)
                try:
                    pdfs, pages = f.result()
                except Exception:                       # noqa: BLE001 — one bad page
                    continue
                take(pdfs, u)
                nxt.extend(pages)
        if len(found) >= per_portal_cap:
            break
        frontier = [p for p in dict.fromkeys(nxt) if p not in seen_pages][:60]
    return list(found.values())[:per_portal_cap]


# ----------------------------------------------------------------- fetch
def fetch_pdf(item: dict) -> dict:
    """Download and verify. A response that is not a PDF is a failure, not a doc."""
    out = dict(item)
    try:
        r, tls_ok = request(item["url"], PDF_TIMEOUT, stream=True)
        r.raise_for_status()
        out["tls_verified"] = tls_ok
        body = b""
        for chunk in r.iter_content(64 * 1024):
            body += chunk
            if len(body) > MAX_PDF_BYTES:
                raise ValueError(f"larger than {MAX_PDF_BYTES // 1024 // 1024} MB")
        if not body[:5].startswith(b"%PDF"):
            raise ValueError(f"not a PDF (starts {body[:16]!r})")
        out["bytes"] = len(body)
        out["sha256"] = hashlib.sha256(body).hexdigest()
        out["_body"] = body
    except Exception as e:                              # noqa: BLE001 — recorded, batch continues
        out["error"] = f"{type(e).__name__}: {e}"[:200]
    return out


def extract(rid_url_title: tuple[str, str, str, str]) -> dict:
    """Run the shared extractor in a worker process; artifacts land on disk."""
    rid, url, title, short = rid_url_title
    sys.path.insert(0, str(HERE))
    import extract_pdf_text as X
    try:
        doc = X.extract_one({"id": rid, "title": title, "regulatorShort": short, "pdfUrl": url})
    except Exception as e:                              # noqa: BLE001
        return {"id": rid, "error": f"{type(e).__name__}: {e}"[:200]}
    (EXTRACTED / f"{rid}.json").write_text(json.dumps(doc, ensure_ascii=False))
    return {"id": rid, "pages": doc["pages"], "chars": doc["chars"],
            "sections": len(doc["sections"]), "method": doc["method"]}


def interleave(leads: list[dict]) -> list[dict]:
    """Round-robin the portals so a --limit spans regulators instead of taking
    the first one to finish crawling. NABH alone answers with 88 notifications;
    without this the cut-off would be a single accreditation body's noticeboard."""
    buckets: dict[str, list[dict]] = {}
    for l in leads:
        buckets.setdefault(l["short"], []).append(l)
    out, i = [], 0
    while any(len(b) > i for b in buckets.values()):
        for short in sorted(buckets):
            if len(buckets[short]) > i:
                out.append(buckets[short][i])
        i += 1
    return out


# ------------------------------------------------------------------ main
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=150, help="documents to harvest")
    ap.add_argument("--per-portal", type=int, default=40)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--probe", action="store_true", help="list what each portal yields, fetch nothing")
    a = ap.parse_args()

    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    EXTRACTED.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    print("== 1/4 crawl the portals ==", flush=True)
    leads: list[dict] = []
    with ThreadPoolExecutor(len(PORTALS)) as ex:
        futs = {ex.submit(harvest_links, p, a.per_portal): p for p in PORTALS}
        for f in as_completed(futs):
            p = futs[f]
            try:
                got = f.result()
            except Exception as e:                      # noqa: BLE001
                print(f"  {p['short']:6} FAILED {type(e).__name__}: {e}", flush=True)
                continue
            print(f"  {p['short']:6} {len(got):3} candidate documents", flush=True)
            leads.extend(got)
    print(f"  {len(leads)} candidates in {time.time() - t0:.0f}s", flush=True)
    if a.probe:
        for l in leads[:80]:
            print(f"    {l['short']:6} {l['title'][:88]}")
        return

    leads = interleave(leads)[:a.limit]
    print(f"\n== 2/4 fetch and verify {len(leads)} documents ==", flush=True)
    t1 = time.time()
    fetched, failed, by_sha = [], [], {}
    with ThreadPoolExecutor(a.workers * 2) as ex:
        for res in ex.map(fetch_pdf, leads):
            if res.get("error"):
                failed.append({k: v for k, v in res.items() if k != "_body"})
                continue
            sha = res["sha256"]
            if sha in by_sha:                           # same bytes, different URL
                res["duplicate_of"] = by_sha[sha]
                failed.append({k: v for k, v in res.items() if k != "_body"})
                continue
            rid = reg_id(res["short"], res["url"])
            by_sha[sha] = rid
            (DOCS_DIR / f"{rid}.pdf").write_bytes(res.pop("_body"))
            res["id"] = rid
            fetched.append(res)
    print(f"  verified {len(fetched)} · failed/duplicate {len(failed)} · {time.time() - t1:.0f}s", flush=True)

    print(f"\n== 3/4 extract text ({a.workers} processes) ==", flush=True)
    t2 = time.time()
    results = {}
    with ProcessPoolExecutor(a.workers) as ex:
        for r in ex.map(extract, [(d["id"], d["url"], d["title"], d["short"]) for d in fetched]):
            results[r["id"]] = r
    ok = [r for r in results.values() if not r.get("error")]
    print(f"  extracted {len(ok)}/{len(fetched)} · {time.time() - t2:.0f}s", flush=True)

    print("\n== 4/4 write the register ==", flush=True)
    repaired = 0
    for d in fetched:
        d.update({k: v for k, v in results.get(d["id"], {}).items() if k != "id"})
        fixed = better_title(d["title"], d["url"], DOCS_DIR / f"{d['id']}.pdf")
        if fixed != d["title"]:
            d["title_from_anchor"], d["title"] = d["title"], fixed
            repaired += 1
    if repaired:
        print(f"  {repaired} titles taken from the document instead of the anchor text", flush=True)
    REGISTER.write_text(json.dumps(
        {"harvested_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
         "seconds": round(time.time() - t0, 1),
         "documents": fetched, "rejected": failed}, ensure_ascii=False, indent=1))
    usable = [d for d in fetched if d.get("sections")]
    print(f"  {REGISTER}")
    print(f"  {len(usable)} documents with text · {sum(d.get('sections', 0) for d in fetched)} sections "
          f"· {time.time() - t0:.0f}s total", flush=True)


if __name__ == "__main__":
    main()
