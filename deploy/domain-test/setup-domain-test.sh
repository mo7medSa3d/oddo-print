#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
DEPLOY_DIR="$ROOT_DIR/deploy/domain-test"
ENV_FILE="$DEPLOY_DIR/.env.domain-test"
LEGACY_ENV="$ROOT_DIR/deploy/http-test/.env.http-test"
DOMAIN="${GATEWAY_DOMAIN:-print.yaseir.cloud}"

if [[ "$DOMAIN" != "print.yaseir.cloud" ]]; then
  echo "ERROR: this staging deployment is pinned to print.yaseir.cloud."
  exit 1
fi

command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker is required."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose v2 is required."; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is required."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required."; exit 1; }

get_env_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 1
  grep -m1 "^${key}=" "$file" | cut -d= -f2-
}

# Stop only the old HTTP test deployment; never delete its PostgreSQL volume.
if [[ -f "$LEGACY_ENV" ]]; then
  docker compose --env-file "$LEGACY_ENV" -f "$ROOT_DIR/deploy/http-test/docker-compose.yml" down --remove-orphans >/dev/null 2>&1 || true
fi

if command -v ss >/dev/null 2>&1; then
  for port in 80 443; do
    if ss -ltn 2>/dev/null | grep -qE "[:.]$port[[:space:]]*$"; then
      echo "ERROR: TCP port $port is already in use."
      echo "Stop the existing listener before starting domain staging."
      exit 1
    fi
  done
fi

mkdir -p "$DEPLOY_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$LEGACY_ENV" ]]; then
    cp "$LEGACY_ENV" "$ENV_FILE"
  else
    : > "$ENV_FILE"
  fi
fi

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
  else
    printf "%s=%s\n" "$key" "$value" >> "$ENV_FILE"
  fi
}

POSTGRES_PASSWORD="$(get_env_value POSTGRES_PASSWORD "$ENV_FILE" || true)"
GATEWAY_JWT_SECRET="$(get_env_value GATEWAY_JWT_SECRET "$ENV_FILE" || true)"
TRUST_PROXY_SECRET="$(get_env_value TRUST_PROXY_SECRET "$ENV_FILE" || true)"
if [[ -z "$POSTGRES_PASSWORD" ]]; then POSTGRES_PASSWORD="$(openssl rand -hex 24)"; fi
if [[ -z "$GATEWAY_JWT_SECRET" ]]; then GATEWAY_JWT_SECRET="$(openssl rand -hex 32)"; fi
if [[ -z "$TRUST_PROXY_SECRET" ]]; then TRUST_PROXY_SECRET="$(openssl rand -hex 32)"; fi

HTTP_TEST_VOLUME_NAME="$(get_env_value HTTP_TEST_VOLUME_NAME "$ENV_FILE" || true)"
if [[ -z "$HTTP_TEST_VOLUME_NAME" && -f "$LEGACY_ENV" ]]; then
  HTTP_TEST_VOLUME_NAME="$(docker volume ls -q --filter label=com.docker.compose.volume=postgres_http_test_data | head -n 1 || true)"
fi
if [[ -z "$HTTP_TEST_VOLUME_NAME" ]]; then
  for candidate in "http-test_postgres_http_test_data" "oddo-print_postgres_http_test_data" "postgres_http_test_data"; do
    if docker volume inspect "$candidate" >/dev/null 2>&1; then
      HTTP_TEST_VOLUME_NAME="$candidate"
      break
    fi
  done
fi
if [[ -z "$HTTP_TEST_VOLUME_NAME" ]] || ! docker volume inspect "$HTTP_TEST_VOLUME_NAME" >/dev/null 2>&1; then
  echo "ERROR: Could not locate the existing HTTP staging PostgreSQL volume."
  echo "Run deploy/http-test/setup-http-test.sh once before domain migration."
  exit 1
fi


upsert_env POSTGRES_DB yasser_http_test
upsert_env POSTGRES_USER yasser_test
upsert_env POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
upsert_env GATEWAY_JWT_SECRET "$GATEWAY_JWT_SECRET"
upsert_env TRUST_PROXY_SECRET "$TRUST_PROXY_SECRET"
upsert_env PLATFORM_TENANT_ID http-test-platform
upsert_env MANAGER_USERNAME http-test-admin
upsert_env MANAGER_PASSWORD_HASH unused-in-http-test-mode
upsert_env GATEWAY_DOMAIN "$DOMAIN"
upsert_env APP_BASE_URL "https://$DOMAIN"
upsert_env COOKIE_SECURE 1
upsert_env TRUST_PROXY 1
upsert_env YASEIR_HTTP_TEST_MODE 1
upsert_env HTTP_TEST_VOLUME_NAME "$HTTP_TEST_VOLUME_NAME"
upsert_env STRIPE_PLAN_CATALOG '[{"id":"http-test","name":"HTTP Test","priceId":"price_http_test_yasser","currency":"usd","interval":"month","entitlements":{"max_agents":5,"max_printers":10,"max_jobs_per_minute":60,"max_concurrent_jobs":8,"max_prints_per_period":"unlimited"}}]'
chmod 600 "$ENV_FILE"

docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" up -d --build

echo "Validating Caddy configuration..."
docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" exec -T caddy caddy validate --config /etc/caddy/Caddyfile

echo "Waiting for HTTPS Gateway..."
for _ in $(seq 1 90); do
  if curl -kfsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/live" >/dev/null 2>&1 && curl -kfsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -kfsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/live" >/dev/null; then
  echo "ERROR: HTTPS /api/live is not reachable through Caddy."
  docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" ps || true
  docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" logs --no-color --tail=200 caddy gateway || true
  exit 1
fi
if ! curl -kfsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null; then
  echo "ERROR: HTTPS /api/health is not ready."
  docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" logs --no-color --tail=200 caddy gateway || true
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/docker-compose.yml" run --rm gateway npm run db:provision-plans

echo
echo "Yaseir domain staging is READY."
echo "Gateway:    https://$DOMAIN"
echo "Signup:     https://$DOMAIN/signup"
echo "Login:      https://$DOMAIN/login"
echo "Odoo URL:   https://$DOMAIN"
echo "Agent WS:   wss://$DOMAIN/api/agent/ws"
echo "Env file:   $ENV_FILE"
