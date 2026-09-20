#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/deploy/http-test/.env.http-test"
TEST_DATA="$ROOT_DIR/deploy/http-test/test-data/verification-email.txt"
COOKIE_JAR="$ROOT_DIR/deploy/http-test/test-data/cookies.txt"
MANAGER_COOKIE_JAR="$ROOT_DIR/deploy/http-test/test-data/manager-cookies.txt"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$COOKIE_JAR" "$MANAGER_COOKIE_JAR"' EXIT

[[ -f "$ENV_FILE" ]] || { echo "ERROR: Run setup-http-test.sh first."; exit 1; }

set -a
source "$ENV_FILE"
set +a

BASE="${SMOKE_BASE_URL:-http://127.0.0.1:${HTTP_TEST_PORT}}"
EMAIL="test+$(date +%s)-$@yasser.invalid"
PASSWORD="Yasser-Test-2026!"
WORKSPACE="Yasser HTTP Test Workspace"

rm -f "$COOKIE_JAR" "$MANAGER_COOKIE_JAR"
: > "$TEST_DATA"

echo "[1/9] liveness/readiness"
curl -fsS "$BASE/api/live" >/dev/null
curl -fsS "$BASE/api/health" >/dev/null

echo "[2/9] billing plan catalog"
curl -fsS "$BASE/api/billing/plans" | grep -q '"http-test"'

echo "[3/9] first registration"
REGISTER_STATUS="$(curl -sS -o /tmp/yasser-register.json -w '%{http_code}'   -H 'Content-Type: application/json'   -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"   "$BASE/api/auth/register")"
[[ "$REGISTER_STATUS" == "202" ]]

echo "[4/9] capture verification email"
for _ in $(seq 1 30); do
  [[ -s "$TEST_DATA" ]] && break
  sleep 1
done
grep -q "$EMAIL" "$TEST_DATA"
VERIFY_URL="$(grep -Eo 'https?://[^[:space:]]+/verify-email\?token=[^[:space:]]+' "$TEST_DATA" | tail -n 1)"
[[ -n "$VERIFY_URL" ]]
VERIFY_TOKEN="${VERIFY_URL#*token=}"

echo "[5/9] email verification + onboarding"
curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR"   -H 'Content-Type: application/json'   -d "{\"token\":\"$VERIFY_TOKEN\"}"   "$BASE/api/auth/verify-email" | grep -q '"next":"/onboarding"'

curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR"   -H 'Content-Type: application/json'   -d "{\"workspaceName\":\"$WORKSPACE\",\"planId\":\"http-test\",\"trial\":true}"   "$BASE/api/onboarding" | grep -q '"next":"/dashboard"'

echo "[6/9] customer login + authenticated session"
LOGIN_STATUS="$(curl -sS -o /tmp/yasser-login.json -w '%{http_code}'   -c "$COOKIE_JAR" -b "$COOKIE_JAR"   -H 'Content-Type: application/json'   -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"   "$BASE/api/auth/login")"
[[ "$LOGIN_STATUS" == "200" ]]

curl -fsS -b "$COOKIE_JAR" "$BASE/api/auth/me" | grep -q '"authenticated":true'

echo "[7/9] desktop-style Manager login"
MANAGER_LOGIN_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/manager-login.json" -w '%{http_code}'     -c "$MANAGER_COOKIE_JAR" -b "$MANAGER_COOKIE_JAR"     -H 'Content-Type: application/json'     -H 'X-Odoo-Print-Desktop: 1'     -d "{\"username\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"     "$BASE/api/auth/manager/login"
)"
[[ "$MANAGER_LOGIN_STATUS" == "200" ]]
MANAGER_TOKEN="$(grep -Eo '"accessToken":"[^"]+"' "$TMP_DIR/manager-login.json" | cut -d'"' -f4)"
[[ -n "$MANAGER_TOKEN" ]]
curl -fsS -H "Authorization: Bearer $MANAGER_TOKEN" "$BASE/api/auth/manager/me" | grep -q '"authenticated":true'

echo "[8/9] Manager logout + bearer revocation"
curl -fsS -H "Authorization: Bearer $MANAGER_TOKEN" -X POST "$BASE/api/auth/manager/logout" >/dev/null
MANAGER_AFTER_LOGOUT_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/manager-me-after-logout.json" -w '%{http_code}'     -H "Authorization: Bearer $MANAGER_TOKEN"     "$BASE/api/auth/manager/me"
)"
[[ "$MANAGER_AFTER_LOGOUT_STATUS" == "401" ]]

echo "[9/9] customer logout + session revocation"
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE/api/auth/logout" >/dev/null
CUSTOMER_AFTER_LOGOUT_STATUS="$(
  curl -sS --max-time 10 -o "$TMP_DIR/me-after-logout.json" -w '%{http_code}'     -b "$COOKIE_JAR"     "$BASE/api/auth/me"
)"
[[ "$CUSTOMER_AFTER_LOGOUT_STATUS" == "401" ]]

echo
echo "PASS: signup -> verification capture -> workspace trial -> customer login -> Manager bearer login -> both sessions revoked"
echo "Test account: $EMAIL"
echo "Gateway: $BASE"
