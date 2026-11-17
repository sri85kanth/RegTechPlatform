#!/bin/bash
# Hard-link every fully arrived TeamLease PDF into the pipeline's document store.
# "Fully arrived" = size on disk equals the byte count recorded in the manifest.
# Run as root (the upload lands in /root). Safe to re-run; --follow loops.
SRC=/root/TeamLeasePDFs
DST=/srv/company-brain/scraper/output/documents
MAN=/srv/company-brain/scraper/input/teamlease_manifest.csv
LIMIT=${LIMIT:-0}

link_pass() {
  /srv/company-brain/.venv/bin/python - "$SRC" "$DST" "$MAN" "$LIMIT" <<'EOF'
import csv, os, sys
src, dst, man, limit = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
linked = waiting = have = 0
for d in csv.DictReader(open(man, encoding="utf-8-sig")):
    target = os.path.join(dst, d["id"] + ".pdf")
    if os.path.exists(target):
        have += 1
        continue
    if limit and linked + have >= limit:
        continue
    p = os.path.join(src, d["rel_path"])
    try:
        if os.path.getsize(p) != int(d["bytes"]):
            waiting += 1
            continue
    except OSError:
        waiting += 1
        continue
    os.chmod(p, 0o644)
    os.link(p, target)
    linked += 1
print(f"linked {linked}, already {have}, still arriving {waiting}", flush=True)
print("DONE" if waiting == 0 else "", flush=True)
EOF
}

if [ "$1" = "--follow" ]; then
  while true; do
    out=$(link_pass); echo "$(date -Is) $out" | head -1
    echo "$out" | grep -q DONE && break
    sleep 60
  done
else
  link_pass
fi
