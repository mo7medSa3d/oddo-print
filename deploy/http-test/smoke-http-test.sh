#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/deploy/http-test/.env.http-test"
TEST_DATA="$ROOT_DIR/deploy/http-test/test-data/verification-email.txt"
COOKIE_JAR="$ROOT_DIR/deploy/http-test/test-data/cookies.txt"
MANAGER_COOKIE_JAR="$ROOT_DIR/deploy/http-test/test-data/manager-cookies.txt"
CAPTURE_FILE="/tmp/yasser-http-test-verification-email.txt"
COMPOSE_ARGS=(--env-file "$ENV_FILE" -f deploy/http-test/docker-compose.yml)
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$COOKIE_JAR" "$MANAGER_COOKIE_JAR"' EXIT

[[ -f "$ENV_FILE" ]] || { echo "ERROR: Run setup-http-test.sh first."; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker is required."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose v2 is required."; exit 1; }

set -a
source "$ENV_FILE"
set +a

BASE="${SMOKE_BASE_URL:-${APP_BASE_URL:-http://127.0.0.1:${HTTP_TEST_PORT}}}"
EMAIL="test+$(date +%s)-${BASHPID}@yasser.invalid"
json_field() {
  node -e 'const fs=require("fs"); const obj=JSON.parse(fs.readFileSync(0,"utf8")); const key=process.argv[1]; const value=obj[key]; if (value === undefined || value === null) process.exit(1); process.stdout.write(String(value));' "$1"
}
PASSWORD="Yasser-Test-2026!"
WORKSPACE="Yasser HTTP Test Workspace"

# Browser-equivalent headers are required for cookie-authenticated mutations by the production CSRF boundary.
ORIGIN="$BASE"
BROWSER_HEADERS=(-H "Origin: $ORIGIN" -H "Sec-Fetch-Site: same-origin")

rm -f "$COOKIE_JAR" "$MANAGER_COOKIE_JAR"
: > "$TEST_DATA"
docker compose "${COMPOSE_ARGS[@]}" exec -T gateway sh -c "rm -f '$CAPTURE_FILE'"

echo "[1/9] liveness/readiness"
curl -fsS --max-time 10 "$BASE/api/live" >/dev/null
curl -fsS --max-time 10 "$BASE/api/health" >/dev/null

echo "[2/9] billing plan catalog"
curl -fsS --max-time 10 "$BASE/api/billing/plans" | grep -q '"http-test"'

echo "[3/9] first registration"
REGISTER_STATUS="$(curl -sS --max-time 15 -o /tmp/yasser-register.json -w '%{http_code}'   -H 'Content-Type: application/json'   -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"   "$BASE/api/auth/register")"
[[ "$REGISTER_STATUS" == "202" ]]

echo "[4/9] capture verification email"
for _ in $(seq 1 30); do
  if docker compose "${COMPOSE_ARGS[@]}" exec -T gateway sh -c "test -s '$CAPTURE_FILE'" >/dev/null 2>&1; then
    if docker compose "${COMPOSE_ARGS[@]}" exec -T gateway sh -c "cat '$CAPTURE_FILE'" > "$TEST_DATA"; then
      break
    fi
  fi
  sleep 1
done
if ! [[ -s "$TEST_DATA" ]] || ! grep -q "$EMAIL" "$TEST_DATA"; then
  echo "ERROR: Verification email was not captured."
  echo "Gateway email-capture diagnostics:"
  docker compose "${COMPOSE_ARGS[@]}" logs --no-color --tail=80 gateway || true
  exit 1
fi
VERIFY_URL="$(grep -Eo 'https?://[^[:space:]]+/verify-email\?token=[^[:space:]]+' "$TEST_DATA" | tail -n 1)"
[[ -n "$VERIFY_URL" ]]
VERIFY_TOKEN="${VERIFY_URL#*token=}"

echo "[5/9] email verification + onboarding"
curl -fsS --max-time 15 -c "$COOKIE_JAR" -b "$COOKIE_JAR"   "${BROWSER_HEADERS[@]}"   -H 'Content-Type: application/json'   -d "{\"token\":\"$VERIFY_TOKEN\"}"   "$BASE/api/auth/verify-email" | grep -q '"next":"/onboarding"'

