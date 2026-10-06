#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="staging-domain-contract-${RANDOM}-$$"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=isolated-test-password \
  postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
psql() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
bind_domain() {
  psql -v domain=print.yaseir.cloud -v "manager_tenant_id=${1:-}" \
    -v platform_tenant_id=platform < "$ROOT/deploy/domain-test/configure-domain.sql"
}
expect_failure() {
  if bind_domain "${1:-}" >/dev/null 2>&1; then echo "Expected domain binding to fail"; exit 1; fi
}
psql <<'SQL'
CREATE TABLE tenants (id text PRIMARY KEY, lifecycle text NOT NULL DEFAULT 'active');
CREATE TABLE tenant_domains (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
  domain text NOT NULL UNIQUE, verified_at timestamp, is_primary boolean NOT NULL DEFAULT false
);
INSERT INTO tenants(id) VALUES ('platform');
SQL
# Empty staging: no arbitrary attachment to the platform workspace.
bind_domain
[[ "$(psql -Atc 'SELECT count(*) FROM tenant_domains')" == "0" ]]
psql -c "INSERT INTO tenants(id) VALUES ('workspace-one')"
bind_domain
[[ "$(psql -Atc 'SELECT tenant_id FROM tenant_domains')" == "workspace-one" ]]
verified="$(psql -Atc 'SELECT verified_at FROM tenant_domains')"
bind_domain
[[ "$(psql -Atc 'SELECT count(*) FROM tenant_domains')" == "1" ]]
[[ "$(psql -Atc 'SELECT verified_at FROM tenant_domains')" == "$verified" ]]
# An existing domain owner wins even after additional workspaces are created.
psql -c "INSERT INTO tenants(id) VALUES ('workspace-two')"
bind_domain
expect_failure workspace-two
[[ "$(psql -Atc 'SELECT tenant_id FROM tenant_domains')" == "workspace-one" ]]
# Unowned domains require an explicit selection when there are several workspaces.
psql -c 'DELETE FROM tenant_domains'
expect_failure
expect_failure missing-workspace
psql -c "UPDATE tenants SET lifecycle='suspended' WHERE id='workspace-two'"
expect_failure workspace-two
bind_domain workspace-one
[[ "$(psql -Atc 'SELECT tenant_id FROM tenant_domains')" == "workspace-one" ]]
echo "Staging domain binding integration checks passed."
