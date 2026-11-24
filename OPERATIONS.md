# Operations

## Tenant configuration
The current customer login (`/api/auth/login`) authenticates an email/password
account and its active memberships. Accounts with multiple workspaces receive
a tenant-selection token and choose an authorized workspace; hostname mapping
does not grant membership.

The compatibility Manager login (`/api/auth/manager/login`) resolves a workspace
from verified `tenant_domains` rows or the explicit `MANAGER_TENANT_ID` fallback.
Shared legacy-password authentication is restricted to development/test with
`ALLOW_LEGACY_MANAGER_AUTH=1`; production still requires a real account and
membership.

`npm run platform:bootstrap` creates the first Platform Owner. Promoting an existing account or replacing its password with `--force` atomically revokes that account's earlier sessions and outstanding password-reset/email-verification links. Sign in again with the bootstrap password; other accounts remain unchanged.

Resolution order for a compatibility Manager login: `Host` header → `tenant_domains`
(verified rows only) → `MANAGER_TENANT_ID` fallback. When both a matching
domain row and `MANAGER_TENANT_ID` are set, the domain row wins; `MANAGER_TENANT_ID`
applies only when no domain matches. With neither configured, that compatibility
endpoint cannot resolve a workspace. This does not prevent the customer
account/membership login flow.

Verify routing rows:

```sql
SELECT domain, tenant_id, verified_at, is_primary FROM tenant_domains ORDER BY domain;
```

Expected compatibility behavior: the fallback pins an unmatched hostname to its
configured tenant; a verified hostname selects its mapped tenant first. If
unknown hostnames must be rejected, leave `MANAGER_TENANT_ID` unset. Production
login still requires account membership and active-tenant checks.
If this login lands in an unexpected workspace, inspect the verified mapping
and fallback before changing account memberships.

## Metrics endpoint
`GET /api/metrics` accepts a current password-authenticated platform owner session or an
explicitly configured independent collector credential. Unattended collection
uses `METRICS_SCRAPE_TOKEN_FILE` and the Bearer header; it is disabled by default.
Its authority is limited to the exact read-only metrics endpoint. Tenant
membership and workspace sessions never grant global telemetry access. Follow
[Metrics collection](docs/METRICS_COLLECTION.md) for secret-file custody,
the optional Compose overlay, verified HTTPS, rotation, revocation and receiver
acceptance. Human session cookies expire and are unsuitable for unattended
scraping.

Fleet gauges are evidence-specific: `agents_online`/`agents_offline` require a fresh explicit Agent state, while stale and never-seen Agents are exposed separately as `agents_stale`/`agents_unknown`. Printer physical observations are split into `printers_online`, `printers_busy`, `printers_offline`, `printers_error`, `printers_stale`, and `printers_unknown`. `printers_routable` is the cross-component routing signal (fresh printer ready/busy evidence plus a reachable active Agent); do not interpret it as proof that a physical printer is Online.

## API key rotation
Gateway API-key rotation supports a bounded read-only grace window for in-flight
Odoo jobs. New print submissions require the new active key, while status reads
may continue through the retired key only during its persisted grace interval.
Do not rely on indefinite compatibility: complete rotation and remove/revoke old
credentials promptly after the grace window ends.

## Manual subscription operations

Review activation requests in Platform Admin and open the workspace detail before applying a change. Confirm the requester, plan, free/paid business mode, monthly/yearly/custom contract dates and the independent monthly job allowance. Mutations require a reason, recent password proof, an idempotency key and current revision. Repeating the same operation returns its prior result; a conflicting or stale operation must be reloaded and reviewed.

Use `subscription_changes` and `audit_events` for immutable action evidence. `print_monthly_usage` is the quota authority for the current UTC calendar month. Retained `print_usage_periods`, provider identifiers and `billing_events` are migration/history evidence; do not delete them to reset a customer allowance. Renewal and same-cycle plan changes retain consumed credits. Usage summaries deduplicate live jobs and retained receipts by tenant and job identity.

