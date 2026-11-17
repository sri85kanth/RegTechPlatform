#!/bin/bash
# The overnight run: recover every regulation that can be recovered, ingest it,
# then rebuild the derived layers once at the end.
#
#   systemd-run --unit=cb-night --collect --uid=brain --gid=brain \
#       /srv/company-brain/scraper/run_overnight.sh
#   journalctl -u cb-night -f
#
# NOT `set -e`. A blocked portal, a dead archive snapshot or one unparseable PDF
# must not end the night — each phase reports and the run continues. The only
# thing that must always happen is the derived-layer rebuild at the end, so it
# sits outside every loop.
set -uo pipefail
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python

# Stop starting NEW resolution work after this, so the derived layers always get
# their turn before morning rather than being cut off mid-way.
DEADLINE=$(( $(date +%s) + 7*3600 ))

say() { echo; echo "=== $* === $(date -Is)"; }

counts() {
  $V - <<'PY'
from regulatory_ingestion.db import connect
con = connect()
q = {
  "regulations":        "SELECT COUNT(*) FROM regulations",
  "  with a document":  "SELECT COUNT(DISTINCT regulation_id) FROM documents",
  "hospital regs":      "SELECT COUNT(*) FROM regulations WHERE id LIKE 'hosp-%'",
  "  with text":        "SELECT COUNT(DISTINCT regulation_id) FROM sections WHERE regulation_id LIKE 'hosp-%'",
  "sections":           "SELECT COUNT(*) FROM sections",
  "obligations":        "SELECT COUNT(*) FROM obligations",
}
for label, sql in q.items():
    print(f"    {label:20} {con.execute(sql).fetchone()[0]:,}")
PY
}

# Another job may still hold the database; starting on top of it would have two
# writers rebuilding the same tables.
for u in cb-after cb-reclass cb-crawl cb-hosp; do
  while systemctl is-active --quiet "$u" 2>/dev/null || \
        [ "$(systemctl show $u -p ActiveState --value 2>/dev/null)" = "activating" ]; do
    echo "waiting for $u to finish…"; sleep 60
  done
done

say "starting"; counts

# ---------------------------------------------------------------- resolution
say "1/6 India Code via the Internet Archive (168 candidates)"
$V wayback_indiacode.py --apply --delay 2 || echo "  (archive pass ended early)"

say "2/6 register portals"
$V crawl_register_documents.py --apply || echo "  (crawl ended early)"

# ---------------------------------------------------------------- ingestion
say "3/6 ingest everything that now has a document URL"
$V ingest_backlog.py --delay 3 || echo "  (ingest ended early)"

if [ "$(date +%s)" -lt "$DEADLINE" ]; then
  say "4/6 second pass — transient timeouts often succeed on a retry"
  $V crawl_register_documents.py --apply || true
  $V ingest_backlog.py --delay 3 || true
else
  say "4/6 skipped — past the deadline, going straight to the rebuild"
fi

say "after ingestion"; counts

# ------------------------------------------------------- derived layers, once
say "5/6 clauses, semantics, amendments"
$V extract_clauses.py --apply     || echo "  (clauses failed)"
$V backfill_semantics.py          || echo "  (semantics failed)"
$V backfill_amendments.py --apply || echo "  (amendments failed)"

say "6/6 applicability, compliance, embeddings"
# reclassify BEFORE materialise: it writes the addressee role that the verdict
# engine counts, and a verdict computed before it would ignore every new rule.
$V reclassify_applicability.py            || echo "  (reclassify failed)"
$V materialise_applicability.py --apply   || echo "  (applicability failed)"
$V derive_compliance.py --apply           || echo "  (compliance failed)"
$V materialise_cri.py --apply             || echo "  (instances failed)"
$V wire_control_requirements.py --apply   || echo "  (control mappings failed)"
$V migrate_compliance_chain.py --apply    || echo "  (evidence/assessments failed)"
$V -c "from regulatory_ingestion import rag; print(rag.index())" || echo "  (indexing failed)"

say "finished"; counts
$V - <<'PY'
from regulatory_ingestion.db import connect
print("    verdicts:")
for v, n in connect().execute(
    """SELECT coalesce(applicability,'(no rules)'), COUNT(*) FROM regulations
        GROUP BY 1 ORDER BY 2 DESC"""):
    print(f"      {v:20} {n:,}")
PY
