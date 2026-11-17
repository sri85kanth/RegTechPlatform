#!/bin/bash
# Bring up self-hosted Langfuse on the VPS and hand its API keys to the agent.
#   sudo ./deploy/langfuse/setup-langfuse.sh
# Re-runnable: an existing .env is kept (rotating the secrets would orphan the data).
set -euo pipefail
D=/srv/company-brain/deploy/langfuse
ENVF=/etc/company-brain/env
cd "$D"
rand() { openssl rand -hex "$1"; }
if [ ! -f .env ]; then
  PUB="pk-lf-$(rand 16)"; SEC="sk-lf-$(rand 16)"; ADMINPW="$(rand 12)"
  {
    echo "NEXTAUTH_URL=http://127.0.0.1:3000"
    echo "TELEMETRY_ENABLED=false"
    echo "LANGFUSE_INIT_ORG_ID=company-brain"
    echo "LANGFUSE_INIT_ORG_NAME=Company Brain"
    echo "LANGFUSE_INIT_PROJECT_ID=impact-agent"
    echo "LANGFUSE_INIT_PROJECT_NAME=Impact agent"
    echo "LANGFUSE_INIT_PROJECT_PUBLIC_KEY=$PUB"
    echo "LANGFUSE_INIT_PROJECT_SECRET_KEY=$SEC"
    echo "LANGFUSE_INIT_USER_EMAIL=admin@company.example"
    echo "LANGFUSE_INIT_USER_NAME=Admin"
    echo "LANGFUSE_INIT_USER_PASSWORD=$ADMINPW"
    # every secret the upstream compose file would otherwise default to a public placeholder
    for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY CLICKHOUSE_PASSWORD ENCRYPTION_KEY MINIO_ROOT_PASSWORD NEXTAUTH_SECRET POSTGRES_PASSWORD SALT; do
      case "$v" in
        ENCRYPTION_KEY) echo "$v=$(rand 32)";;                  # must be 64 hex chars
        *AWS_ACCESS_KEY_ID*|*ACCESS_KEY_ID) echo "$v=minio";;   # MinIO root user
        *) echo "$v=$(rand 24)";;
      esac
    done
  } > .env
  # MinIO: compose reads LANGFUSE_S3_{EVENT_UPLOAD,MEDIA_UPLOAD,BATCH_EXPORT}_SECRET_ACCESS_KEY
  # (each defaulting to the public "miniosecret"), not AWS_SECRET_ACCESS_KEY. Every one of them
  # must equal the MinIO root password or web logs SignatureDoesNotMatch and no trace is stored.
  MP=$(grep '^MINIO_ROOT_PASSWORD=' .env | cut -d= -f2)
  for v in $(grep -oE '\$\{[A-Z0-9_]*SECRET_ACCESS_KEY' docker-compose.yml | tr -d '${' | sort -u); do
    if grep -q "^$v=" .env; then sed -i -E "s/^($v)=.*/\1=$MP/" .env; else echo "$v=$MP" >> .env; fi
  done
  # The upstream file hard-codes DATABASE_URL's password as "postgres" while
  # POSTGRES_PASSWORD is randomised above — the two must agree or web and worker
  # crash-loop on P1000. Redis likewise: one randomised secret used on both sides.
  PP=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2)
  echo "DATABASE_URL=postgresql://postgres:$PP@postgres:5432/postgres" >> .env
  echo "REDIS_AUTH=$(rand 24)" >> .env
  chmod 600 .env
  install -m 600 /dev/stdin /etc/company-brain/langfuse-admin.txt <<CRED
Langfuse admin (self-hosted, loopback only — tunnel: ssh -L 3000:127.0.0.1:3000 root@187.77.188.114)
url      http://localhost:3000
email    admin@company.example
password $ADMINPW
CRED
  echo "  wrote $D/.env and /etc/company-brain/langfuse-admin.txt"
fi
PUB=$(grep '^LANGFUSE_INIT_PROJECT_PUBLIC_KEY=' .env | head -1 | cut -d= -f2); SEC=$(grep '^LANGFUSE_INIT_PROJECT_SECRET_KEY=' .env | head -1 | cut -d= -f2)
grep -q '^LANGFUSE_PUBLIC_KEY=' "$ENVF" || cat >> "$ENVF" <<APP

# Langfuse (self-hosted, production trace sink) — see deploy/langfuse/
LANGFUSE_HOST=http://127.0.0.1:3000
LANGFUSE_PUBLIC_KEY=$PUB
LANGFUSE_SECRET_KEY=$SEC
TRACE_SINKS=langfuse
APP
echo "  agent env: LANGFUSE_* + TRACE_SINKS present in $ENVF"
docker compose pull -q
docker compose up -d
echo "  waiting for langfuse-web health…"
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3000/api/public/health >/dev/null 2>&1; then echo "  healthy after ~$((i*5))s"; break; fi
  sleep 5
done
docker compose ps --format "table {{.Service}}\t{{.Status}}" | sed "s/^/  /"
