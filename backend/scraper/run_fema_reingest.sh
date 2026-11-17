#!/bin/bash
# Re-ingest the quarantined FEMA notifications with their corrected URLs.
# Waits for cb-backlog (whose target snapshot still holds the OLD poisoned URLs
# for four fema ids), re-purges anything it re-polluted, then ingests clean.
set -eo pipefail
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python
while systemctl is-active --quiet cb-backlog.service; do sleep 120; done
echo "== cb-backlog finished; guard-purge any re-polluted fema rows =="
UT="3c61a811cf07930378974dc558d152496327b9c039ae5965dab49bd6ec0b10ab"
$V - <<PY
from regulatory_ingestion.db import connect
con = connect()
bad = [r[0] for r in con.execute(
    "SELECT regulation_id FROM documents WHERE document_hash=? AND regulation_id LIKE 'fema-%'", ("$UT",)).fetchall()]
print("re-polluted by the stale snapshot:", bad)
for rid in bad:
    for t in ("penalty_provisions","impact_relationships","impact_scores","applicability_rules",
              "verification_records","obligations","sections","documents"):
        con.execute(f"DELETE FROM {t} WHERE regulation_id=?", (rid,))
    con.execute("UPDATE regulations SET document_id=NULL, source_verified=0, ingestion_status='DISCOVERED' WHERE id=?", (rid,))
    import pathlib
    for p in (f"output/documents/{rid}.pdf", f"output/extracted/{rid}.json"):
        pathlib.Path(p).unlink(missing_ok=True)
con.commit()
PY
IDS=$($V -c "
from regulatory_ingestion.db import connect
rows = connect().execute(\"\"\"SELECT id FROM regulations g WHERE id LIKE 'fema-%'
  AND official_document_url LIKE 'http%'
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=g.id)\"\"\").fetchall()
print(' '.join(r[0] for r in rows))")
echo "== ingesting $(echo $IDS | wc -w) fema notifications =="
$V ingest_backlog.py --delay 3 --ids $IDS
echo "== fema re-ingest done =="
