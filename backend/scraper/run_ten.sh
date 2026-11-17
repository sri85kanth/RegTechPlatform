#!/bin/bash
# Ingest the 10 healthcare instruments that still have no text, then re-embed
# so the new sections are retrievable.
#
# Separate from cb-health because that unit is mid-embedding: two writers on the
# same tables is how half-built state gets made.
set -uo pipefail
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python

# Wait for the embedding run to finish first.
while :; do
  S=$(systemctl show cb-health -p ActiveState --value 2>/dev/null)
  case "$S" in active|activating|reloading|deactivating) sleep 60 ;; *) break ;; esac
done

echo "=== the 10 healthcare instruments === $(date -Is)"
IDS=$($V - <<'PY'
from regulatory_ingestion.db import connect
# '%%' because psycopg reads a bare '%' in a PARAMETERISED query as a
# placeholder: the earlier version raised, returned nothing, and reported
# "nothing to ingest" while silently doing nothing.
rows = connect().execute("""
    SELECT id, title FROM regulations g
     WHERE official_document_url LIKE 'http%%'
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id=g.id)
       AND (g.id LIKE 'hosp-%%' OR g.title ~* %s)
     ORDER BY (g.id LIKE 'hosp-%%') DESC, id""",
    ("clinical establishment|medical|hospital|drug|blood|patient|health|nursing|"
     "pharmac|biomedical|bio-medical|radiation|atomic|narcotic|transplant|organ|"
     "HIV|epidemic|disability|mental health|labour|factories|employees state insurance|"
     "maternity|contract labour|payment of wages|minimum wages|disaster",)).fetchall()
for r in rows:
    print(f"  {r[0]}  {(r[1] or '')[:58]}", file=__import__('sys').stderr)
print(" ".join(r[0] for r in rows))
PY
)
if [ -z "$IDS" ]; then
  echo "   nothing to ingest — every healthcare instrument already has text"
else
  echo "   targets: $(echo "$IDS" | wc -w)"
  $V ingest_backlog.py --delay 2 --ids $IDS || echo "   (ingest ended early)"
  echo "=== re-embed so the new sections are retrievable ==="
  $V -c "from regulatory_ingestion import rag; print(rag.index())" || echo "   (indexing failed)"
fi

echo "=== coverage === $(date -Is)"
$V - <<'PY'
from regulatory_ingestion.db import connect
from regulatory_ingestion.rag import connect_pg
con, rc = connect(), connect_pg()
print("   regulations with text  :", con.execute("SELECT COUNT(DISTINCT regulation_id) FROM sections").fetchone()[0])
print("   hospital regs with text:", con.execute("SELECT COUNT(DISTINCT regulation_id) FROM sections WHERE regulation_id LIKE 'hosp-%'").fetchone()[0])
print("   chunks total           :", rc.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
print("   hospital chunks        :", rc.execute("SELECT COUNT(*) FROM chunks WHERE regulation_id LIKE 'hosp-%'").fetchone()[0])
PY
echo "=== done ==="