curl -fsS --max-time 15 -c "$COOKIE_JAR" -b "$COOKIE_JAR"   "${BROWSER_HEADERS[@]}"   -H 'Content-Type: application/json'   -d "{\"workspaceName\":\"$WORKSPACE\",\"planId\":\"http-test\",\"trial\":true}"   "$BASE/api/onboarding" | grep -q '"next":"/dashboard"'

echo "[6/9] customer login + authenticated session"
LOGIN_STATUS="$(curl -sS --max-time 15 -o /tmp/yasser-login.json -w '%{http_code}'   -c "$COOKIE_JAR" -b "$COOKIE_JAR"   "${BROWSER_HEADERS[@]}"   -H 'Content-Type: application/json'   -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"   "$BASE/api/auth/login")"
[[ "$LOGIN_STATUS" == "200" ]]

curl -fsS --max-time 10 -b "$COOKIE_JAR" "$BASE/api/auth/me" | grep -q '"authenticated":true'

echo "[7/9] desktop-style Manager login"
# Mirror the actual Tauri desktop transport contract. The Gateway only issues
# the desktop bearer token when the explicit desktop marker is paired with a
# trusted Tauri origin; browser-origin headers must not be accepted here.
DESKTOP_HEADERS=(-H 'Origin: tauri://localhost' -H 'X-Odoo-Print-Desktop: 1')
MANAGER_LOGIN_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/manager-login.json" -w '%{http_code}'     -c "$MANAGER_COOKIE_JAR" -b "$MANAGER_COOKIE_JAR"     "${DESKTOP_HEADERS[@]}"     -H 'Content-Type: application/json'     -d "{\"username\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"     "$BASE/api/auth/manager/login"
)"
[[ "$MANAGER_LOGIN_STATUS" == "200" ]]
MANAGER_TOKEN="$(grep -Eo '"accessToken":"[^"]+"' "$TMP_DIR/manager-login.json" | cut -d'"' -f4)"
[[ -n "$MANAGER_TOKEN" ]]
curl -fsS --max-time 10 -H "Authorization: Bearer $MANAGER_TOKEN" "$BASE/api/auth/manager/me" | grep -q '"authenticated":true'
echo "[8/12] Odoo bearer + Agent HTTP bearer + WebSocket over the same HTTP endpoint"

ODOO_KEY_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/odoo-key.json" -w '%{http_code}' \
    "${DESKTOP_HEADERS[@]}" \
    -H "Authorization: Bearer $MANAGER_TOKEN" \
    -H 'Content-Type: application/json' \
    -X POST \
    -d '{"name":"HTTP smoke Odoo"}' \
    "$BASE/api/odoo/keys"
)"
[[ "$ODOO_KEY_STATUS" == "201" ]]
ODOO_KEY="$(json_field apiKey < "$TMP_DIR/odoo-key.json")"
[[ "$ODOO_KEY" == odoo_* ]]
curl -fsS --max-time 10 \
  -H "Authorization: Bearer $ODOO_KEY" \
  "$BASE/api/odoo/health" | grep -q '"ok":true'

AGENT_CREATE_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/agent-create.json" -w '%{http_code}' \
    "${DESKTOP_HEADERS[@]}" \
    -H "Authorization: Bearer $MANAGER_TOKEN" \
    -H 'Content-Type: application/json' \
    -X POST \
    -d '{"name":"HTTP Smoke Agent"}' \
    "$BASE/api/agents"
)"
[[ "$AGENT_CREATE_STATUS" == "201" ]]
AGENT_ID="$(json_field id < "$TMP_DIR/agent-create.json")"
PAIRING_CODE="$(json_field pairingCode < "$TMP_DIR/agent-create.json")"
[[ "$AGENT_ID" == agt_* ]]
[[ "$PAIRING_CODE" =~ ^[A-HJ-NP-Z2-9]{6}$ ]]

