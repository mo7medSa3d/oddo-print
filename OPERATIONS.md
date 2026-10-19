# Operations

## Tenant configuration
For multi-tenant Manager login, add a verified `tenant_domains` row for each customer hostname. During single-tenant bootstrap, `MANAGER_TENANT_ID` may be used.

`npm run platform:bootstrap` creates the first Platform Owner. Promoting an existing account or replacing its password with `--force` atomically revokes that account's earlier sessions and outstanding password-reset/email-verification links. Sign in again with the bootstrap password; other accounts remain unchanged.

Resolution order for a login request: `Host` header → `tenant_domains`
(verified rows only) → `MANAGER_TENANT_ID` fallback. When both a matching
domain row and `MANAGER_TENANT_ID` are set, the domain row wins; `MANAGER_TENANT_ID`
applies only when no domain matches. With neither configured, multi-tenant
login cannot route to a workspace.

Verify routing rows:

```sql
SELECT domain, tenant_id, verified_at, is_primary FROM tenant_domains ORDER BY domain;
```

Expected behavior: single-tenant mode logs into the pinned tenant;
multi-tenant mode routes each hostname to its verified tenant; an unknown
host is rejected rather than routed to a default workspace. There is no
tenant-routing troubleshooting section: misrouting presents as login
landing in the wrong workspace — check the table above first.

## Metrics endpoint
`GET /api/metrics` requires a platform owner session (`plt_session`). Tenant
manager sessions are never sufficient, even for members of the platform
workspace: global telemetry is control-plane data. Configure Prometheus
scraping with a platform owner credential (static `Cookie` header).

Fleet gauges are evidence-specific: `agents_online`/`agents_offline` require a fresh explicit Agent state, while stale and never-seen Agents are exposed separately as `agents_stale`/`agents_unknown`. Printer physical observations are split into `printers_online`, `printers_busy`, `printers_offline`, `printers_error`, `printers_stale`, and `printers_unknown`. `printers_routable` is the cross-component routing signal (fresh printer ready/busy evidence plus a reachable active Agent); do not interpret it as proof that a physical printer is Online.

## API key rotation
Gateway API-key rotation supports a bounded read-only grace window for in-flight
Odoo jobs. New print submissions require the new active key, while status reads
may continue through the retired key only during its persisted grace interval.
Do not rely on indefinite compatibility: complete rotation and remove/revoke old
credentials promptly after the grace window ends.

## Billing event monitoring
`checkout.session.completed` binds the Stripe subscription but access is
provisioned only by the follow-up subscription lifecycle event. If that event
is lost (endpoint filter, delivery expiry), a paying tenant stays blocked.
Monitor continuously:

```sql
-- Unprocessed or conflicted billing events needing operator review:
SELECT event_id, event_type, tenant_id, processed_at FROM billing_events
WHERE processed_at IS NULL ORDER BY event_id LIMIT 50;
```

Alert on `billing.identity_conflict`, `billing.checkout_customer_conflict`,
and `billing.stale_checkout_subscription` audit actions, and reconcile the
Stripe dashboard delivery log against `billing_events` after every checkout
or plan change. A `past_due` subscription retains print access during payment
recovery by design; `unpaid`, `paused`, and canceled states do not provision
entitlements. Rows with a missing `current_period_end` on `active`/`trialing`
are treated as live (deliberate compatibility); backfill the period from
Stripe rather than assuming expiry.

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

### Unknown-outcome recovery runbook (no automatic duplicate printing)

Unknown outcomes carry one of these durable markers (`PHYSICAL_OUTCOME_UNKNOWN_MARKERS` in `src/lib/job-status.ts`):

| Marker | Meaning | First evidence to collect |
|---|---|---|
| `UNKNOWN_PARTIAL_DELIVERY` | Bytes may have reached the agent; no execution report arrived within the claim lease | Gateway job timeline + agent SQLite outbox row for the job |
| `AGENT_EXECUTION_TIMEOUT` | Agent started printing but the execution lease expired | Agent logs around `transport_complete`; printer output tray |
| `AGENT_RESTART_DURING_PRINT` | Agent restarted mid-print (crash recovery path) | Agent startup logs; `reprint_after_crash` setting |
| `JOB_EXPIRED_DURING_PRINT` | TTL elapsed mid-execution | Timeline `expired` entry; printer output tray |
| `UNKNOWN_SUBMISSION_OUTCOME` | Submission response lost; Gateway acceptance uncertain | Odoo outbox `gateway_job_id`; Gateway job lookup by idempotency key |

Procedure:

1. List unknowns (do not invent recovery state):
   ```sql
   SELECT id, status, error, printer_id, agent_id, updated_at FROM print_jobs
   WHERE error LIKE 'UNKNOWN%' OR error LIKE 'AGENT%' OR error LIKE 'JOB_EXPIRED%'
   ORDER BY updated_at DESC LIMIT 50;
   ```
2. For the job, read the Gateway timeline (`GET /api/jobs/[id]/timeline`) and,
   on the agent host, the SQLite outbox row plus (Windows) the recorded
   spooler job identity. A late `success` from the original claim token still
   reconciles automatically within the 24-hour fenced window — wait for it
   before touching paper.
3. Physically inspect the printer (output tray, reprint the spooler job
   identity only as an inspection aid, never as the recovery itself).
4. Recover exactly once, as an explicit new attempt: dashboard Reprint
   (`POST /api/jobs/[id]/reprint`, creates a NEW job with a NEW idempotency
   key) or a new Odoo outbox row. Never reuse the original idempotency key
   (returns `409 IDEMPOTENCY_CONFLICT` by design) and never flip the old row
   back to `queued` with a database edit (that bypasses claim fencing and can
   double-print alongside the original attempt).
5. Only after physical reconciliation, clear the agent's retained
   unknown-outcome row with `jobs cleanup --include-unknown`. Never delete
   the SQLite queue file.


### Agent local ledger cleanup (operator action)

`jobs cleanup` removes only terminal local records whose physical outcome is not ambiguous and whose Gateway status has already been acknowledged. It preserves failed rows carrying unknown-outcome evidence by default. To remove a physically reconciled unknown-outcome record, an authorized operator may explicitly run `jobs cleanup --include-unknown` **after** inspecting the printer and Gateway job timeline. This never overrides an outstanding Gateway acknowledgment: rows retaining a claim token remain in the Agent SQLite outbox so their terminal result can be replayed after reconnection.

The command supports `--json` (`deleted`, `unknownPurged`, `unknownKept`) and `--config <path>`. Its plain-text result also reports how many unknown-outcome rows remain. Unsupported options, including `--dry-run`, are rejected; there is no dry-run mode. Do not delete the SQLite queue file to "fix" a duplicate-print warning. The 48-hour automatic terminal retention applies only to records whose Gateway claim token has already been cleared.

Stale-Agent persistence converges every 15 seconds in ordered batches of 200 rows by default. `AGENT_PRESENCE_SWEEP_LIMIT` may set a positive batch size, capped at 5000. Multiple Gateway instances skip each other's locked candidates. Request-time availability still derives from heartbeat freshness immediately; a large outage backlog does not require one fleet-wide UPDATE.
