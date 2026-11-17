#!/usr/bin/env bash
# Company Brain — third-party dependency install for Debian.
#
# Everything the app needs that does not come from this repo: system packages,
# PostgreSQL 16 with pgvector, and the Python tiers.
#
# It does NOT create databases, restore data, or start services — that is
# DEPLOY.md §3 onward. This script only installs.
#
#   chmod +x deploy/install-debian.sh
#   ./deploy/install-debian.sh            # core only
#   ./deploy/install-debian.sh --rag      # + semantic search (~3 GB)
#   ./deploy/install-debian.sh --scrape   # + crawler and docling
#   ./deploy/install-debian.sh --all
#
# Safe to re-run: apt and pip both skip what is already present.

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/company-brain}"
PG_VERSION="${PG_VERSION:-16}"
WANT_RAG=0; WANT_SCRAPE=0
for a in "$@"; do
  case "$a" in
    --rag) WANT_RAG=1 ;;
    --scrape) WANT_SCRAPE=1 ;;
    --all) WANT_RAG=1; WANT_SCRAPE=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 0. identify
. /etc/os-release
say "Debian ${VERSION_ID:-?} (${VERSION_CODENAME:-unknown}) on $(uname -m)"
[ "${ID:-}" = "debian" ] || echo "WARNING: ID=$ID, not debian — continuing anyway"

export DEBIAN_FRONTEND=noninteractive

# ------------------------------------------------------------ 1. base system
say "Base tools"
sudo -E apt-get update
sudo -E apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git rsync

# --------------------------------------------------------- 2. python toolchain
# Debian's python3 is fine: bookworm ships 3.11, trixie 3.13. Both have wheels
# for every pin in requirements.txt. Do not chase 3.14 — torch has none.
say "Python $(python3 -V 2>&1 | cut -d' ' -f2) + build toolchain"
sudo -E apt-get install -y --no-install-recommends \
  python3 python3-venv python3-dev python3-pip build-essential pkg-config

# ------------------------------------------------------------- 3. postgresql
# Use the cluster that is already here if there is one. Installing a different
# major version alongside it would start a SECOND cluster on 5433, and the
# socket DSN would keep reaching the old one — the app would then show empty
# tables rather than fail, which is the worst kind of wrong.
EXISTING_PG="$(pg_lsclusters -h 2>/dev/null | awk '$4=="online"{print $1; exit}')"

if [ -n "$EXISTING_PG" ]; then
  PG_VERSION="$EXISTING_PG"
  say "PostgreSQL ${PG_VERSION} already running — using it, not installing another"
  pg_lsclusters
else
  say "No cluster found — installing PostgreSQL ${PG_VERSION} from PGDG"
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  sudo -E apt-get update
  sudo -E apt-get install -y "postgresql-${PG_VERSION}" "postgresql-client-${PG_VERSION}"
fi

# pgvector must match the cluster's major version. Debian trixie carries 0.8.0
# for PG 17 in its own repos; fall back to PGDG only if the package is missing.
say "pgvector for PostgreSQL ${PG_VERSION}"
if apt-cache policy "postgresql-${PG_VERSION}-pgvector" 2>/dev/null | grep -q 'Candidate: [0-9]'; then
  sudo -E apt-get install -y "postgresql-${PG_VERSION}-pgvector"
else
  echo "not in the configured repos — adding PGDG for it"
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  sudo -E apt-get update
  sudo -E apt-get install -y "postgresql-${PG_VERSION}-pgvector"
fi

# ------------------------------------------------------- 4. pdf and ocr tools
# poppler-utils gives pdftoppm, which visual_rag.py checks for by name.
# tesseract is the OCR fallback when extracted text is under 400 characters.
say "PDF and OCR tools"
sudo -E apt-get install -y --no-install-recommends \
  poppler-utils tesseract-ocr tesseract-ocr-eng

# ----------------------------------------------------------- 5. web front end
say "nginx + certbot"
sudo -E apt-get install -y --no-install-recommends \
  nginx certbot python3-certbot-nginx

# ------------------------------------------------------------- 6. python venv
[ -d "$APP_DIR/scraper" ] || {
  echo "ERROR: $APP_DIR/scraper not found. Put the repo at $APP_DIR first"
  echo "       (or re-run with APP_DIR=/path/to/repo)"; exit 1; }

# /usr/bin/python3 explicitly, never bare `python3`: if root has pyenv (or
# conda) on PATH, the venv is built against an interpreter under /root, which
# is mode 700 — the service user then cannot exec it and systemd fails with a
# bare 203/EXEC that says nothing about why.
SYS_PY=/usr/bin/python3
say "Virtualenv at $APP_DIR/.venv using $SYS_PY ($($SYS_PY -V 2>&1))"
cd "$APP_DIR"
if [ -d .venv ] && ! .venv/bin/python -c '' 2>/dev/null; then
  echo "existing venv has an unusable interpreter — rebuilding"
  rm -rf .venv
fi
[ -d .venv ] || "$SYS_PY" -m venv .venv
./.venv/bin/pip install -q -U pip wheel setuptools

say "Core Python requirements"
./.venv/bin/pip install -r scraper/requirements.txt

if [ "$WANT_RAG" = 1 ]; then
  # The CPU wheel first and on its own: the default index pulls the CUDA build,
  # which is ~2.5 GB of libraries a normal VPS cannot use.
  say "Semantic search tier (CPU torch)"
  ./.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
  ./.venv/bin/pip install sentence-transformers==6.0.0 numpy==2.5.2
fi

if [ "$WANT_SCRAPE" = 1 ]; then
  say "Crawler tier"
  ./.venv/bin/pip install -r scraper/requirements-scrape.txt
  ./.venv/bin/playwright install --with-deps chromium
fi

# ----------------------------------------------------------------- 7. verify
say "Verifying"
./.venv/bin/python - <<'PY'
import importlib.util as u
core = ["fastapi","uvicorn","psycopg","pgvector","dotenv","cryptography",
        "httpx","requests","pypdf","bs4"]
missing = [m for m in core if u.find_spec(m) is None]
print("core python  :", "OK — all present" if not missing else f"MISSING {missing}")
for name, mod in (("semantic search","sentence_transformers"), ("crawler","crawl4ai")):
    print(f"{name:13}:", "installed" if u.find_spec(mod) else "not installed (optional)")
PY

for b in psql pdftoppm tesseract nginx certbot; do
  printf '%-13s: %s\n' "$b" "$(command -v "$b" || echo 'MISSING')"
done
psql --version
echo
echo "pgvector available to the server:"
sudo -u postgres psql -tAc \
  "select name, default_version from pg_available_extensions where name='vector'" \
  2>/dev/null || echo "  (could not query — is the cluster running?)"

say "Install complete. Next: DEPLOY.md §3 (create and restore the databases)."
