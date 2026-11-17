#!/bin/bash
# Ingest the harvested healthcare documents. The download and the text
# extraction already happened on the laptop; the artifacts are on disk, so this
# is database work — sections, obligations, applicability, matcher, impact.
set -uo pipefail
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1 HOME=/tmp
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python

echo "=== harvested healthcare documents === $(date -Is)"
$V ingest_harvest.py --apply

echo
echo "=== the backlog documents prefetched alongside them === $(date -Is)"
IDS=$($V - <<PY
from regulatory_ingestion.db import connect
from pathlib import Path
have = {p.stem for p in Path("output/extracted").glob("*.json")} - {"index"}
rows = connect().execute("""SELECT id FROM regulations g
     WHERE official_document_url LIKE %s
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=g.id)""", ("http%",)).fetchall()
print(" ".join(r[0] for r in rows if r[0] in have))
PY
)
if [ -n "$IDS" ]; then
  echo "   targets: $(echo "$IDS" | wc -w)"
  $V ingest_backlog.py --delay 0 --ids $IDS || echo "   (ingest ended early)"
else
  echo "   none"
fi

echo
echo "=== coverage === $(date -Is)"
$V - <<PY
from regulatory_ingestion.db import connect
con = connect()
for label, q in (
  ("regulations",        "SELECT COUNT(*) FROM regulations"),
  ("  with text",        "SELECT COUNT(DISTINCT regulation_id) FROM sections"),
  ("healthcare regs",    "SELECT COUNT(*) FROM regulations WHERE sector=%s OR id LIKE %s"),
  ("  with text",        """SELECT COUNT(DISTINCT s.regulation_id) FROM sections s JOIN regulations g
                             ON g.id=s.regulation_id WHERE g.sector=%s OR g.id LIKE %s"""),
  ("sections",           "SELECT COUNT(*) FROM sections"),
  ("obligations",        "SELECT COUNT(*) FROM obligations"),
):
    p = ("Healthcare", "hosp-%") if "%s" in q else ()
    print(f"  {label:18} {con.execute(q, p).fetchone()[0]:,}")
PY
echo "=== done === $(date -Is)"
