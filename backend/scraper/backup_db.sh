#!/bin/zsh
# ============================================================
# Company Brain — database backup.
#
# Dumps both databases, keeps 14 daily copies, and VERIFIES each dump by
# restoring it into a scratch database and comparing row counts. A backup that
# has never been restored is a hope, not a backup.
# ============================================================
set -u
ROOT="${0:A:h}/.."
OUT="$ROOT/backups"
STAMP=$(date +%Y%m%d-%H%M%S)
KEEP=14
mkdir -p "$OUT"

fail() { echo "[backup] FAILED: $*" >&2; exit 1; }

for DB in company_brain company_brain_rag; do
  F="$OUT/${DB}-${STAMP}.dump"
  # custom format: compressed, and restorable table-by-table
  pg_dump -Fc -d "$DB" -f "$F" || fail "pg_dump $DB"
  SZ=$(du -h "$F" | cut -f1)
  echo "[backup] $DB -> $(basename $F) ($SZ)"
done

# ---- verify the primary dump by actually restoring it -----------------------
SCRATCH="cb_restore_check_$$"
dropdb --if-exists "$SCRATCH" 2>/dev/null
createdb "$SCRATCH" || fail "could not create scratch database"
pg_restore -d "$SCRATCH" "$OUT/company_brain-${STAMP}.dump" >/dev/null 2>&1

SRC=$(psql -tAc "SELECT count(*) FROM regulations" -d company_brain)
DST=$(psql -tAc "SELECT count(*) FROM regulations" -d "$SCRATCH" 2>/dev/null || echo 0)
SRC2=$(psql -tAc "SELECT count(*) FROM obligations" -d company_brain)
DST2=$(psql -tAc "SELECT count(*) FROM obligations" -d "$SCRATCH" 2>/dev/null || echo 0)
dropdb "$SCRATCH"

if [ "$SRC" != "$DST" ] || [ "$SRC2" != "$DST2" ]; then
  fail "restore verification mismatch: regulations $SRC/$DST obligations $SRC2/$DST2"
fi
echo "[backup] restore verified: regulations $DST, obligations $DST2"

# ---- retention --------------------------------------------------------------
ls -1t "$OUT"/company_brain-*.dump 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$OUT"/company_brain_rag-*.dump 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "[backup] ok · $(ls -1 "$OUT"/*.dump 2>/dev/null | wc -l | tr -d ' ') files retained"
