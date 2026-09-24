# System Health — Single Pane

## Purpose
Single page for Gateway, DB, Queue, Agents, Printers, Odoo, Billing. For client demo and Release Readiness.

## Endpoint
`GET /api/system/health` — requires manager auth, returns:
- overall: ok/warn/error
- timestamp
- gateway: heap, uptime, version
- database: reachable, latency
- queue: stuck jobs count (claimed >5m)
- agents: total/online
- printers: total/online
- odoo: unknown (requires runtime check via /api/odoo/health)
- billing: unknown (requires Stripe connectivity)
- checks: array of all checks
- version: gateway + schema

## UI
`/system-health` — shows overall badge, grid of checks, distributed tracing example.

## Future
- Odoo health: call Odoo External API health endpoint, verify Bearer key, check last sync
- Billing health: Stripe API reachable, webhook secret valid, last event processed
- Incident Center: aggregates health checks into incidents with severity
- Admin Analytics: real metrics from gateway_metrics table

## Integration with Release Readiness
System Health is part of Release Readiness Dashboard (`/release-readiness`) — P0 must-close.
