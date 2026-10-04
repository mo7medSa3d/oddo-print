#!/usr/bin/env bash
# SQL lock probe only. Production claim behavior requires the integration suite.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to an isolated test PostgreSQL database}"
command -v node >/dev/null 2>&1 || { echo "UNVERIFIED: Node is unavailable" >&2; exit 2; }
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Running isolated PostgreSQL SQL-lock probe; database credentials are not printed."
exec node "$project_dir/tests/pg-concurrent-claim.mjs"
