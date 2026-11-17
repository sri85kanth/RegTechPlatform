#!/bin/bash
# Finish the healthcare corpus and get to a real RAG test.
#
# The overnight run recovered 98 Acts from the archive, then began ingesting all
# 135 in id order — 6 minutes each, and it was working through GST and food
# safety circulars. Only 10 of the remaining documents are healthcare
# instruments. Ingesting those takes an hour rather than eleven, and nothing is
# lost: the rest keep their resolved URLs and can be ingested any time without
# re-crawling.
#
# Order matters here. EMBEDDING comes before the derived layers, because a
# retrieval test needs chunks and nothing else — and the test is what was asked
# for. Clauses, semantics and applicability follow afterwards.
set -uo pipefail
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python
say() { echo; echo "=== $* === $(date -Is)"; }

HEALTH_RX='clinical establishment|medical|hospital|drug|blood|patient|health|nursing|pharmac|biomedical|bio-medical|radiation|atomic|narcotic|transplant|organ|HIV|epidemic|disability|mental health|labour|factories|employees state insurance|maternity|contract labour|payment of wages|minimum wages|disaster'

say "1/4 ingest the healthcare instruments still missing text"
IDS=$($V - <<PY
from regulatory_ingestion.db import connect
# psycopg reads '%' as the start of a placeholder, so a literal LIKE pattern
# in a PARAMETERISED query has to be written '%%'. Without this the statement
# raises "only '%s', '%b', '%t' are allowed as placeholders", the id list comes
# back empty, and the run reports "nothing to ingest" while doing nothing.
rows = connect().execute("""
    SELECT id FROM regulations g
     WHERE official_document_url LIKE 'http%%'
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=g.id)
       AND (g.id LIKE 'hosp-%%' OR g.title ~* %s)
     ORDER BY (g.id LIKE 'hosp-%%') DESC, id""", ("$HEALTH_RX",)).fetchall()
print(" ".join(r[0] for r in rows))
PY
)
if [ -z "$IDS" ]; then echo "   nothing to ingest"; else
  echo "   targets: $(echo "$IDS" | wc -w)"
  $V ingest_backlog.py --delay 2 --ids $IDS || echo "   (ingest ended early)"
fi

say "2/4 embed — this is what the retrieval test needs"
$V -c "from regulatory_ingestion import rag; print(rag.index())" || echo "   (indexing failed)"

say "3/4 coverage"
$V - <<'PY'
from regulatory_ingestion.db import connect
from regulatory_ingestion.rag import connect_pg
con, rc = connect(), connect_pg()
print("   regulations with text :", con.execute(
    "SELECT COUNT(DISTINCT regulation_id) FROM sections").fetchone()[0])
print("   hospital regs with text:", con.execute(
    "SELECT COUNT(DISTINCT regulation_id) FROM sections WHERE regulation_id LIKE 'hosp-%'").fetchone()[0])
print("   chunks total          :", rc.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
print("   hospital chunks       :", rc.execute(
    "SELECT COUNT(*) FROM chunks WHERE regulation_id LIKE 'hosp-%'").fetchone()[0])
PY

say "4/4 derived layers (after the test can already run)"
$V extract_clauses.py --apply           || echo "   (clauses failed)"
$V backfill_semantics.py                || echo "   (semantics failed)"
$V reclassify_applicability.py          || echo "   (reclassify failed)"
$V materialise_applicability.py --apply || echo "   (applicability failed)"
say "done"
