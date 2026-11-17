#!/bin/bash
# OCR every document parked as OCR_REQUIRED: the 212 hospital scans first, then
# the 4,871 TeamLease ones.
#
# OMP_THREAD_LIMIT=1 is the point of this script. Tesseract multi-threads by
# default, so three shards put ~13 threads on 4 cores; pages that read in 2-4
# seconds alone took longer than the 300-second per-page timeout and every
# document came back OCR_REQUIRED having burnt ten minutes. One thread each,
# three shards, is the configuration that measured fastest without timing out.
#
# Each document is re-selected from its OCR_REQUIRED status, so this can be
# stopped and restarted at any point without losing or repeating work.
set -u
cd /srv/company-brain/scraper || exit 1
set -a; . /etc/company-brain/env; set +a
export EXTRACT_LAYOUT_ROUTE=0 OMP_THREAD_LIMIT=1
PY=/srv/company-brain/.venv/bin/python
GATE="--gate-drift-ok --gate-file output/gate.json"
SHARDS=3

start() {   # $1 = script, $2 = log prefix
  for i in $(seq 0 $((SHARDS - 1))); do
    setsid nohup nice -n 5 $PY "$1" --ocr-pass --shards $SHARDS --shard "$i" --follow \
        $GATE > "output/logs/$2$i.log" 2>&1 < /dev/null &
  done
  echo "$(date -Is) started $SHARDS shards of $1"
}

wait_for() { while [ "$(pgrep -u brain -cf "$1")" -gt 0 ]; do sleep 60; done; }

start ingest_hospital.py hospital_ocr
wait_for "ingest_hospital.py --ocr-pass"
echo "$(date -Is) hospital OCR finished"

start ingest_teamlease.py teamlease_ocr
wait_for "ingest_teamlease.py --ocr-pass"
echo "$(date -Is) all OCR finished"
