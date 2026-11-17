#!/bin/zsh
# Recurring regulation crawl — invoked by launchd (or manually).
# Logs to output/scrape.log; the app picks up fresh JSON automatically.
cd "$(dirname "$0")"
echo "===== run $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> output/scrape.log
./.venv/bin/python scrape_regulations.py >> output/scrape.log 2>&1
# extract text for a batch of not-yet-extracted PDFs (incremental; skips done ids)
./.venv/bin/python extract_pdf_text.py --limit 25 >> output/scrape.log 2>&1
echo "===== done  $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> output/scrape.log
