#!/bin/bash
# Move newly staged hospital vectors into the live index, every 20 minutes.
#
# Measured at 75 rows/s with the HNSW index left in place, so there is no reason
# to batch this into one cutover: each wave of embedding becomes searchable as it
# lands, and the index never has to come out. (embed_offboard's note predicted
# 0.26 rows/s — that was measured when the box was at load 50+.)
#
# Only 'ha-' rows are moved. TeamLease vectors stay staged until their own
# embedding finishes and that swap is asked for.
set -u
cd /srv/company-brain/scraper || exit 1
set -a; . /etc/company-brain/env; set +a

while true; do
  n=$(/srv/company-brain/.venv/bin/python - <<'EOF'
import sys
sys.path.insert(0, "/srv/company-brain/scraper")
from regulatory_ingestion import rag
p = rag.connect_pg()
print(p.execute("SELECT COUNT(*) FROM chunks_staging WHERE regulation_id LIKE %s",
                ("ha-%",)).fetchone()[0])
EOF
)
  if [ "${n:-0}" -gt 0 ]; then
    echo "$(date -Is) $n hospital vectors staged — moving them live"
    /srv/company-brain/.venv/bin/python /tmp/swap_hospital.py --apply | tail -2
  fi
  sleep 1200
done
