#!/bin/bash
# Resolve documents for the register instruments that still have none, then
# ingest whatever the crawl verifies.
#
#   systemd-run --unit=cb-crawl --collect --uid=brain --gid=brain \
#       /srv/company-brain/scraper/run_hosp_crawl.sh
#
# Two stages on purpose. The crawl only RECORDS a URL — and only one it has
# opened, confirmed is a PDF, and found the instrument named inside. Fetching
# and structuring is ingest_backlog's job, with the same %PDF check every other
# source goes through. A portal that blocks us stays blocked and is recorded
# once with the reason, not hammered.
set -e
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python

echo "== before =="
$V - <<'PY'
from regulatory_ingestion.db import connect
con = connect()
for label, q in (
    ("hospital regulations", "SELECT COUNT(*) FROM regulations WHERE id LIKE 'hosp-%'"),
    ("  with a document URL", "SELECT COUNT(*) FROM regulations WHERE id LIKE 'hosp-%' AND official_document_url LIKE 'http%'"),
    ("  with text ingested", "SELECT COUNT(DISTINCT regulation_id) FROM sections WHERE regulation_id LIKE 'hosp-%'"),
):
    print(f"  {label:24} {con.execute(q).fetchone()[0]}")
PY

echo "== crawl the register portals for documents =="
$V crawl_register_documents.py --apply

echo "== ingest whatever the crawl verified =="

IDS=$($V - <<'PY'
from regulatory_ingestion.db import connect
rows = connect().execute(
    """SELECT id FROM regulations g
        WHERE id LIKE 'hosp-%' AND official_document_url LIKE 'http%'
          AND coalesce(ingestion_status,'') <> 'OCR_REQUIRED'
          AND (NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id = g.id)
               OR coalesce(ingestion_status,'') <> 'MAPPED')
        ORDER BY id""").fetchall()
print(" ".join(r[0] for r in rows))
PY
)
if [ -z "$IDS" ]; then
  echo "   nothing new to ingest"
else
  echo "   targets: $(echo "$IDS" | wc -w)"
  $V ingest_backlog.py --delay 2 --ids $IDS
fi

echo "== after =="
$V - <<'PY'
from regulatory_ingestion.db import connect
con = connect()
for label, q in (
    ("  with a document URL", "SELECT COUNT(*) FROM regulations WHERE id LIKE 'hosp-%' AND official_document_url LIKE 'http%'"),
    ("  with text ingested", "SELECT COUNT(DISTINCT regulation_id) FROM sections WHERE regulation_id LIKE 'hosp-%'"),
    ("  sections", "SELECT COUNT(*) FROM sections WHERE regulation_id LIKE 'hosp-%'"),
    ("  obligations", "SELECT COUNT(*) FROM obligations WHERE regulation_id LIKE 'hosp-%'"),
):
    print(f"{label:24} {con.execute(q).fetchone()[0]}")
PY
echo "== done =="
