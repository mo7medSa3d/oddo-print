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

if ! [[ "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "ERROR: SERVER_PUBLIC_IP must be an IPv4 address (got $PUBLIC_IP)."
  exit 1
fi
IFS='.' read -r oct1 oct2 oct3 oct4 <<< "$PUBLIC_IP"
for octet in "$oct1" "$oct2" "$oct3" "$oct4"; do
  if (( 10#$octet > 255 )); then
    echo "ERROR: SERVER_PUBLIC_IP contains an invalid IPv4 octet."
    exit 1
  fi
done

# IMPORTANT for Azure and other public-NAT hosts:
# the public IP is not normally a local guest interface address. Caddy must
# listen on a local bind address (0.0.0.0 on the real server), while the
# public IP is used only as the client-facing Host/origin. In CI, where the
# public IP is loopback, keep the binding local to 127.0.0.1.
if [[ -n "${HTTP_TEST_BIND_IP_OVERRIDE:-}" ]]; then
  HTTP_TEST_BIND_IP="$HTTP_TEST_BIND_IP_OVERRIDE"
elif [[ "$PUBLIC_IP" == "127.0.0.1" ]]; then
  HTTP_TEST_BIND_IP="127.0.0.1"
else
  HTTP_TEST_BIND_IP="0.0.0.0"
fi
HTTP_TEST_HOST="$PUBLIC_IP"
APP_BASE_URL="http://$PUBLIC_IP"
if [[ "$HTTP_TEST_PORT" != "80" ]]; then
  APP_BASE_URL="$APP_BASE_URL:$HTTP_TEST_PORT"
fi

cat > "$ENV_FILE" <<EOF
POSTGRES_DB=yaseir_http_test
POSTGRES_USER=yaseir_test
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
GATEWAY_JWT_SECRET=$GATEWAY_JWT_SECRET
TRUST_PROXY_SECRET=$TRUST_PROXY_SECRET
PLATFORM_TENANT_ID=http-test-platform
MANAGER_USERNAME=http-test-admin
MANAGER_PASSWORD_HASH=unused-in-http-test-mode
COOKIE_SECURE=0
TRUST_PROXY=1
YASEIR_HTTP_TEST_MODE=1
HTTP_TEST_BIND_IP=$HTTP_TEST_BIND_IP
HTTP_TEST_HOST=$HTTP_TEST_HOST
HTTP_TEST_PORT=$HTTP_TEST_PORT
APP_BASE_URL=$APP_BASE_URL
STRIPE_PLAN_CATALOG='[{"id":"http-test","name":"HTTP Test","priceId":"price_http_test_yaseir","currency":"usd","interval":"month","entitlements":{"max_agents":5,"max_printers":10,"max_jobs_per_minute":60,"max_concurrent_jobs":8,"max_prints_per_period":"unlimited"}}]'
EOF
chmod 600 "$ENV_FILE"

: > "$TEST_DATA_DIR/verification-email.txt"

if ! docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml up -d --build; then
  echo
  echo "ERROR: HTTP test Gateway stack failed to start."
  echo "Gateway container status:"
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml ps || true
  echo
  echo "Gateway startup logs:"
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml logs --no-color --tail=200 gateway || true
  echo
  echo "Migration logs:"
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml logs --no-color --tail=100 migrate || true
  exit 1
fi

LOCAL_BASE_URL="http://127.0.0.1:$HTTP_TEST_PORT"

# Caddy routes only requests carrying the configured public Host. On Azure/NAT,
# keep the TCP connection local but send the same Host header clients use.
CADDY_HOST_ARGS=( -H "Host: $HTTP_TEST_HOST" )

echo "Waiting for Gateway..."
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "${CADDY_HOST_ARGS[@]}" "$LOCAL_BASE_URL/api/live" >/dev/null; then
    break
  fi
  sleep 2
done

if ! curl -fsS --max-time 10 "${CADDY_HOST_ARGS[@]}" "$LOCAL_BASE_URL/api/live" >/dev/null; then
  echo "ERROR: Gateway /api/live is not reachable after startup."
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml ps || true
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml logs --no-color --tail=200 gateway || true
  exit 1
fi
if ! curl -fsS --max-time 10 "${CADDY_HOST_ARGS[@]}" "$LOCAL_BASE_URL/api/health" >/dev/null; then
  echo "ERROR: Gateway /api/health is not ready."
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml ps || true
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml logs --no-color --tail=200 gateway || true
  exit 1
fi

# Verify Caddy Host routing locally before any browser/Odoo/Agent testing.
# This catches bind/Host-matcher mistakes while everything is still on-server.
if ! curl -fsS --max-time 10 -H "Host: $HTTP_TEST_HOST" "$LOCAL_BASE_URL/api/live" >/dev/null; then
  echo "ERROR: Caddy Host routing failed for configured server IP $HTTP_TEST_HOST."
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml ps || true
  docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml logs --no-color --tail=120 caddy gateway || true
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml run --rm gateway npm run db:provision-plans

echo
echo "Yaseir HTTP test environment is READY."
echo "Local health: $LOCAL_BASE_URL"
echo "Bind:        $HTTP_TEST_BIND_IP"
echo "Public host: $HTTP_TEST_HOST"
echo "Gateway:     $APP_BASE_URL"
echo "Signup:  $APP_BASE_URL/signup"
echo "Login:   $APP_BASE_URL/login"
echo "Capture: $TEST_DATA_DIR/verification-email.txt"
echo
echo "Run the full auth smoke:"
echo "  bash deploy/http-test/smoke-http-test.sh"
echo
echo "For the Windows Agent:"
echo '  powershell -ExecutionPolicy Bypass -File .\deploy\http-test\windows-agent-http-test.ps1 -ServerUrl "'"$APP_BASE_URL"'" -PairingCode "<PAIRING_CODE>"'
