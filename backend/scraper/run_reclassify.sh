#!/bin/bash
# Re-derive applicability from stored section text after an ENTITY VOCABULARY
# change, then recompute the verdicts that rest on it.
#
#   systemd-run --unit=cb-reclass --collect --uid=brain --gid=brain \
#       /srv/company-brain/scraper/run_reclassify.sh
#
# Why this is a separate script and not part of run_hosp_ingest.sh: it touches
# every regulation with stored sections, not the ones just ingested. It is the
# right thing to run when APPLICABILITY_VOCAB or ENTITY_SYNONYMS changes, and
# the wrong thing to run on every document fetch.
#
# Nothing here re-downloads anything. reclassify_applicability.py reads the
# `sections` already in the database, updates each rule in place, inserts rules
# the wider vocabulary can now see, and marks a rule it cannot reproduce as
# Unknown rather than deleting it — so the audit trail of what the system
# previously believed survives, and the run can be repeated.
set -e
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python

echo "== before =="
$V - <<'PY'
from regulatory_ingestion.db import connect
con = connect()
for label, q in (
    ("applicability_rules", "SELECT COUNT(*) FROM applicability_rules"),
    ("  hospital-family terms", """SELECT COUNT(*) FROM applicability_rules
         WHERE lower(entity_type) ~ 'hospital|clinical establishment|blood|pharmac|laborator|occupier|employer|genetic'"""),
    ("verdicts stored", "SELECT COUNT(*) FROM applicability_results"),
):
    print(f"  {label:26} {con.execute(q).fetchone()[0]}")
PY

echo "== reclassify from stored text =="
$V reclassify_applicability.py

echo "== recompute verdicts =="
$V materialise_applicability.py --apply

echo "== after =="
$V - <<'PY'
from regulatory_ingestion.db import connect
con = connect()
print("  applicability_rules :", con.execute("SELECT COUNT(*) FROM applicability_rules").fetchone()[0])
print("  healthcare rules    :", con.execute("""SELECT COUNT(*) FROM applicability_rules
     WHERE lower(entity_type) ~ 'hospital|clinical establishment|blood|pharmac|laborator|occupier|employer|genetic'""").fetchone()[0])
print("  verdict distribution:")
for v, n in con.execute("""SELECT coalesce(verdict,'(null)'), COUNT(*) FROM applicability_results
                            GROUP BY 1 ORDER BY 2 DESC"""):
    print(f"    {v:20} {n}")
PY
echo "== done =="
