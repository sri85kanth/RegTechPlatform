"""
Multi-authority regulation scraper — deep-crawls official government indexes
and emits structured JSON the Company Brain app consumes as REAL source data.

A company faces the whole regulatory landscape, not one regulator. Sources:

  RBI        — Master Directions index (banking)             [row-parsed table]
  IndiaCode  — ALL central acts of India (labour, corporate,  [paginated deep crawl]
               tax, environment, criminal, IT/data, …)
  SEBI       — Securities regulations listing                 [paginated deep crawl]
  IRDAI      — consolidated gazette-notified regulations      [table]
  CBIC       — GST acts                                       [pdf anchors]

Honesty rules (match the app's "no dummy data" constraint):
  - Every field comes from the scraped page; nothing is invented.
  - Fields a source doesn't provide are simply absent.
  - Sources that fail are reported in `sources[].error`, never silently dropped.

Output:
  output/regulations.json                          — full structured dataset
  ../company-brain-app/public/data/regulations.json — copy the app fetches
"""
import asyncio
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup
from crawl4ai import AsyncWebCrawler

HERE = Path(__file__).parent
OUT = HERE / "output" / "regulations.json"
APP_COPY = HERE.parent / "company-brain-app" / "public" / "data" / "regulations.json"

RBI_DATE_RE = re.compile(r"^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}$")  # "Jan 09, 2026"


def slug_id(prefix: str, key: str) -> str:
    return f"{prefix}-{hashlib.sha1(key.encode()).hexdigest()[:10]}"


# ---------------------------------------------------------------- RBI
def parse_rbi(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*="BS_ViewMasDirections.aspx?id="]'):
        href = a.get("href") or ""
        m = re.search(r"id=(\d+)", href)
        if not m:
            continue
        rbi_id = m.group(1)
        title = " ".join(a.get_text(" ", strip=True).split())
        if not title or rbi_id in seen:
            continue
        seen.add(rbi_id)
        row = a.find_parent("tr")
        date = category = pdf_url = None
        if row is not None:
            pdf_a = row.select_one('a[href*=".pdf" i]')
            if pdf_a:
                pdf_url = pdf_a.get("href")
            prev, hops = row.find_previous_sibling("tr"), 0
            while prev is not None and hops < 40 and (date is None or category is None):
                tds = prev.find_all("td")
                if len(tds) == 1:
                    txt = " ".join(tds[0].get_text(" ", strip=True).split())
                    if RBI_DATE_RE.match(txt):
                        date = date or txt
                    elif txt and category is None and date is not None:
                        category = txt
                prev, hops = prev.find_previous_sibling("tr"), hops + 1
        item = {
            "id": f"rbi-md-{rbi_id}",
            "sourceId": rbi_id,
            "regulator": "Reserve Bank of India",
            "regulatorShort": "RBI",
            "sector": "Banking & Finance",
            "kind": "Master Direction",
            "title": title,
            "detailUrl": href if href.startswith("http") else f"https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id={rbi_id}",
        }
        if date: item["date"] = date
        if category: item["category"] = category
        if pdf_url: item["pdfUrl"] = pdf_url
        items.append(item)
    return items


