#!/bin/bash
# Full coverage run: every regulation with a document URL and no document,
# then the same derived layers the original 648 went through, then the index.
# Each stage prints; a stage failure stops the chain so nothing downstream
# runs on half-written data.
set -e
set -a; . /etc/company-brain/env; set +a
export PYTHONPATH=/srv/company-brain/scraper TRACE_SINKS= TOKENIZERS_PARALLELISM=false
cd /srv/company-brain/scraper
V=/srv/company-brain/.venv/bin/python
echo "== ingest backlog ==";            $V ingest_backlog.py --delay 3
echo "== clauses ==";                   $V extract_clauses.py --apply
echo "== semantics ==";                 $V backfill_semantics.py
echo "== amendments ==";               $V backfill_amendments.py --apply
echo "== applicability ==";             $V materialise_applicability.py --apply
echo "== compliance ==";                $V derive_compliance.py --apply
echo "== requirement instances ==";     $V materialise_cri.py --apply
# requirements are rebuilt above, and control_requirements FK-cascades on
# requirement_id — so the requirement→control→evidence→assessment tail must be
# rebuilt in the same chain or it is silently lost on every run.
echo "== control mappings ==";           $V wire_control_requirements.py --apply
echo "== evidence + assessments ==";     $V migrate_compliance_chain.py --apply
echo "== rag index ==";                 $V -c "from regulatory_ingestion import rag; print(rag.index())"
echo "== rag eval ==";                  $V rag_eval.py run --tag post-backlog --multigold
echo "== done =="
