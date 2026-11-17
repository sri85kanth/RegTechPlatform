#!/bin/bash
# Wait for the register crawl to finish, then re-derive applicability.
#
# Chained on the server rather than from a laptop, so an SSH drop cannot strand
# it — the mistake that left an ingestion run looking dead earlier today.
#
# The order matters: reclassifying BEFORE the crawl has ingested its documents
# would re-derive rules for text that is not there yet, and the run costs ~53
# minutes of CPU. Once, after, is the whole point.
set -e
while :; do
  S=$(systemctl show cb-crawl -p ActiveState --value 2>/dev/null)
  case "$S" in active|activating|reloading|deactivating) sleep 30 ;; *) break ;; esac
done
echo "== the crawl has finished; re-deriving applicability =="
exec /srv/company-brain/scraper/run_reclassify.sh
