#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/deploy/http-test/.env.http-test"
TEST_DATA_DIR="$ROOT_DIR/deploy/http-test/test-data"

# The deployment directory may have been created by an administrator/root during first setup.
# Repair only the test deployment tree when it is root-owned so the invoking user can
# create runtime artifacts such as the captured verification email.
if [[ ! -w "$ROOT_DIR" && "$(stat -c '%u' "$ROOT_DIR" 2>/dev/null || echo -1)" == "0" ]]; then
  sudo chown -R "$(id -u):$(id -g)" "$ROOT_DIR"
fi

command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker is required."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose v2 is required."; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl is required."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required."; exit 1; }
command -v ss >/dev/null 2>&1 || { echo "ERROR: ss (iproute2) is required for test-port detection."; exit 1; }

mkdir -p "$TEST_DATA_DIR"

# Recreate only this isolated HTTP test stack on reruns. This releases its
# previous Caddy port before the free-port check while preserving the named
# PostgreSQL volume and generated secrets.
if [[ -f "$ENV_FILE" ]]; then
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml down --remove-orphans >/dev/null 2>&1 || true
fi

if [[ -n "${SERVER_PUBLIC_IP:-}" ]]; then
  PUBLIC_IP="$SERVER_PUBLIC_IP"
else
  PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)"
fi
if [[ -z "$PUBLIC_IP" ]]; then
  echo "ERROR: Could not detect the server public IPv4 address."
  echo "Run again with SERVER_PUBLIC_IP=<server-ip>."
  exit 1
fi

EXPLICIT_HTTP_TEST_PORT="${HTTP_TEST_PORT:-}"
HTTP_TEST_PORT="$EXPLICIT_HTTP_TEST_PORT"

port_is_free() {
  ! ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "(^|:|\\])${1}$"
}

if [[ -n "$EXPLICIT_HTTP_TEST_PORT" ]]; then
  if ! port_is_free "$EXPLICIT_HTTP_TEST_PORT"; then
    echo "ERROR: HTTP_TEST_PORT=$EXPLICIT_HTTP_TEST_PORT is already in use."
    exit 1
  fi
elif [[ -f "$ENV_FILE" ]]; then
  saved_port="$(grep '^HTTP_TEST_PORT=' "$ENV_FILE" | cut -d= -f2- || true)"
  if [[ -n "$saved_port" ]] && port_is_free "$saved_port"; then
    HTTP_TEST_PORT="$saved_port"
  fi
fi

if [[ -z "$HTTP_TEST_PORT" ]]; then
  for candidate in 80 8080 18080; do
    if port_is_free "$candidate"; then
      HTTP_TEST_PORT="$candidate"
      break
    fi
  done
fi
if [[ -z "$HTTP_TEST_PORT" ]]; then
  echo "ERROR: No free test HTTP port found (checked 80, 8080, 18080)."
  echo "Run again with HTTP_TEST_PORT=<free-port>."
  exit 1
fi
if ! [[ "$HTTP_TEST_PORT" =~ ^[0-9]+$ ]] || (( HTTP_TEST_PORT < 1 || HTTP_TEST_PORT > 65535 )); then
  echo "ERROR: HTTP_TEST_PORT must be a valid TCP port (1-65535)."
  exit 1
fi
if [[ -z "$HTTP_TEST_PORT" ]]; then
  echo "ERROR: No free test HTTP port found (checked 80, 8080, 18080)."
  echo "Run again with HTTP_TEST_PORT=<free-port>."
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  # Preserve generated database/signing secrets across restarts.
  POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
  GATEWAY_JWT_SECRET="$(grep '^GATEWAY_JWT_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
  TRUST_PROXY_SECRET="$(grep '^TRUST_PROXY_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
else
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  GATEWAY_JWT_SECRET="$(openssl rand -hex 32)"
  TRUST_PROXY_SECRET="$(openssl rand -hex 32)"
fi

if [[ -z "$POSTGRES_PASSWORD" || -z "$GATEWAY_JWT_SECRET" || -z "$TRUST_PROXY_SECRET" ]]; then
  echo "ERROR: Generated test secrets are empty."
  exit 1
fi

APP_BASE_URL="http://$PUBLIC_IP"
if [[ "$HTTP_TEST_PORT" != "80" ]]; then
  APP_BASE_URL="$APP_BASE_URL:$HTTP_TEST_PORT"
fi

cat > "$ENV_FILE" <<EOF
POSTGRES_DB=yasser_http_test
POSTGRES_USER=yasser_test
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
GATEWAY_JWT_SECRET=$GATEWAY_JWT_SECRET
TRUST_PROXY_SECRET=$TRUST_PROXY_SECRET
MANAGER_USERNAME=http-test-admin
MANAGER_PASSWORD_HASH=unused-in-http-test-mode
COOKIE_SECURE=0
TRUST_PROXY=1
YASSER_HTTP_TEST_MODE=1
HTTP_TEST_PORT=$HTTP_TEST_PORT
APP_BASE_URL=$APP_BASE_URL
STRIPE_PLAN_CATALOG='[{"id":"http-test","name":"HTTP Test","priceId":"price_http_test_yasser","currency":"usd","interval":"month","entitlements":{"max_agents":5,"max_printers":10,"max_jobs_per_minute":60,"max_concurrent_jobs":8}}]'
EOF
chmod 600 "$ENV_FILE"

: > "$TEST_DATA_DIR/verification-email.txt"

docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml up -d --build

LOCAL_BASE_URL="http://127.0.0.1:$HTTP_TEST_PORT"

echo "Waiting for Gateway..."
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "$LOCAL_BASE_URL/api/live" >/dev/null; then
    break
  fi
  sleep 2
done

curl -fsS --max-time 10 "$LOCAL_BASE_URL/api/live" >/dev/null
curl -fsS --max-time 10 "$LOCAL_BASE_URL/api/health" >/dev/null

docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml run --rm gateway npm run db:provision-plans

echo
echo "Yasser HTTP test environment is READY."
echo "Local health: $LOCAL_BASE_URL"
echo "Gateway: $APP_BASE_URL"
echo "Signup:  $APP_BASE_URL/signup"
echo "Login:   $APP_BASE_URL/login"
echo "Capture: $TEST_DATA_DIR/verification-email.txt"
echo
echo "Run the full auth smoke:"
echo "  bash deploy/http-test/smoke-http-test.sh"
echo
echo "For the Windows Agent:"
echo '  powershell -ExecutionPolicy Bypass -File .\deploy\http-test\windows-agent-http-test.ps1 -ServerUrl "'"$APP_BASE_URL"'" -PairingCode "<PAIRING_CODE>"'
