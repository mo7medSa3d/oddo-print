# Operations

## Tenant configuration
For multi-tenant Manager login, add a verified `tenant_domains` row for each customer hostname. During single-tenant bootstrap, `MANAGER_TENANT_ID` may be used.

## Metrics endpoint
`GET /api/metrics` requires a manager session whose `tenantId` equals
`PLATFORM_TENANT_ID` (set it in the gateway environment; without it the
endpoint answers 403 even for valid managers). Prometheus scraping therefore
needs both a manager credential AND the platform tenant configured.

## API key rotation
Gateway API-key rotation supports a bounded read-only grace window for in-flight
Odoo jobs. New print submissions require the new active key, while status reads
may continue through the retired key only during its persisted grace interval.
Do not rely on indefinite compatibility: complete rotation and remove/revoke old
credentials promptly after the grace window ends.

## Migration
Run migrations before starting the application. Migration `0029` intentionally stops when it detects ambiguous legacy ownership. Migration `0032` intentionally stops when two pending pairing codes share one hash — regenerate the affected codes (disable/re-enable the agent) and re-run; collisions are never resolved automatically.

## Session invalidation
Migration `0030` was the historical manager-session reset used when the legacy session store was introduced; it is not the refresh-token cutover mechanism.

The current session migration is gradual. New logins issue a 15-minute access JWT plus a rotating refresh-token family with a 30-day absolute cap. Existing pre-v2 `manager_sessions`/`platform_sessions` sessions remain valid through their original 8-hour expiry and are verified through the legacy fallback path. No blanket logout is performed by the refresh-token migration.

The Gateway's existing 5-minute housekeeping loop removes expired legacy manager/platform sessions and expired refresh-token rows.

## Runtime truth
A configured printer may remain configured while an Agent is offline/stale. Runtime availability and physical print outcome are distinct states.

## Incident handling
For an unknown physical outcome, inspect the printer before reprinting. Do not assume a failed network acknowledgement means the printer definitely did not print.
