# Multi-Authority Regulation Scraper (crawl4ai)

Deep-crawls official government regulation indexes across authorities and emits
structured JSON that the Company Brain app consumes as **real source data**
(no hand-authored regulation lists). A company faces the whole regulatory
landscape — banking, all central legislation (labour, corporate, tax,
environment, IT/data…), securities, insurance, GST.

## What it scrapes (~1,295 regulations)

| Source | Sector | Crawl | Yield |
|---|---|---|---|
| RBI Master Directions index | Banking & Finance | table row-parse | ~383 — title, date, category, PDF |
| India Code — all central acts | Central legislation, all sectors (incl. the four labour codes, Companies Act, DPDP Act, PMLA, Environment Act…) | **paginated deep crawl** (9 pages × 100) | ~845 in-force acts — title, enactment date, act no. |
| SEBI regulations listing | Securities markets | paginated | ~42 |
| IRDAI consolidated regulations | Insurance | table | ~20 — with PDFs |
| CBIC GST acts | Taxation (GST) | pdf anchors | ~5 — with PDFs |

Notes:
- India Code lists **in-force** acts — repealed classics (Factories Act, Trade
  Unions Act…) correctly don't appear; their successor codes do.
- Sources that fail are reported in `sources[].error`, never silently dropped.

Add more authorities by extending `SOURCES` in `scrape_regulations.py` and
writing a `parse_*` function for that index's HTML.

## Run

```bash
cd scraper
./.venv/bin/python scrape_regulations.py
```

First-time setup (already done once):

```bash
python3.13 -m venv .venv          # crawl4ai needs Python ≤ 3.13
./.venv/bin/pip install crawl4ai beautifulsoup4
./.venv/bin/crawl4ai-setup        # installs its playwright browser
```

## Output

- `output/regulations.json` — full dataset with `scrapedAt`, per-source counts
- `../company-brain-app/public/data/regulations.json` — the copy the app
  fetches at runtime (`src/services/regLibrary.ts` → Regulations page
  "Regulatory Library" section)

## Stage 2 — PDF text extraction & clause parsing

```bash
./.venv/bin/python extract_pdf_text.py --limit 25          # next batch
./.venv/bin/python extract_pdf_text.py --ids reg-mdkyc     # specific docs
```

Downloads official PDFs, extracts the text layer (pypdf), parses CHAPTER /
numbered-paragraph structure, and writes `output/extracted/<id>.json` +
`index.json` (mirrored to the app's `public/data/extracted/`). Incremental —
already-extracted ids are skipped; the daily launchd job extracts 25/run.
The app shows this as the regulation's **Full Text** tab, real section text in
the **Structure** tab, and **TEXT** chips in the Regulatory Library.
Scanned (image-only) PDFs fail honestly and are recorded in the index.

## Honesty rules

- Every field comes from the scraped page; nothing is invented.
- Fields the source doesn't provide are absent — the app shows
  "Not available from source" / `—`.
- Re-run the script any time to refresh; `scrapedAt` shows staleness in the UI.
