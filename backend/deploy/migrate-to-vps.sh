#!/usr/bin/env bash
# Company Brain — move the data to the VPS.
#
# Run this ON YOUR LAPTOP. It streams both database dumps over SSH without
# writing them to local disk (you have ~900 MB free and the dumps are up to
# 636 MB), then rsyncs the PDFs, restores, and verifies row counts on both ends.
#
#   ./deploy/migrate-to-vps.sh
#
# Re-runnable. The rsync resumes; the restores are the only destructive part
# and they refuse to run unless the target databases are empty (pass --force to
# drop and recreate them).

set -euo pipefail

VPS="${VPS:-187.77.188.114}"
SSH_USER="${SSH_USER:-root}"
APP_DIR="${APP_DIR:-/srv/company-brain}"
DB_ROLE="${DB_ROLE:-brain}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

R="ssh ${SSH_USER}@${VPS}"
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "Checking the link to ${VPS}"
$R "echo connected as \$(whoami) on \$(hostname); free -m | awk 'NR==2{print \"RAM \" \$2 \" MB\"}'; df -h / | tail -1"

# The PDFs must outlive a failed restore, so they go first and independently.
say "Copying 649 documents (461 MB) — resumable"
$R "mkdir -p ${APP_DIR}/scraper/output/documents"
rsync -aP --stats \
  "${SRC}/scraper/output/documents/" \
  "${SSH_USER}@${VPS}:${APP_DIR}/scraper/output/documents/"
# no -z: PDFs are already compressed, so it only burns CPU

say "Preparing roles, databases and extensions"
$R "sudo -u postgres psql -tAc \"select 1 from pg_roles where rolname='${DB_ROLE}'\" | grep -q 1 \
     || sudo -u postgres createuser --login ${DB_ROLE}"
for db in company_brain company_brain_rag; do
  exists=$($R "sudo -u postgres psql -tAc \"select 1 from pg_database where datname='${db}'\"")
  if [ "$exists" = "1" ]; then
    rows=$($R "sudo -u postgres psql -d ${db} -tAc \"select count(*) from information_schema.tables where table_schema='public'\"" || echo 0)
    if [ "${rows:-0}" -gt 0 ] && [ "$FORCE" = 0 ]; then
      echo "ERROR: ${db} already has ${rows} tables. Re-run with --force to drop it." >&2
      exit 1
    fi
    [ "$FORCE" = 1 ] && $R "sudo -u postgres dropdb --if-exists ${db}"
  fi
  $R "sudo -u postgres psql -tAc \"select 1 from pg_database where datname='${db}'\" | grep -q 1 || sudo -u postgres createdb -O ${DB_ROLE} ${db}"
done
# Only company_brain_rag uses them; company_brain has plpgsql alone. The dump
# carries CREATE EXTENSION IF NOT EXISTS, but that needs superuser — creating
# them here first turns those statements into harmless no-ops.
$R "sudo -u postgres psql -d company_brain_rag -c 'CREATE EXTENSION IF NOT EXISTS vector;' \
 && sudo -u postgres psql -d company_brain_rag -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'"

# --no-owner: both databases are owned by the local role 'ramprasad', which does
# not exist on the VPS. Without it every COMMENT and GRANT fails.
say "Streaming company_brain (398 MB) straight into pg_restore"
pg_dump -Fc --no-owner -d company_brain \
  | $R "sudo -u postgres pg_restore --no-owner --role=${DB_ROLE} -d company_brain --no-privileges"

say "Streaming company_brain_rag (1017 MB) — the HNSW indexes rebuild on restore, this is the slow one"
pg_dump -Fc --no-owner -d company_brain_rag \
  | $R "sudo -u postgres pg_restore --no-owner --role=${DB_ROLE} -d company_brain_rag --no-privileges"

# storage_path holds absolute laptop paths on all 648 rows.
say "Rewriting document paths to ${APP_DIR}"
$R "sudo -u postgres psql -d company_brain -c \"UPDATE documents SET storage_path = replace(storage_path, '${SRC}', '${APP_DIR}') WHERE storage_path LIKE '${SRC}%'\""

say "Verifying — local vs remote"
printf '%-24s %10s %10s\n' TABLE LOCAL REMOTE
for q in "regulations" "documents" "sections" "obligations" "impact_relationships" "impact_scores" "section_changes" "company_entities" "users"; do
  l=$(psql -d company_brain -tAc "select count(*) from ${q}")
  r=$($R "sudo -u postgres psql -d company_brain -tAc 'select count(*) from ${q}'")
  flag=$([ "$l" = "$r" ] && echo "" || echo "  <-- MISMATCH")
  printf '%-24s %10s %10s%s\n' "$q" "$l" "$r" "$flag"
done
lc=$(psql -d company_brain_rag -tAc "select count(*) from chunks")
rc=$($R "sudo -u postgres psql -d company_brain_rag -tAc 'select count(*) from chunks'")
printf '%-24s %10s %10s%s\n' "chunks (rag)" "$lc" "$rc" "$([ "$lc" = "$rc" ] && echo '' || echo '  <-- MISMATCH')"
lf=$(ls -1 "${SRC}/scraper/output/documents" | wc -l | tr -d ' ')
rf=$($R "ls -1 ${APP_DIR}/scraper/output/documents | wc -l" | tr -d ' ')
printf '%-24s %10s %10s%s\n' "PDF files" "$lf" "$rf" "$([ "$lf" = "$rf" ] && echo '' || echo '  <-- MISMATCH')"

say "Migration complete. Next: DEPLOY.md §4 (environment) and §5 (systemd)."
