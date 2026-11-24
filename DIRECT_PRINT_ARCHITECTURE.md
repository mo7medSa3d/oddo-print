# Direct Odoo Printing

## Runtime boundary

The print data plane has one direct route:

`Odoo 19 Outbox → Odoo Agent API (WebSocket /api/agent/ws + HTTP fallback) → Go Agent → Local Printer`

There is no Cloud print queue, Cloud job dispatch, or Cloud printer discovery. Legacy Gateway `/api/printers` routes and the `/platform/operations` page have been removed.

### Ownership

- **Odoo** owns business print intent, durable jobs, company/branch routing, Agent registration, printer inventory, job claims, ACKs, retry decisions, PostgreSQL `pg_notify('print_gateway_job_ready', ...)` wakeups, the direct `/api/agent/ws` WebSocket endpoint, and the print audit trail.
- **Go Agent** maintains a zero-dependency RFC 6455 WebSocket connection (`/api/agent/ws`) to Odoo for immediate job-ready wakeups with automatic authenticated HTTPS polling fallback (`/api/agent/heartbeat`, `/api/agent/jobs`, `/api/agent/ack`), enforces runtime Ed25519 license verification (`PinnedPublicKeyB64`, `RuntimeGuard`, `CheckPrintAllowed`), persists its local execution state, and writes to the local printer using the configured transport.
- **Desktop Manager** configures the local Agent and its printers. It is not a Cloud job dispatcher.
- **Yaseir Cloud (License-Only Gateway)** is strictly limited to subscriptions, Ed25519 v2 signed license issuance/verification (`/api/license/refresh`, `/api/license/verify`), tenant administration, and account-level management. It does not receive or dispatch print payloads.

The old Odoo technical model ID `print_gateway.gateway_config` is retained only to upgrade existing databases in place. Its implementation is now a small Direct Print Service configuration; it does not contain a remote Gateway URL or print-delivery credentials.

## License-Only Gateway (Ed25519 v2)

- **`POST /api/license/refresh`**: Issues a signed Ed25519 v2 license bundle containing `version`, `rev` (monotonic anti-rollback revision), `status` (`active` / `revoked`), `odoo_db_uuid`, `plan`, `max_agents`, `max_printers`, `issued_at`, `expires_at`, and `grace_until`.
- **`POST /api/license/verify`**: Verifies an Ed25519 v1/v2 bundle's signature, `odoo_db_uuid` binding, `status`, `minRev` anti-rollback floor, expiry, and grace period.
- The Go Agent verifies bundles offline against its compiled `PinnedPublicKeyB64` before executing print jobs (`CheckPrintAllowed`). A Cloud refresh failure does not clear the last valid cached bundle; printing follows the signed expiry/grace window without putting Cloud in the job-delivery round trip.

## Job lifecycle

`queued → claimed → printing → success | failed | unknown`

`unknown` is terminal. It means the Agent cannot prove whether physical output occurred. It is not automatically retried; an operator must inspect the printer/output and explicitly reprint when appropriate. This avoids duplicate paper when a device printed but its ACK was lost.

A successful transport/spooler submission is not a guarantee that paper physically emerged. Exactly-once physical printing is not promised.

## Operational policy

- Agent delivery uses direct Odoo ↔ Agent RFC 6455 WebSocket (`/api/agent/ws`) triggered by PostgreSQL `pg_notify('print_gateway_job_ready', ...)` for low-latency wakeups, with automatic fallback to authenticated HTTP polling (`/api/agent/jobs`) and Odoo-owned claim tokens.
- Printer inventory status is informational. A stale/offline/unknown status does not by itself prevent an explicitly routed job from being attempted.
- The Agent does not run an operational-certification workflow before every job.
- Dispatch checks only that the selected local printer is registered, not locally disabled, and matches the Odoo route/Agent assignment. These are routing-integrity checks, not hardware certification.
- Local IPP identity persistence remains in the Agent registry to avoid accidental identity changes across restarts.
- A Cloud licence refresh failure does not clear the last stored signed bundle. Printing follows the Odoo and Agent licence policy (`rev`, `status`, expiry/grace rules); Cloud is not in the job-delivery round trip.

## Upgrade behavior

Version `19.0.2.37.0` migrates old Gateway-era data:

- Jobs with an external Cloud job ID, or old `submitted`/`partial` states, are moved to `unknown` and marked for manual review. They are never replayed automatically.
- Old opaque Agent IDs are converted to relations to Agents registered in the same Odoo database.
- Assignments that refer only to non-local Cloud Agents are removed; bindings that cannot be mapped to a local Agent are archived until an administrator reassigns them.
- Remote queue identifiers, external submission metadata, and remote config fields are dropped.
- Old Cloud queue/status cron workers are disabled. Local outbox recovery, Agent staleness, and signed licence refresh remain.

After upgrading, review any archived print bindings, assign an Agent that has paired directly with the Odoo database, and confirm the route's printer key before enabling it.