No V4 customer flow automatically collects or settles payment. Retired provider routes return HTTP 410 without writing subscription state. Reconcile historical external recurring subscriptions separately before a real business cutover; changing a local record does not cancel an external charge.

## Migration
Run migrations before starting the application. Migration `0029` intentionally stops when it detects ambiguous legacy ownership. Migration `0032` intentionally stops when two pending pairing codes share one hash — regenerate the affected codes (disable/re-enable the agent) and re-run; collisions are never resolved automatically.

## Session invalidation
Migration `0030` was the historical manager-session reset used when the legacy session store was introduced; it is not the refresh-token cutover mechanism.

Current human authentication requires persisted password/session policy. Apply
all immutable migrations in the release manifest (including forward-only
`0103` for retained attempt/spooler evidence) with older instances drained,
**before** deploying the new Gateway receipt-reader. The V3 forward migration
removes retired factor material while preserving accounts,
password hashes, memberships, existing session families, revocation state and
deadlines. Legacy/pre-policy sessions cannot bypass current admission guards.
See [Migration](MIGRATION.md) for the backup, upgrade, rollback and pending
Agent-pairing-code procedures.

Access JWTs expire after 15 minutes and also require the exact live session row.
Platform sessions have an eight-hour absolute cap; workspace sessions have a
30-day cap. Both human realms enforce 30-minute idle expiry, and sensitive
actions require fresh password proof within five minutes.
Background refresh does not extend idle activity or mint fresh password proof.

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
| `AGENT_RESTART_DURING_PRINT` | Agent restarted mid-print; original outcome remains unknown | Agent startup logs and the original claim/spooler evidence. The deprecated `reprint_after_crash` flag cannot authorize another attempt, including when set to `true`. |
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
3. Physically inspect the printer's output tray and inspect the recorded
   spooler job state. Do not resubmit a spooler job merely to inspect it.
4. Recover exactly once, as an explicit new attempt: dashboard Reprint
   (`POST /api/jobs/[id]/reprint`, creates a NEW job with a NEW idempotency
   key) or a new Odoo outbox row. Use a new key for this deliberate new print
   intent. Retrying the original key with identical content returns the
   original receipt; different content returns `409 IDEMPOTENCY_CONFLICT`.
   Never flip the old row back to `queued` with a database edit (that bypasses
   claim fencing and can double-print alongside the original attempt).
5. Only after physical reconciliation, clear the agent's retained
   unknown-outcome row with `jobs cleanup --include-unknown`. Never delete
   the SQLite queue file.


### Agent local ledger cleanup (operator action)

`jobs cleanup` removes only terminal local records whose physical outcome is not ambiguous and whose Gateway status has already been acknowledged. It preserves failed rows carrying unknown-outcome evidence by default. To remove a physically reconciled unknown-outcome record, an authorized operator may explicitly run `jobs cleanup --include-unknown` **after** inspecting the printer and Gateway job timeline. This never overrides an outstanding Gateway acknowledgment: rows retaining a claim token remain in the Agent SQLite outbox so their terminal result can be replayed after reconnection.

The command supports `--json` (`deleted`, `unknownPurged`, `unknownKept`) and `--config <path>`. Its plain-text result also reports how many unknown-outcome rows remain. Unsupported options, including `--dry-run`, are rejected; there is no dry-run mode. Do not delete the SQLite queue file to "fix" a duplicate-print warning. Both manual and 48-hour automatic cleanup retain historical rows without an execution claim token: a missing token alone cannot establish that the Gateway acknowledged the outcome.

Stale-Agent persistence converges every 15 seconds in ordered batches of 200 rows by default. `AGENT_PRESENCE_SWEEP_LIMIT` may set a positive batch size, capped at 5000. Multiple Gateway instances skip each other's locked candidates. Request-time availability still derives from heartbeat freshness immediately; a large outage backlog does not require one fleet-wide UPDATE.
