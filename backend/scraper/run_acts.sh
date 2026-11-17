#!/bin/bash
# Recover India Code Acts from the Wayback Machine, then run the full
# ingestion chain once every other ingest unit has finished.
set -eo pipefail
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python
echo "== wayback resolution over the full Act backlog =="
$V wayback_indiacode.py --apply --delay 1.5
echo "== waiting for other ingest units =="
while systemctl is-active --quiet cb-backlog.service || systemctl is-active --quiet cb-fema.service || systemctl is-active --quiet cb-sebi.service; do sleep 180; done
echo "== full chain over everything now resolvable =="
exec /srv/company-brain/scraper/run_backlog.sh
