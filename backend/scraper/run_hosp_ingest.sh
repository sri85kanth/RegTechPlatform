#!/bin/bash
# Ingest the hospital regulations whose document URLs the register crawl
# verified, then rebuild every layer that depends on them.
#
# Run it detached — it is long, and an SSH session is not a place to keep work:
#   systemd-run --unit=cb-hosp --collect /srv/company-brain/scraper/run_hosp_ingest.sh
#   journalctl -u cb-hosp -f
#
# PYTHONUNBUFFERED matters more than it looks. Without it Python block-buffers
# stdout whenever it is not a terminal, so a job redirected to a file shows an
# empty log for hours and reads as dead when it is only quiet. That cost a
# whole diagnosis once already.
set -e
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python

# The target list comes from the database, not from a list pasted into this
# file: whatever the crawler verifies next is picked up without editing this,
# and anything already ingested is skipped, so re-running is cheap and safe.
IDS=$($V - <<'PY'
from regulatory_ingestion.db import connect
rows = connect().execute(
    """SELECT id FROM regulations g
        WHERE id LIKE 'hosp-%'
          AND official_document_url LIKE 'http%'
          AND coalesce(ingestion_status,'') <> 'OCR_REQUIRED'
          AND (
                NOT EXISTS (SELECT 1 FROM documents d WHERE d.regulation_id = g.id)
             -- A run killed part-way leaves the document row written and the
             -- status short of MAPPED. "Has a document" is not "was ingested",
             -- and skipping those silently strands them: hosp-061 was stopped
             -- inside the matcher and would never have been picked up again.
             OR coalesce(ingestion_status,'') <> 'MAPPED'
          )
        ORDER BY id""").fetchall()
print(" ".join(r[0] for r in rows))
PY
)

# Without this guard an empty list would fall through to `--ids` with no
# values, which ingest_backlog reads as "no ids given" and answers with the
# entire 1,100-regulation backlog. Not what "run the hospital ones" means.
if [ -z "$IDS" ]; then
  echo "== no hospital regulation is waiting for a document — nothing to ingest =="
else
  echo "== ingest hospital documents =="
  echo "   targets: $(echo "$IDS" | wc -w)"
  $V ingest_backlog.py --delay 2 --ids $IDS
fi

echo "== clauses ==";                 $V extract_clauses.py --apply
echo "== semantics ==";               $V backfill_semantics.py
echo "== amendments ==";              $V backfill_amendments.py --apply
# Applicability needs company facts, and "no profile yet" is a legitimate
# state, not a failed ingestion — under `set -e` it would otherwise stop the
# chain and take the compliance tail down with it.
if $V -c "
from regulatory_ingestion.db import connect
raise SystemExit(0 if connect().execute('SELECT COUNT(*) FROM company_profile').fetchone()[0] else 1)
"; then
  echo "== applicability ==";         $V materialise_applicability.py --apply
else
  echo "== applicability SKIPPED — no company profile, so there are no facts to evaluate against =="
fi
echo "== compliance ==";              $V derive_compliance.py --apply
echo "== requirement instances ==";   $V materialise_cri.py --apply
# control_requirements FK-cascades on requirement_id, and the line above
# rebuilds requirements — so the control→evidence→assessment tail has to be
# rebuilt here or it is silently lost every time this runs.
echo "== control mappings ==";        $V wire_control_requirements.py --apply
echo "== evidence + assessments ==";  $V migrate_compliance_chain.py --apply
echo "== rag index ==";               $V -c "from regulatory_ingestion import rag; print(rag.index())"
echo "== done =="
