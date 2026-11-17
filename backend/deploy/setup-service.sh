#!/usr/bin/env bash
# Company Brain — service user, environment file and systemd unit.
#
# Run this ON THE VPS, after install-debian.sh and migrate-to-vps.sh.
#
#   sudo ./deploy/setup-service.sh brain.example.com
#
# Creates the Linux user the service runs as, writes /etc/company-brain/env
# with a freshly generated encryption key, installs the unit, and starts it.
# Re-runnable: it will not overwrite an existing env file (that would rotate
# CONFIG_ENCRYPTION_KEY and orphan every stored OAuth secret).

set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="${APP_DIR:-/srv/company-brain}"
ENV_DIR=/etc/company-brain
ENV_FILE="$ENV_DIR/env"
SVC_USER=brain

[ -n "$DOMAIN" ] || { echo "usage: sudo $0 <origin>   e.g. brain.example.com, or http://1.2.3.4" >&2; exit 2; }
# Accept either a bare hostname (assumed https) or a full origin. An IP with no
# certificate has to stay http, and CORS matches the origin string exactly —
# scheme included — so this cannot be guessed wrong.
case "$DOMAIN" in
  *://*) ORIGIN="$DOMAIN" ;;
  *)     ORIGIN="https://$DOMAIN" ;;
esac
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
[ -d "$APP_DIR/scraper" ] || { echo "no repo at $APP_DIR" >&2; exit 1; }

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ------------------------------------------------------- 1. the service user
# A Linux user, distinct from the PostgreSQL role of the same name created
# during migration. Matching names is what makes peer authentication work:
# the process connects over the Unix socket as brain and Postgres accepts it
# as the role brain, so no password ever has to exist in a file.
say "Service user"
id -u "$SVC_USER" >/dev/null 2>&1 \
  || adduser --system --group --home "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
id "$SVC_USER"

# -------------------------------------------------------- 2. the environment
say "Environment file"
install -d -m 750 -o root -g "$SVC_USER" "$ENV_DIR"

if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE exists — leaving it alone."
  echo "CONFIG_ENCRYPTION_KEY must never be regenerated: stored OAuth secrets"
  echo "were encrypted with it and cannot be decrypted with a new one."
else
  KEY=$("$APP_DIR/.venv/bin/python" -c \
    'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')
  cat > "$ENV_FILE" <<EOF
# Company Brain — read by systemd (EnvironmentFile) and by the cron job.
# Plain KEY=VALUE only: systemd does no shell expansion and no quotes are
# stripped, so never wrap a value in quotes here.

# Peer auth over the Unix socket as the user brain. No password anywhere.
# pgdb.py:25 and rag.py:42 default to exactly these, but set them explicitly.
COMPANY_BRAIN_DSN=postgresql:///company_brain
RAG_DSN=postgresql:///company_brain_rag

# api.py:29 defaults to localhost only. The API sends credentials, so this is
# an allowlist of exact origins — never a wildcard.
CORS_ORIGINS=${ORIGIN}
APP_BASE_URL=${ORIGIN}

# Fernet key for the OAuth client secret at rest (secret_store.py:24).
# Generated once, here. Back it up; losing it orphans stored integrations.
CONFIG_ENCRYPTION_KEY=${KEY}

SESSION_HOURS=12

# Fill these in only when you connect an integration. The redirect URI must be
# registered with the provider character for character.
#GOOGLE_CLIENT_ID=
#GOOGLE_CLIENT_SECRET=
#GOOGLE_REDIRECT_URI=${ORIGIN}/api/integrations/oauth/google/callback
#MICROSOFT_CLIENT_ID=
#MICROSOFT_CLIENT_SECRET=
#MICROSOFT_TENANT_ID=
#MICROSOFT_REDIRECT_URI=${ORIGIN}/api/integrations/oauth/microsoft/callback
EOF
  chown root:"$SVC_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "wrote $ENV_FILE"
fi

# api.py:17 also loads scraper/.env. load_dotenv does not override real
# environment variables, so systemd wins on any key it sets — but a laptop .env
# copied up would still supply localhost values for keys systemd does not set.
if [ -f "$APP_DIR/scraper/.env" ]; then
  say "Removing the .env copied from the laptop"
  grep -oE '^[A-Z_]+=' "$APP_DIR/scraper/.env" | tr -d '=' | sed 's/^/  had: /'
  mv "$APP_DIR/scraper/.env" "$APP_DIR/scraper/.env.from-laptop.bak"
  chmod 600 "$APP_DIR/scraper/.env.from-laptop.bak"
  echo "moved to .env.from-laptop.bak — copy any real OAuth values into $ENV_FILE"
fi

# --------------------------------------------------------------- 3. the unit
say "systemd unit"
cat > /etc/systemd/system/company-brain.service <<EOF
[Unit]
Description=Company Brain API
Documentation=file://${APP_DIR}/DEPLOY.md
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=exec
User=${SVC_USER}
Group=${SVC_USER}
WorkingDirectory=${APP_DIR}/scraper
EnvironmentFile=${ENV_FILE}
ExecStart=${APP_DIR}/.venv/bin/uvicorn regulatory_ingestion.api:app \\
          --host 127.0.0.1 --port 8787 --workers 2
Restart=always
RestartSec=5
TimeoutStopSec=30

# 127.0.0.1 above is deliberate: nginx is the only thing that should reach it.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
# extraction and OCR write here
ReadWritePaths=${APP_DIR}/scraper/output

[Install]
WantedBy=multi-user.target
EOF

systemd-analyze verify /etc/systemd/system/company-brain.service || true
systemctl daemon-reload
systemctl enable --now company-brain

# ------------------------------------------------------------- 4. the cron
say "Nightly watcher"
cat > /etc/cron.d/company-brain <<EOF
# Re-fetch due sources, diff them, write section_changes. 02:15 IST.
# cron does not read systemd's EnvironmentFile, so it is sourced inline —
# without this the job silently connects to the wrong database.
SHELL=/bin/bash
15 2 * * * ${SVC_USER} cd ${APP_DIR}/scraper && set -a && . ${ENV_FILE} && set +a && ${APP_DIR}/.venv/bin/python watch_sources.py >> ${APP_DIR}/scraper/output/watch.log 2>&1
EOF
chmod 644 /etc/cron.d/company-brain

# ------------------------------------------------------------- 5. verify
say "Verifying"
sleep 2
systemctl is-active company-brain && echo "service: active" || {
  echo "service failed to start — last 30 lines:"; journalctl -u company-brain -n 30 --no-pager; exit 1; }
echo
echo "clusters (a second one on 5433 means the socket DSN points at the wrong server):"
pg_lsclusters 2>/dev/null || true
echo
echo "API responds:"
curl -sS --max-time 15 localhost:8787/api/dashboard | head -c 220; echo
say "Done. Next: build the frontend with VITE_API_BASE=${ORIGIN}, then nginx."
