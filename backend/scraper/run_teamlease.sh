#!/bin/bash
# Supervisor for the TeamLease ingest: N independent shard processes, restarted
# if they die, stopping when every manifest row is accounted for.
#
# Parallelism lives here rather than in a worker pool inside one process — that
# pool silently lost all 8 workers at document 400 and hung for five hours.
# A shard that dies here is just restarted; it re-reads what is still pending.
#
#   ./run_teamlease.sh 8                 # 8 shards, normal pass
#   OCR=1 ./run_teamlease.sh 2           # the OCR backlog, gently
set -u
SHARDS=${1:-8}
SCRAPER=/srv/company-brain/scraper
LOGDIR=$SCRAPER/output/logs
PY=/srv/company-brain/.venv/bin/python
GATE=output/gate.json
EXTRA=""
[ "${OCR:-0}" = "1" ] && EXTRA="--ocr-pass"
[ "${REDO_EMPTY:-0}" = "1" ] && EXTRA="--redo-empty"

cd "$SCRAPER" || exit 1
set -a; . /etc/company-brain/env; set +a
export EXTRACT_LAYOUT_ROUTE=${EXTRACT_LAYOUT_ROUTE:-0}
mkdir -p "$LOGDIR"

start_shard() {   # $1 = shard index
  nohup $PY ingest_teamlease.py --shards "$SHARDS" --shard "$1" --follow \
        --retry-failed --gate-drift-ok --gate-file "$GATE" \
        >> "$LOGDIR/teamlease_shard$1.log" 2>&1 &
  echo $!
}

declare -A PID
for i in $(seq 0 $((SHARDS - 1))); do
  PID[$i]=$(start_shard "$i")
  echo "$(date -Is) shard $i started pid ${PID[$i]}"
done

while true; do
  sleep 60
  alive=0
  for i in $(seq 0 $((SHARDS - 1))); do
    if kill -0 "${PID[$i]}" 2>/dev/null; then
      alive=$((alive + 1))
      continue
    fi
    # exited: finished its share, or died. If work remains, start it again.
    left=$($PY - <<'EOF' 2>/dev/null || echo 0
import csv, os, sys
sys.path.insert(0, "/srv/company-brain/scraper")
from regulatory_ingestion.db import connect
rows = list(csv.DictReader(open("/srv/company-brain/scraper/input/teamlease_manifest.csv",
                                encoding="utf-8-sig")))
con = connect()
done = {r[0] for r in con.execute(
    "SELECT id FROM regulations WHERE id LIKE %s AND ingestion_status IN "
    "('MAPPED','OCR_REQUIRED','FAILED_FETCH')".replace("%s", "?"), ("tl-%",)).fetchall()}
docs = "/srv/company-brain/scraper/output/documents"
print(sum(1 for d in rows if d["id"] not in done
          and os.path.exists(os.path.join(docs, d["id"] + ".pdf"))))
EOF
)
    if [ "${left:-0}" -gt 0 ] 2>/dev/null; then
      PID[$i]=$(start_shard "$i")
      echo "$(date -Is) shard $i restarted pid ${PID[$i]} ($left documents left)"
      alive=$((alive + 1))
    fi
  done
  [ "$alive" -eq 0 ] && { echo "$(date -Is) all shards finished"; break; }
done
