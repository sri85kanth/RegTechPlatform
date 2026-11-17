#!/usr/bin/env bash
# OCR a scanned PDF page by page, in parallel, into one text file with page markers.
#   ocr_pdf.sh <pdf> <out dir> [jobs]
# Writes <out>/pages/p-NNN.txt and <out>/ocr.txt ("<<<PAGE n>>>" before each page).
set -euo pipefail
PDF="$1"; OUT="$2"; JOBS="${3:-20}"
mkdir -p "$OUT/pages"
N=$(pdfinfo "$PDF" | awk '/^Pages:/{print $2}')
echo "pages: $N · jobs: $JOBS · start $(date +%T)"
ocr_page() {
  p=$1; pdf=$2; out=$3
  f=$(printf "%s/pages/p-%03d" "$out" "$p")
  [ -s "$f.txt" ] && return 0                       # resumable
  pdftoppm -r 300 -gray -f "$p" -l "$p" -png "$pdf" "$f" >/dev/null 2>&1
  img=$(ls "$f"*.png 2>/dev/null | head -1)
  OMP_THREAD_LIMIT=1 tesseract "$img" "$f" --psm 4 -l eng >/dev/null 2>&1 || true
  rm -f "$img"
}
export -f ocr_page
seq 1 "$N" | xargs -P "$JOBS" -I{} bash -c 'ocr_page "$@"' _ {} "$PDF" "$OUT"
: > "$OUT/ocr.txt"
for p in $(seq 1 "$N"); do
  printf "<<<PAGE %d>>>\n" "$p" >> "$OUT/ocr.txt"
  cat "$(printf "%s/pages/p-%03d.txt" "$OUT" "$p")" >> "$OUT/ocr.txt" 2>/dev/null || true
done
echo "done $(date +%T) · $(wc -c < "$OUT/ocr.txt") chars"
