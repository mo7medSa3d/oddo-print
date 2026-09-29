#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${SMOKE_BASE_URL:-https://print.yaseir.cloud}"
BASE_URL="${BASE_URL%/}"
if [[ "$BASE_URL" != "https://print.yaseir.cloud" ]]; then
  echo "ERROR: smoke is pinned to https://print.yaseir.cloud." >&2
  exit 1
fi
echo "Checking HTTPS liveness..."
curl -fsS --max-time 15 "$BASE_URL/api/live"
echo
echo "Checking HTTPS readiness..."
curl -fsS --max-time 15 "$BASE_URL/api/health"
echo
echo "Checking HTTP to HTTPS redirect..."
status="$(curl -sS -o /dev/null -D - --max-time 15 "http://print.yaseir.cloud/api/live" | grep -i "^HTTP/" | tail -1 | awk "{print \$2}")"
if [[ "$status" != "301" && "$status" != "308" ]]; then
  echo "ERROR: expected HTTP 301/308 redirect, got HTTP $status." >&2
  exit 1
fi
echo "Domain staging smoke passed."
