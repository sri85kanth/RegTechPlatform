#!/bin/bash
# Wait for the RBI backfill to finish, then process every remaining authority.
# Settled outcomes are skipped by the runner itself, so RBI is not redone.
cd /Users/ramprasad/Downloads/first/scraper
RBI_PID="$1"

echo "=== chain armed $(date -u +%FT%TZ): waiting on RBI backfill pid $RBI_PID ==="
while kill -0 "$RBI_PID" 2>/dev/null; do sleep 30; done
echo "=== RBI finished $(date -u +%FT%TZ) ==="
psql company_brain -c "SELECT status, count(*) FROM archive_backfill GROUP BY 1 ORDER BY 2 DESC;"

echo "=== remaining authorities starting $(date -u +%FT%TZ) ==="
./.venv/bin/python backfill_archive_versions.py --max-versions 4 --delay 2
echo "=== chain complete $(date -u +%FT%TZ) ==="
psql company_brain -c "
SELECT b.status, r.regulator_short, count(*)
  FROM archive_backfill b JOIN regulations r ON r.id=b.regulation_id
 GROUP BY 1,2 ORDER BY 1, 3 DESC;"
psql company_brain -c "
SELECT count(DISTINCT regulation_id) AS regs_with_changes,
       count(*) FILTER (WHERE change_class='WORDING')        AS wording,
       count(*) FILTER (WHERE change_class='NUMBERING_ONLY') AS renumbered
  FROM section_changes;"
