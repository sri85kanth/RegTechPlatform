#!/bin/bash
# Hard-link fully arrived hospital PDFs into the pipeline's document store.
# "Fully arrived" = size on disk equals the byte count in the manifest.
# Run as root (the upload lands in /root); safe to re-run.
SRC=/root/HospitalAuthorityPDFs
DST=/srv/company-brain/scraper/output/documents
MAN=/srv/company-brain/scraper/input/hospital_manifest.csv

/srv/company-brain/.venv/bin/python - "$SRC" "$DST" "$MAN" <<'EOF'
import csv, os, sys
src, dst, man = sys.argv[1:4]
linked = have = waiting = 0
for d in csv.DictReader(open(man, encoding="utf-8-sig")):
    target = os.path.join(dst, d["id"] + ".pdf")
    if os.path.exists(target):
        have += 1
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
print(f"linked {linked}, already {have}, still arriving {waiting}")
EOF
