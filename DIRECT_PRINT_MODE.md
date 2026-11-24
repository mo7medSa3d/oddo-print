# Direct Odoo Print Mode

## Contract

The supported print data plane is **Odoo 19 → Go Agent → physical printer**. Yaseir Cloud is not on the print payload path.

| Concern | Owner | Contract |
|---|---|---|
| Print intent and durable queue | Odoo | The outbox row is committed before it can be claimed |
| Agent identity and pairing | Odoo | Pairing code is exchanged directly with Odoo; bearer token is stored by the Agent |
| Printer inventory | Go Agent + Odoo | Agent reports local inventory on heartbeat; Odoo stores the company-scoped mapping |
| Claims and leases | Odoo | `GET /api/agent/jobs` atomically claims eligible jobs using a claim token |
| Physical execution | Go Agent | Local SQLite ledger and native printer transports own execution |
| Terminal outcome | Odoo | Agent posts an authenticated ACK; Odoo is the status source of truth |
| Commercial control plane | Yaseir Cloud / Odoo license config | Tenant, subscription and signed entitlement only; no print jobs |

## Direct Agent endpoints

- `GET /api/agent/probe` — identifies the endpoint as `odoo-direct-print-agent`.
- `POST /api/agent/register` — consumes an Odoo-issued pairing code and returns the Agent credential.
- `POST /api/agent/heartbeat` — updates Agent presence and printer inventory.
- `GET /api/agent/jobs` — atomically claims queued work for the authenticated Agent.
- `POST /api/agent/ack` — records `queued` (pre-execution release), `printing`, `success` or `failed` with the claim token.

All Agent endpoints require HTTPS in production. The Agent initiates every connection; Odoo does not need inbound connectivity to a workstation. The Cloud service is not needed for local job polling after pairing, but Odoo and its database must remain reachable.

## Delivery semantics

- Poll interval: 5 seconds; heartbeat interval: 30 seconds.
- Odoo's claim lease is 90 seconds. A stale claim may be reclaimed only before the Agent acknowledges `printing` and within the bounded attempt policy.
- Once `printing` is acknowledged, a lost terminal ACK is an ambiguous physical outcome. It must not be automatically requeued as though nothing was printed.
- A successful Agent ACK confirms the Agent/spooler execution result, not independent paper-ejection evidence.
- No exactly-once physical-output guarantee is made.

## Removed Cloud dispatch paths

The Cloud API routes for creating/reprinting print jobs and printer test-print/certification dispatch were removed from the Next.js application. Odoo's old cron-based Cloud submit and status-reconciliation tasks are disabled; their compatibility methods do not send requests. Desktop Manager no longer fetches Cloud print jobs or registers printers in a Cloud fleet. Its printer configuration is local to the Agent and reaches Odoo on heartbeat.

Historical Cloud job tables/columns and old Odoo technical names remain in the source/database schema for upgrade and data-retention compatibility. They are not an active print path. The Odoo addon directory and model prefix remain `print_gateway` to avoid an unsafe rename/migration of installed databases.

## Deployment and migration

1. Deploy the updated Odoo addon and upgrade the module.
2. Verify Odoo's public HTTPS URL and `/api/agent/probe` return the direct service identity.
3. Configure Desktop Manager with the Odoo base URL, not `print.yaseir.cloud` or another Cloud URL.
4. Issue a new pairing code from Odoo and pair each Agent directly. Existing Cloud-paired Agent credentials are not assumed to work against Odoo; re-pair them.
5. Ensure each printer is enabled/shared by local Agent policy and appears in Odoo after the next heartbeat.
6. Verify a non-production test print, then verify an actual Odoo report/POS path. Test offline/reconnect and ambiguous-ACK handling before production rollout.

## Verification boundary

The repository package is statically checked only to the extent listed in its accompanying remediation report. This file describes the intended runtime contract; it is not proof that Windows hardware or a live Odoo/PostgreSQL deployment has passed end-to-end testing.