AGENT_REGISTER_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/agent-register.json" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -X POST \
    -d "{\"agentId\":\"$AGENT_ID\",\"pairingCode\":\"$PAIRING_CODE\",\"hostname\":\"http-smoke-agent\",\"clientVersion\":\"http-smoke\",\"platform\":\"linux\"}" \
    "$BASE/api/agent/register"
)"
[[ "$AGENT_REGISTER_STATUS" == "200" ]]
REGISTERED_AGENT_ID="$(json_field agentId < "$TMP_DIR/agent-register.json")"
AGENT_SECRET="$(json_field secret < "$TMP_DIR/agent-register.json")"
[[ "$REGISTERED_AGENT_ID" == "$AGENT_ID" ]]
[[ -n "$AGENT_SECRET" ]]

AGENT_BEARER="Bearer $AGENT_ID:$AGENT_SECRET"
curl -fsS --max-time 10 \
  -H "Authorization: $AGENT_BEARER" \
  -H 'Content-Type: application/json' \
  -X POST \
  -d '{"status":"online","printers":[]}' \
  "$BASE/api/agent/heartbeat" | grep -q '"ok":true'

WS_KEY="$(openssl rand -base64 16)"
WS_STATUS="$(
  curl -sS --http1.1 --max-time 10 \
    -o /dev/null \
    -D "$TMP_DIR/agent-ws-headers.txt" \
    -w '%{http_code}' \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: $WS_KEY" \
    -H "Authorization: $AGENT_BEARER" \
    "$BASE/api/agent/ws"
)"
if [[ "$WS_STATUS" != "101" ]]; then
  echo "ERROR: Agent WebSocket HTTP upgrade returned $WS_STATUS"
  cat "$TMP_DIR/agent-ws-headers.txt"
  exit 1
fi

echo "PASS: HTTP Odoo bearer, Agent bearer, pairing, heartbeat, and WebSocket upgrade"

echo "[9/12] Manager logout + bearer revocation"
MANAGER_LOGOUT_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/manager-logout.json" -w '%{http_code}' -H "Authorization: Bearer $MANAGER_TOKEN" -X POST "$BASE/api/auth/manager/logout"
)"
if [[ "$MANAGER_LOGOUT_STATUS" != "200" ]]; then
  echo "ERROR: Manager logout returned HTTP $MANAGER_LOGOUT_STATUS"
  cat "$TMP_DIR/manager-logout.json"
  exit 1
fi
MANAGER_AFTER_LOGOUT_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/manager-me-after-logout.json" -w '%{http_code}' -H "Authorization: Bearer $MANAGER_TOKEN" "$BASE/api/auth/manager/me"
)"
if [[ "$MANAGER_AFTER_LOGOUT_STATUS" != "401" ]]; then
  echo "ERROR: Manager bearer remained valid after logout (HTTP $MANAGER_AFTER_LOGOUT_STATUS)"
  cat "$TMP_DIR/manager-me-after-logout.json"
  exit 1
fi

echo "[10/12] customer logout + session revocation"
CUSTOMER_LOGOUT_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/customer-logout.json" -w '%{http_code}' "${BROWSER_HEADERS[@]}" -b "$COOKIE_JAR" -X POST "$BASE/api/auth/logout"
)"
if [[ "$CUSTOMER_LOGOUT_STATUS" != "200" ]]; then
  echo "ERROR: Customer logout returned HTTP $CUSTOMER_LOGOUT_STATUS"
  cat "$TMP_DIR/customer-logout.json"
  exit 1
fi
CUSTOMER_AFTER_LOGOUT_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/me-after-logout.json" -w '%{http_code}' -b "$COOKIE_JAR" "$BASE/api/auth/me"
)"
if [[ "$CUSTOMER_AFTER_LOGOUT_STATUS" != "401" ]]; then
  echo "ERROR: Customer session remained valid after logout (HTTP $CUSTOMER_AFTER_LOGOUT_STATUS)"
  cat "$TMP_DIR/me-after-logout.json"
  exit 1
fi

echo
echo "PASS: signup -> verification capture -> workspace trial -> customer login -> Manager bearer login -> both sessions revoked"
echo "Test account: $EMAIL"
echo "Gateway: $BASE"
