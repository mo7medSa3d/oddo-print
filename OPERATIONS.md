# Operations

## Tenant configuration
For multi-tenant Manager login, add a verified `tenant_domains` row for each customer hostname. During single-tenant bootstrap, `MANAGER_TENANT_ID` may be used.

## Metrics endpoint
`GET /api/metrics` requires a platform owner session (`plt_session`). Tenant
manager sessions are never sufficient, even for members of the platform
workspace: global telemetry is control-plane data. Configure Prometheus
scraping with a platform owner credential (static `Cookie` header).

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
A configured printer may remain configured while an Agent is offline/stale. Agent connectivity, heartbeat freshness, printer-observation freshness, queue accessibility, and physical printer state are separate facts. The UIs expose `stale` separately; a stale heartbeat does not rewrite a printer to physical Offline, and a stale printer observation does not become fresh merely because the Agent reconnected.

## Incident handling
For an unknown physical outcome, inspect the printer and (for Windows jobs) the recorded spooler job identity before reprinting. Do not assume a failed acknowledgement, timeout, restart, or post-submission error means the printer definitely did not print. Automatic retry is prohibited once physical submission may have occurred. A manual reprint is an explicit new physical attempt and can produce a duplicate if the uncertain attempt already printed.