# ---------------------------------------------------------------- IndiaCode (all central acts)
def parse_indiacode(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for tr in soup.select("table tr"):
        tds = tr.find_all("td")
        if len(tds) < 3:
            continue
        date = " ".join(tds[0].get_text(" ", strip=True).split())
        act_no = " ".join(tds[1].get_text(" ", strip=True).split())
        title = " ".join(tds[2].get_text(" ", strip=True).split())
        a = tr.find("a", href=re.compile(r"/handle/"))
        if not title or a is None:
            continue
        href = a.get("href") or ""
        handle = re.search(r"/handle/([\d/]+)", href)
        sid = (handle.group(1).replace("/", "-")) if handle else hashlib.sha1(title.encode()).hexdigest()[:8]
        item = {
            "id": f"ic-{sid}",
            "sourceId": sid,
            "regulator": "Government of India — India Code",
            "regulatorShort": "India Code",
            "sector": "Central Legislation (all sectors)",
            "kind": "Central Act",
            "title": title,
            "detailUrl": f"https://www.indiacode.nic.in{href.split('?')[0]}",
        }
        if date: item["date"] = date
        if act_no: item["category"] = f"Act No. {act_no}"
        items.append(item)
    return items


# ---------------------------------------------------------------- SEBI
def parse_sebi(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for a in soup.select('a[href*="/legal/regulations/"]'):
        href = a.get("href") or ""
        title = " ".join(a.get_text(" ", strip=True).split())
        if not title or len(title) < 15:
            continue
        tr = a.find_parent("tr")
        year = None
        if tr is not None:
            tds = tr.find_all("td")
            if tds:
                y = tds[0].get_text(" ", strip=True)
                if re.match(r"^(19|20)\d{2}$", y):
                    year = y
        item = {
            "id": slug_id("sebi", href),
            "sourceId": href.rsplit("/", 1)[-1][:60],
            "regulator": "Securities and Exchange Board of India",
            "regulatorShort": "SEBI",
            "sector": "Securities Markets",
            "kind": "Regulation",
            "title": title,
            "detailUrl": href if href.startswith("http") else f"https://www.sebi.gov.in{href}",
        }
        if year: item["date"] = year
        items.append(item)
    return items


# ---------------------------------------------------------------- IRDAI
def parse_irdai(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for tr in soup.select("table tr"):
        tds = tr.find_all("td")
        if len(tds) < 3:
            continue
        title = " ".join(tds[2].get_text(" ", strip=True).split())
        if not title:
            continue
        a = tr.select_one('a[href*="/documents/"]') or tr.find("a")
        href = (a.get("href") or "") if a else ""
        item = {
            "id": slug_id("irdai", title),
            "sourceId": slug_id("irdai", title)[6:],
            "regulator": "Insurance Regulatory and Development Authority of India",
            "regulatorShort": "IRDAI",
            "sector": "Insurance",
            "kind": "Regulation",
            "title": title,
            "detailUrl": "https://irdai.gov.in/consolidated-gazette-notified-regulations",
        }
        if href:
            item["pdfUrl"] = href if href.startswith("http") else f"https://irdai.gov.in{href}"
        items.append(item)
    return items


# ---------------------------------------------------------------- CBIC (GST acts)
def parse_cbic(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*=".pdf" i]'):
        title = " ".join(a.get_text(" ", strip=True).split())
        href = a.get("href") or ""
        if not title or len(title) < 8 or title.lower() in seen:
            continue
        seen.add(title.lower())
        items.append({
            "id": slug_id("cbic", href),
            "sourceId": slug_id("cbic", href)[5:],
            "regulator": "Central Board of Indirect Taxes and Customs",
            "regulatorShort": "CBIC",
            "sector": "Taxation (GST)",
            "kind": "Act",
            "title": title,
            "detailUrl": "https://cbic-gst.gov.in/gst-acts.html",
            "pdfUrl": href if href.startswith("http") else f"https://cbic-gst.gov.in/{href.lstrip('/')}",
        })
    return items


# ---------------------------------------------------------------- RBI FEMA notifications
def parse_fema(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*="BS_FemaNotifications.aspx"]'):
        href = (a.get("href") or "").split("#")[0]
        m = re.search(r"Id=(\d+)", href, re.I)
        title = " ".join(a.get_text(" ", strip=True).split())
        if not m or not title or len(title) < 12 or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        items.append({
            "id": f"fema-{m.group(1)}",
            "sourceId": m.group(1),
            "regulator": "Reserve Bank of India",
            "regulatorShort": "RBI",
            "sector": "Foreign Exchange (FEMA)",
            "kind": "FEMA Notification",
            "title": title,
            "detailUrl": href if href.startswith("http") else f"https://www.rbi.org.in/Scripts/BS_FemaNotifications.aspx?Id={m.group(1)}",
        })
    return items


# ---------------------------------------------------------------- TRAI regulations (paginated)
def parse_trai(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for row in soup.select(".view-content .views-row"):
        pdf_a = row.select_one('a[href*=".pdf" i]')
        if pdf_a is None:
            continue
        href = pdf_a.get("href") or ""
        # the full instrument name lives in the download link's aria-label:
        #   "Download PDF for Telecommunication Tariff (72nd Amendment) Order, 2026 - (3.32 MB)…"
        aria = pdf_a.get("aria-label") or ""
        m_t = re.search(r"Download PDF for\s+(.+?)\s*-\s*\(", aria)
        title = m_t.group(1).strip() if m_t else ""
        if not title:
            row_title = " ".join(row.get_text(" ", strip=True).split())
            title = re.sub(r"Download\s*\([^)]*\)", "", row_title).strip(" |·-")
        if not title:
            continue
        date = None
        m = re.search(r"(\d{2})(\d{2})(\d{4})", href)
        if m:
            date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        item = {
            "id": slug_id("trai", href),
            "sourceId": href.rsplit("/", 1)[-1][:60],
            "regulator": "Telecom Regulatory Authority of India",
            "regulatorShort": "TRAI",
            "sector": "Telecom",
            "kind": "Regulation",
            "title": title[:220],
            "detailUrl": "https://trai.gov.in/release-publication/regulations",
            "pdfUrl": href if href.startswith("http") else f"https://trai.gov.in{href}",
        }
        if date:
            item["date"] = date
        items.append(item)
    return items


# ---------------------------------------------------------------- CCI (Competition Act page)
def parse_cci_act(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*="/images/legalframework" i]'):
        href = a.get("href") or ""
        slug = href.rstrip("/").rsplit("/", 1)[-1]
        # titles are only in the URL slug (link text is an icon) — derive honestly from it.
        # slugs end with year+upload-timestamp ("…-act-20021652103427.pdf"): keep the year, drop the timestamp
        base = re.sub(r"\.pdf$", "", slug, flags=re.I)
        base = re.sub(r"(\d{4})\d{5,}$", r"\1", base)
        words = base.replace("-", " ").split()
        title = " ".join(w if w in ("of", "and") else w.capitalize() for w in words).strip()
        if not title or title.lower() in seen:
            continue
        seen.add(title.lower())
        items.append({
            "id": slug_id("cci", slug),
            "sourceId": slug[:60],
            "regulator": "Competition Commission of India",
            "regulatorShort": "CCI",
            "sector": "Competition Law",
            "kind": "Act",
            "title": title,
            "detailUrl": "https://www.cci.gov.in/legal-framwork/act",
            "pdfUrl": href if href.startswith("http") else f"https://www.cci.gov.in{href}",
        })
    return items


# ---------------------------------------------------------------- MeitY (client-rendered list)
NOISE_RE = re.compile(r"(visibility|देखें|download|डाउनलोड|view)", re.I)


def parse_meity(html: str) -> list[dict]:
    """MeitY's docs render client-side; the crawl waits for upload anchors first
    (see crawl_meity). The title lives in the row around the icon-anchor."""
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*="/uploads/"], a[href*=".pdf" i]'):
        href = a.get("href") or ""
        if "/uploads/" not in href and ".pdf" not in href.lower():
            continue
        # title = the longest meaningful cell in the row (never the Type/Size cell)
        def clean(t: str) -> str:
            t = NOISE_RE.sub("", t)
            t = re.sub(r"Type\s*/\s*Size.*$", "", t, flags=re.I)
            t = re.sub(r"\d+(\.\d+)?\s*(KB|MB|केबी|एमबी)", "", t, flags=re.I)
            return " ".join(t.split()).strip(" |·-—:")
        title = ""
        tr = a.find_parent("tr")
        if tr is not None:
            cells = sorted((clean(td.get_text(" ", strip=True)) for td in tr.find_all(["td", "th"])), key=len, reverse=True)
            title = cells[0] if cells else ""
        if len(title) < 12:
            node = a
            for _ in range(6):
                node = node.parent
                if node is None:
                    break
                txt = clean(node.get_text(" ", strip=True))
                if len(txt) > 20:
                    title = txt
                    break
        if len(title) < 12 or title.lower() in seen:
            continue
        seen.add(title.lower())
        # row text carries scaffolding: "Title: draft <name> Published Date: dd.mm.yyyy"
        date = None
        m_d = re.search(r"Published Date:\s*([\d.\-/]+)", title)
        if m_d:
            date = m_d.group(1).strip(".")
        title = re.sub(r"Published Date:.*$", "", title).strip()
        title = re.sub(r"^Title:\s*", "", title, flags=re.I)
        is_draft = bool(re.match(r"^draft\b", title, flags=re.I))
        title = re.sub(r"^draft\s*", "", title, flags=re.I).strip()
        item = {
            "id": slug_id("meity", href),
            "sourceId": href.rsplit("/", 1)[-1][:60],
            "regulator": "Ministry of Electronics and Information Technology",
            "regulatorShort": "MeitY",
            "sector": "IT & Data Protection",
            "kind": "Draft Rule" if is_draft else "Act / Policy",
            "title": title[:220],
            "detailUrl": "https://www.meity.gov.in/documents/act-and-policies",
            "pdfUrl": href if href.startswith("http") else f"https://www.meity.gov.in{href}",
        }
        if date:
            item["date"] = date
        items.append(item)
    if not items:
        raise RuntimeError("MeitY: no rendered document rows (client fetch may have failed)")
    return items


async def crawl_meity(crawler):
    from crawl4ai import CrawlerRunConfig
    cfg = CrawlerRunConfig(wait_for="css:a[href*='uploads']", page_timeout=30000)
    r = await crawler.arun(url="https://www.meity.gov.in/documents/act-and-policies", config=cfg)
    if not r.success or not r.html:
        raise RuntimeError(f"status={r.status_code}")
    return parse_meity(r.html)


# ---------------------------------------------------------------- FSSAI (food safety regulations)
def parse_fssai(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*="/docs/food-law/" i]'):
        href = a.get("href") or ""
        if ".pdf" not in href.lower():
            continue
        # the regulation name is the surrounding row text, links are labelled "Regulation/Hindi/…"
        node, title = a, ""
        for _ in range(5):
            node = node.parent
            if node is None:
                break
            txt = " ".join(node.get_text(" ", strip=True).split())
            txt = re.sub(r"(Regulation|Hindi|Compendium|English)\s*·\s*[\d.]+\s*MB", "", txt)
            txt = re.sub(r"[\d.]+\s*MB", "", txt).strip(" |·-—")
            if len(txt) > 25:
                title = txt
                break
        if len(title) < 15:
            title = href.rsplit("/", 1)[-1].replace("_", " ").removesuffix(".pdf")
        # drop header rows that are only generic labels, not regulation names
        if re.fullmatch(r"(?:Corrigenda|Direction|Amendments|Compendium|Regulation|English|Hindi|[\s·|0-9])+", title, flags=re.I):
            continue
        key = title.lower()[:80]
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "id": slug_id("fssai", href),
            "sourceId": href.rsplit("/", 1)[-1][:60],
            "regulator": "Food Safety and Standards Authority of India",
            "regulatorShort": "FSSAI",
            "sector": "Food Safety",
            "kind": "Regulation",
            "title": title[:220],
            "detailUrl": "https://www.fssai.gov.in/food-law/regulations",
            "pdfUrl": href if href.startswith("http") else f"https://www.fssai.gov.in{href}",
        })
    return items


# ---------------------------------------------------------------- DGFT (Foreign Trade Policy)
def parse_dgft(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*=".pdf" i]'):
        href = a.get("href") or ""
        row = a.find_parent("tr")
        title = ""
        if row is not None:
            cells = [" ".join(td.get_text(" ", strip=True).split()) for td in row.find_all("td")]
            cells = [re.sub(r"Download.*$", "", c).strip() for c in cells]
            cells = [c for c in cells if len(c) > 6]
            if cells:
                title = max(cells, key=len)
        if len(title) < 6:
            title = href.rsplit("/", 1)[-1].replace("_", " ").removesuffix(".pdf")
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        items.append({
            "id": slug_id("dgft", href),
            "sourceId": href.rsplit("/", 1)[-1][:60],
            "regulator": "Directorate General of Foreign Trade",
            "regulatorShort": "DGFT",
            "sector": "Foreign Trade",
            "kind": "Foreign Trade Policy",
            "title": title[:220],
            "detailUrl": "https://www.dgft.gov.in/CP/?opt=ft-policy",
            "pdfUrl": href if href.startswith("http") else f"https://content.dgft.gov.in{href}",
        })
    return items


# ---------------------------------------------------------------- CERT-In (cyber directions & guidelines)
def parse_certin(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*=".pdf" i]'):
        href = a.get("href") or ""
        title = " ".join(a.get_text(" ", strip=True).split())
        if len(title) < 15 or title.lower() in seen:
            continue
        seen.add(title.lower())
        items.append({
            "id": slug_id("certin", href),
            "sourceId": href.rsplit("/", 1)[-1][:60],
            "regulator": "Indian Computer Emergency Response Team",
            "regulatorShort": "CERT-In",
            "sector": "Cyber Security",
            "kind": "Direction / Guideline",
            "title": title[:220],
            "detailUrl": "https://www.cert-in.org.in/Directions70B.jsp",
            "pdfUrl": href if href.startswith("http") else f"https://www.cert-in.org.in{href.lstrip('.')}" if href.startswith("/") else f"https://www.cert-in.org.in/{href}",
        })
    return items


# ---------------------------------------------------------------- PFRDA (pension regulations)
def parse_pfrda(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items, seen = [], set()
    for a in soup.select('a[href*="/w/"], a[href*=".pdf" i]'):
        title = " ".join(a.get_text(" ", strip=True).split())
        href = a.get("href") or ""
        # keep only entries that read like regulations, not circulars/tenders
        if not re.search(r"Regulations?[, ]", title) or len(title) < 20:
            continue
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        items.append({
            "id": slug_id("pfrda", href or title),
            "sourceId": (href.rsplit("/", 1)[-1] or slug_id("pfrda", title))[:60],
            "regulator": "Pension Fund Regulatory and Development Authority",
            "regulatorShort": "PFRDA",
            "sector": "Pensions",
            "kind": "Regulation",
            "title": title[:220],
            "detailUrl": href if href.startswith("http") else f"https://pfrda.org.in{href}",
        })
    if not items:
        raise RuntimeError("PFRDA: no regulation-shaped anchors found on page")
    return items


# ---------------------------------------------------------------- IBBI (insolvency regulations)
async def crawl_ibbi(crawler):
    last_err = None
    for url in ("https://ibbi.gov.in/en/legal-framework/regulations", "https://ibbi.gov.in/legal-framework"):
        try:
            r = await crawler.arun(url=url)
            if not r.success or not r.html or (r.status_code or 0) >= 400:
                raise RuntimeError(f"status={r.status_code}")
            soup = BeautifulSoup(r.html, "html.parser")
            items, seen = [], set()
            for a in soup.select('a[href*=".pdf" i], a[href*="/uploads/" i]'):
                title = " ".join(a.get_text(" ", strip=True).split())
                href = a.get("href") or ""
                if len(title) < 20 or "regulation" not in title.lower():
                    continue
                if title.lower() in seen:
                    continue
                seen.add(title.lower())
                items.append({
                    "id": slug_id("ibbi", href), "sourceId": href.rsplit("/", 1)[-1][:60],
                    "regulator": "Insolvency and Bankruptcy Board of India", "regulatorShort": "IBBI",
                    "sector": "Insolvency", "kind": "Regulation", "title": title[:220],
                    "detailUrl": url,
                    "pdfUrl": href if href.startswith("http") else f"https://ibbi.gov.in{href}",
                })
            if items:
                return items
            last_err = RuntimeError(f"{url}: no regulation anchors")
        except Exception as e:
            last_err = e
    raise last_err or RuntimeError("IBBI: all candidate URLs failed")


# ---------------------------------------------------------------- CPCB (environment law compendium)
def parse_cpcb(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    items = []
    for a in soup.select('a[href*=".pdf" i]'):
        title = " ".join(a.get_text(" ", strip=True).split())
        href = a.get("href") or ""
        # only actual law/rule material (the page also links certificates, reports…)
        if not re.search(r"(act|rule|notification|law)", title, re.I) or len(title) < 20:
            continue
        items.append({
            "id": slug_id("cpcb", href),
            "sourceId": href.rsplit("/", 1)[-1][:60],
            "regulator": "Central Pollution Control Board",
            "regulatorShort": "CPCB",
            "sector": "Environment",
            "kind": "Compendium / Rules",
            "title": title[:220],
            "detailUrl": "https://cpcb.nic.in/env-protection-act/",
            "pdfUrl": href if href.startswith("http") else f"https://cpcb.nic.in/{href.lstrip('./').lstrip('/')}",
        })
    if not items:
        raise RuntimeError("CPCB: no law/rule PDFs found")
    return items


# ---------------------------------------------------------------- crawl plan
async def crawl_single(crawler, url, parser):
    r = await crawler.arun(url=url)
    if not r.success or not r.html:
        raise RuntimeError(f"status={r.status_code}")
    return parser(r.html)


async def crawl_paginated(crawler, url_for_page, parser, max_pages, page_delay=0.5):
    """Deep crawl: follow pagination until a page yields nothing new."""
    all_items, seen_ids = [], set()
    for p in range(max_pages):
        r = await crawler.arun(url=url_for_page(p))
        if not r.success or not r.html:
            break
        items = parser(r.html)
        fresh = [i for i in items if i["id"] not in seen_ids]
        if not fresh:
            break
        for i in fresh:
            seen_ids.add(i["id"])
        all_items.extend(fresh)
        print(f"    page {p + 1}: +{len(fresh)} (total {len(all_items)})")
        await asyncio.sleep(page_delay)
    return all_items


SOURCES = [
    {
        "name": "RBI Master Directions",
        "regulator": "Reserve Bank of India",
        "kind": "Master Direction",
        "url": "https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx",
        "run": lambda c: crawl_single(c, "https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx", parse_rbi),
    },
    {
        "name": "India Code — all central acts",
        "regulator": "Government of India — India Code",
        "kind": "Central Act",
        "url": "https://www.indiacode.nic.in/handle/123456789/1362/browse?type=shorttitle",
        "run": lambda c: crawl_paginated(
            c,
            lambda p: f"https://www.indiacode.nic.in/handle/123456789/1362/browse?type=shorttitle&sort_by=1&order=ASC&rpp=100&offset={p * 100}",
            parse_indiacode, max_pages=12),
    },
    {
        "name": "SEBI regulations",
        "regulator": "Securities and Exchange Board of India",
        "kind": "Regulation",
        "url": "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=3&smid=0",
        "run": lambda c: crawl_paginated(
            c,
            lambda p: f"https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=3&smid=0&pno={p + 1}",
            parse_sebi, max_pages=10),
    },
    {
        "name": "IRDAI consolidated regulations",
        "regulator": "Insurance Regulatory and Development Authority of India",
        "kind": "Regulation",
        "url": "https://irdai.gov.in/consolidated-gazette-notified-regulations",
        "run": lambda c: crawl_single(c, "https://irdai.gov.in/consolidated-gazette-notified-regulations", parse_irdai),
    },
    {
        "name": "CBIC GST acts",
        "regulator": "Central Board of Indirect Taxes and Customs",
        "kind": "Act",
        "url": "https://cbic-gst.gov.in/gst-acts.html",
        "run": lambda c: crawl_single(c, "https://cbic-gst.gov.in/gst-acts.html", parse_cbic),
    },
    # ---- Tier 1 ----
    {
        "name": "RBI FEMA notifications",
        "regulator": "Reserve Bank of India",
        "kind": "FEMA Notification",
        "url": "https://www.rbi.org.in/Scripts/BS_viewfemanewnotification.aspx",
        "run": lambda c: crawl_single(c, "https://www.rbi.org.in/Scripts/BS_viewfemanewnotification.aspx", parse_fema),
    },
    {
        "name": "TRAI regulations",
        "regulator": "Telecom Regulatory Authority of India",
        "kind": "Regulation",
        "url": "https://trai.gov.in/release-publication/regulations",
        "run": lambda c: crawl_paginated(
            c,
            lambda p: f"https://trai.gov.in/release-publication/regulations?page={p}",
            parse_trai, max_pages=12),
    },
    {
        "name": "CCI Competition Act",
        "regulator": "Competition Commission of India",
        "kind": "Act",
        "url": "https://www.cci.gov.in/legal-framwork/act",
        "run": lambda c: crawl_single(c, "https://www.cci.gov.in/legal-framwork/act", parse_cci_act),
    },
    {
        "name": "MeitY acts & policies",
        "regulator": "Ministry of Electronics and Information Technology",
        "kind": "Act / Policy",
        "url": "https://www.meity.gov.in/documents/act-and-policies",
        "run": crawl_meity,
    },
    # ---- Tier 2 ----
    {
        "name": "FSSAI food safety regulations",
        "regulator": "Food Safety and Standards Authority of India",
        "kind": "Regulation",
        "url": "https://www.fssai.gov.in/food-law/regulations",
        "run": lambda c: crawl_single(c, "https://www.fssai.gov.in/food-law/regulations", parse_fssai),
    },
    {
        "name": "DGFT Foreign Trade Policy",
        "regulator": "Directorate General of Foreign Trade",
        "kind": "Foreign Trade Policy",
        "url": "https://www.dgft.gov.in/CP/?opt=ft-policy",
        "run": lambda c: crawl_single(c, "https://www.dgft.gov.in/CP/?opt=ft-policy", parse_dgft),
    },
    {
        "name": "CERT-In directions & guidelines",
        "regulator": "Indian Computer Emergency Response Team",
        "kind": "Direction / Guideline",
        "url": "https://www.cert-in.org.in/Directions70B.jsp",
        "run": lambda c: crawl_single(c, "https://www.cert-in.org.in/Directions70B.jsp", parse_certin),
    },
    {
        "name": "PFRDA pension regulations",
        "regulator": "Pension Fund Regulatory and Development Authority",
        "kind": "Regulation",
        "url": "https://pfrda.org.in/regulatory-framework/regulations",
        "run": lambda c: crawl_single(c, "https://pfrda.org.in/regulatory-framework/regulations", parse_pfrda),
    },
    {
        # IBBI serves HTTP 500 to headless crawlers — kept registered so each daily
        # run retries and the failure stays visible in the app's Source Monitor.
        "name": "IBBI insolvency regulations",
        "regulator": "Insolvency and Bankruptcy Board of India",
        "kind": "Regulation",
        "url": "https://ibbi.gov.in/en/legal-framework/regulations",
        "run": crawl_ibbi,
    },
    # ---- Tier 3 (what was reachable) ----
    {
        "name": "CPCB pollution control law compendium",
        "regulator": "Central Pollution Control Board",
        "kind": "Compendium / Rules",
        "url": "https://cpcb.nic.in/env-protection-act/",
        "run": lambda c: crawl_single(c, "https://cpcb.nic.in/env-protection-act/", parse_cpcb),
    },
    # NOTE (honest skips, see SOURCES.md):
    #  - MCA acts-rules "e-books": JS application, content via XHR — acts covered by India Code.
    #  - EPFO Acts page: serves an empty page to headless browsers; acts covered by India Code.
    #  - CBDT incometaxindia.gov.in: 302/JS app; Income-tax acts covered by India Code.
]


async def scrape() -> dict:
    all_items, source_meta = [], []
    async with AsyncWebCrawler() as crawler:
        for src in SOURCES:
            print(f"[crawl] {src['name']}")
            meta = {"name": src["name"], "regulator": src["regulator"], "kind": src["kind"], "url": src["url"]}
            try:
                items = await src["run"](crawler)
                meta["count"] = len(items)
                all_items.extend(items)
                print(f"[ok] {src['name']} — {len(items)}")
            except Exception as e:  # report, never silently drop
                meta["count"] = 0
                meta["error"] = str(e)[:200]
                print(f"[FAIL] {src['name']} — {e}")
            source_meta.append(meta)

    # de-dup across sources by id
    seen, deduped = set(), []
    for i in all_items:
        if i["id"] in seen:
            continue
        seen.add(i["id"])
        deduped.append(i)

    # merge cached ministry enrichment (produced by enrich_ministries.py)
    map_file = HERE / "output" / "ministry_map.json"
    if map_file.exists():
        mmap = json.loads(map_file.read_text())
        tagged = 0
        for i in deduped:
            if i["id"] in mmap:
                i["ministry"] = mmap[i["id"]]
                tagged += 1
        print(f"[enrich] ministry tags applied: {tagged}")

    return {
        "scrapedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": source_meta,
        "count": len(deduped),
        "regulations": deduped,
    }


CHANGES_OUT = HERE / "output" / "changes.json"
APP_CHANGES = HERE.parent / "company-brain-app" / "public" / "data" / "changes.json"
WATCHED_FIELDS = ("title", "date", "category", "pdfUrl", "detailUrl")
MAX_RUNS_KEPT = 30


def diff_against_previous(data: dict) -> dict:
    """Compare this crawl with the previous snapshot → a change record.
    firstSeenAt is carried forward so the app can honestly badge NEW items."""
    prev = json.loads(OUT.read_text()) if OUT.exists() else None
    prev_by_id = {r["id"]: r for r in (prev or {}).get("regulations", [])}
    run_at = data["scrapedAt"]
    baseline = prev is None

    added, updated = [], []
    for r in data["regulations"]:
        old = prev_by_id.get(r["id"])
        if old is None:
            r["firstSeenAt"] = run_at if not baseline else run_at
            if not baseline:
                added.append({"id": r["id"], "title": r["title"], "regulatorShort": r["regulatorShort"], "date": r.get("date"), "pdfUrl": r.get("pdfUrl"), "detailUrl": r["detailUrl"]})
        else:
            r["firstSeenAt"] = old.get("firstSeenAt", (prev or {}).get("scrapedAt", run_at))
            changed = {f: {"old": old.get(f), "new": r.get(f)} for f in WATCHED_FIELDS if old.get(f) != r.get(f)}
            if changed:
                updated.append({"id": r["id"], "title": r["title"], "regulatorShort": r["regulatorShort"], "changes": changed})

    # disappeared ids — often a source hiccup, so report, don't delete history
    removed = [{"id": i, "title": prev_by_id[i]["title"], "regulatorShort": prev_by_id[i]["regulatorShort"]}
               for i in prev_by_id if i not in {r["id"] for r in data["regulations"]}]

    run = {
        "runAt": run_at,
        "baseline": baseline,
        "counts": {"added": len(added), "updated": len(updated), "removed": len(removed), "total": data["count"]},
        "sourceErrors": [{"name": s["name"], "error": s["error"]} for s in data["sources"] if s.get("error")],
        "added": added,
        "updated": updated,
        "removed": removed,
    }
    history = json.loads(CHANGES_OUT.read_text()) if CHANGES_OUT.exists() else {"runs": []}
    history["runs"] = ([run] + history["runs"])[:MAX_RUNS_KEPT]
    history["latestRunAt"] = run_at
    return history


def main() -> None:
    data = asyncio.run(scrape())
    history = diff_against_previous(data)   # must run BEFORE overwriting OUT

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    CHANGES_OUT.write_text(json.dumps(history, indent=2, ensure_ascii=False))
    APP_COPY.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUT, APP_COPY)
    shutil.copyfile(CHANGES_OUT, APP_CHANGES)
    print(f"[write] {OUT} and app copy ({data['count']} regulations)")

    latest = history["runs"][0]
    print(f"[diff] added {latest['counts']['added']} · updated {latest['counts']['updated']} · removed {latest['counts']['removed']}"
          + (" · BASELINE RUN" if latest["baseline"] else ""))
    by_reg = {}
    for i in data["regulations"]:
        by_reg[i["regulatorShort"]] = by_reg.get(i["regulatorShort"], 0) + 1
    withpdf = sum(1 for i in data["regulations"] if i.get("pdfUrl"))
    print(f"[summary] by regulator: {by_reg} · with pdf: {withpdf}/{data['count']}")


if __name__ == "__main__":
    main()
