# Review Notes

## Confirmed Contracts

- Workspace browser management APIs use `validateWorkspaceManager` plus explicit RBAC; Odoo runtime APIs authenticate with tenant-scoped Odoo API keys.
- Odoo runtime Agent/Printer discovery is a control-plane prerequisite and may remain callable while the replicated `odooEnabled` flag is OFF; billing/tenant lifecycle still gate access.

## Cross-System Dependencies

- `/api-keys` browser page → `/api/odoo/keys` → `validateWorkspaceManager` → `integrations.read/manage` → tenant-scoped `api_keys` rows.
- Odoo Pair Agent wizard / runtime printer picker → `/api/odoo/agents` and `/api/odoo/printers` → Odoo API key → tenant billing/lifecycle → Gateway Agent/Printer inventory.

## Findings / Risks

- [FIXED] `/api/odoo/keys` and rotation were manager-cookie-only even though the browser integration UI runs under the workspace customer session contract.
- [FIXED] `/api/odoo/agents` and `/api/odoo/printers` rejected authenticated Odoo keys when `odooEnabled=false`, contradicting the Odoo pairing/discovery contract.
- [WATCH] Runtime execution, PostgreSQL, Windows/Tauri, and physical-printer paths still require external verification; source review cannot establish runtime PASS.

## Recheck Later

- `src/app/api/odoo/keys/route.ts` — verify browser customer-session 200/403 behavior at runtime.
- `src/app/api/odoo/agents/route.ts` / `src/app/api/odoo/printers/route.ts` — verify disabled-integration discovery against a live Odoo/Gateway/PostgreSQL stack.
- `src/lib/session-tokens.ts` / `src/lib/manager-auth.ts` — retain runtime coverage for family revocation and session-kind boundaries.
- [FIXED] `validateWorkspaceManager()` now falls through from an invalid manager cookie to a valid customer workspace session; valid manager sessions still retain precedence.
- [FIXED] `expired -> success` reconciliation now requires `claimedAt`, preventing an expired never-claimed job from being promoted to success by an Agent.
- [FIXED] `/api/team/ownership` now matches the workspace session boundary used by the Team UI and clears both session cookie pairs after ownership transfer.
- [WATCH] `/api/odoo/configuration` GET and `/api/onboarding` GET still use manager-only authentication; no current client call was found that requires these GET contracts, but they should be revisited if exposed to customer-session UI.

## 2026-09-26 continuation

### Confirmed Contracts
- Odoo API-key authentication establishes tenant identity; `print_jobs.api_key_id` is required to identify an Odoo-originated job, but the value is provenance rather than a current-key equality boundary.
- Server-rendered workspace pages should use the same manager-first/customer-fallback session precedence as workspace API routes.

### Findings / Risks
- [FIXED] Odoo `GET /api/print/jobs` and batch status are now tenant-scoped to Odoo-originated jobs (`apiKeyId IS NOT NULL`) without requiring equality to the current API key, preserving rotation while keeping internal Manager jobs outside the Odoo surface.
- [FIXED] `verifyWorkspaceTokenFromCookieValues()` could let a stale customer cookie shadow a valid manager workspace session.
- [WATCH] Runtime verification of rotated-key status synchronization and mixed-cookie sessions remains externally blocked.

## 2026-09-26 continuation — cross-system idempotency/auth review

### Confirmed Contracts
- Gateway print-job uniqueness is tenant-scoped; Odoo durable print-job uniqueness is company-scoped.
- Generic browser logout is a multi-surface operation: it may carry customer and/or manager session cookies and must revoke the corresponding refresh families before clearing cookies.

### Findings / Risks
- [FIXED] Odoo forwarded its company-scoped `idempotency_key` unchanged to the tenant-scoped Gateway. Two Odoo companies in one tenant could therefore collide on the same caller-supplied key. Evidence: `print_job.py::_idempotency_unique` versus `src/lib/print-job-service.ts` tenant/idempotency lookup. Fixed by deterministic company-namespaced SHA-256 key at the Gateway boundary; Odoo retries continue to reuse the same derived key.
- [FIXED] Generic `/api/auth/logout` previously validated/revoked only the customer session before clearing both cookie surfaces; manager-only or dual-cookie browser sessions could therefore leave the manager refresh family live. Fixed by independent customer/manager validation and family revocation before clearing both cookie pairs.
- [WATCH] Runtime proof of Odoo idempotency collision behavior and dual-cookie logout remains external; source contract and regression coverage are present.

### Recheck Later
- `odoo_addons/print_gateway/models/print_job.py::_gateway_idempotency_key` — verify the derived key remains stable across retries/restarts and stays within Gateway bounds.
- `src/app/api/auth/logout/route.ts` — verify live dual-cookie logout revokes both families in PostgreSQL.


### 2026-09-26 continuation — printer identity boundary

### Findings / Risks
- [FIXED] Agent USB discovery dedupe used raw USB serial as a physical identity key even though the discovery contract treats VID/PID + serial as the strong USB identity. Two distinct printer models sharing a serial value could therefore collapse during cross-source reconciliation. Fixed `physicalIdentityKey()` to include normalized VID/PID when available while preserving the established serial-only `StableIDFromUSB` namespace for persisted bindings. Added regression coverage for same-serial/different-model non-collision.
- [WATCH] Legacy/manual USB records without VID/PID still use the serial-only fallback; this is intentional compatibility behavior and should remain under review until all discovery sources can guarantee VID/PID.

### Recheck Later
- `agent/internal/printer/stable_id.go::physicalIdentityKey` — verify Windows discovery records consistently carry VID/PID before ever removing the compatibility fallback.

## 2026-09-26 continuation — permission, provenance, and recovery boundaries

### Findings / Risks
- [FIXED] `src/app/api/jobs/[id]/timeline/route.ts` exposed tenant-scoped job timeline data after workspace authentication but before enforcing `jobs.read`. Added the same explicit read permission used by the primary job route.
- [FIXED] `getDashboardState()` and `src/app/dashboard/page.tsx` could return/render Agents, Printers, and Job metadata to a workspace role lacking one or more corresponding read permissions. Added explicit `agents.read` / `printers.read` / `jobs.read` fences at both server-action and page boundaries.
- [FIXED] Odoo generic `requests.RequestException` submission fallback now records an ambiguous physical outcome and never auto-requeues/fails over when dispatch cannot be ruled out.
- [FIXED] Odoo terminal reconciliation now continues polling only the explicit ambiguous terminal classes and accepts `LATE_SUCCESS_POST_EXPIRATION:` only for `unknown` jobs; ordinary terminal rows remain fenced.
- [FIXED] Odoo Agent/Printer runtime discovery now treats missing/non-string lifecycle as inactive rather than defaulting to `active`.
- [FIXED] Odoo print-job GET/idempotency reuse paths keep the `apiKeyId IS NOT NULL` provenance boundary while allowing rotated credentials to reuse/read historical Odoo jobs; internal Manager jobs remain outside the Odoo API surface.
- [FIXED] Odoo Force Reprint now permits jobs whose stored Gateway failure proves `physical_outcome == unknown`; the form action visibility uses the physical-outcome field instead of only terminal status.

### Recheck Later
- `src/app/api/print/jobs/route.ts` — live PostgreSQL test should prove rotated-key replay, internal Manager collision rejection, and historical-job GET behavior end-to-end.
- `odoo_addons/print_gateway/models/print_job.py` — live Odoo/Gateway test should prove ambiguous transport never creates a second physical dispatch and that late-success reconciliation converges once.
- `src/app/dashboard/page.tsx` / `src/app/actions.ts` / `src/app/api/jobs/[id]/timeline/route.ts` — live HTTP/RBAC matrix should prove billing-only and mixed-role sessions receive the documented 403/redirect behavior.
- [FIXED] Force Reprint eligibility is intentionally narrower than generic `physical_outcome == unknown`: successful jobs still report physical output as unverified for observability, but the operator reprint action remains limited to `partial`, `unknown`, or `failed + unknown physical outcome` so a normal success cannot silently become a second print candidate.
## 2026-09-26 continuation — adversarial claim-state review

### Findings / Risks
- [FIXED] Agent `PATCH /api/agent/jobs` could mutate a queued/tokenless job directly to `printing`, `success`, or `failed` because the generic stale-claim guard only rejected mismatched tokens when a row already carried a non-null token. The authenticated Agent only needed the job ID.
- [FIXED] `expired -> success` reconciliation could lose its execution fence after the maintenance sweep cleared `claim_token` while leaving `claimed_at`, allowing an authenticated Agent with no token to promote an expired job inside the five-minute window.

### Recheck Later
- `src/app/api/agent/jobs/route.ts` — runtime PostgreSQL tests should verify queued/tokenless mutations return 409 and only the exact claim token can advance lifecycle state.
- `src/lib/job-maintenance.ts` — runtime sweep/reconciliation race should verify ambiguous expired attempts retain their fence only until the five-minute reconciliation window, then clear it.
## 2026-09-26 continuation — adversarial pre-execution requeue fence

### Findings / Risks
- [FIXED] A valid Agent claim token was sufficient for `claimed -> queued` even after Gateway delivery/ack evidence existed. The route trusted the Agent-provided pre-execution rejection reason without atomically proving that no delivery had crossed the Gateway → Agent boundary.

### Recheck Later
- `src/app/api/agent/jobs/route.ts` — runtime race test should prove `claimed -> queued` is accepted only while both `delivered_at` and `acked_at` are NULL.


## 2026-09-26 continuation — adversarial legacy lease/reprint review

### Findings / Risks
- [FIXED] Agent heartbeat previously accepted tokenless `keepAliveJobIds` for legacy `claimed/printing` rows and refreshed `updated_at`, allowing a tokenless stale claim to avoid recovery indefinitely. Lease refresh now requires an exact `(jobId, claimToken)` match; tokenless legacy rows are left for the sweeper.
- [FIXED] Gateway operator reprint surfaces accepted normal `success` jobs because `derivePhysicalOutcome(success) == unknown`; this contradicted the existing reprint invariant that successful jobs are not operator reprint candidates. The API route, Server Action, and Dashboard now reject/hide successful jobs while retaining explicit recovery for failed/expired terminal cases.

### Recheck Later
- `src/app/api/agent/heartbeat/route.ts` — live stale-claim recovery with migrated legacy rows.
- `src/app/api/jobs/[id]/reprint/route.ts` / `src/app/actions.ts` — runtime RBAC and terminal recovery behavior.

## 2026-09-26 continuation — transaction / side-effect adversarial pass

### Findings / Risks
- [FIXED] Odoo terminal reconciliation excluded `failed` jobs carrying `UNKNOWN_PARTIAL_DELIVERY` when `gateway_job_id` already existed. Gateway can legally reconcile that exact attempt to `LATE_SUCCESS`; the manual/cron selectors must therefore keep this failed state pollable. Updated `_needs_gateway_status_reconciliation()` and the `cron_sync_status()` selector.
- [FIXED] Agent local `BeginPrint()` now returns an explicit `ErrAlreadyPrinting` when the exact live claim token is already in the local `printing` ledger. Production `dispatchJobWithContexts()` already has an in-flight gate, so this is a primitive-level invariant defense rather than a newly reachable production bypass.
- [WATCH] Ambiguous invitation-email delivery intentionally leaves the durable invitation active after a provider timeout/connection error. This preserves replayability but can temporarily strand an existing active invitation until it is resent/revoked administratively.

### Recheck Later
- `odoo_addons/print_gateway/models/print_job.py::_needs_gateway_status_reconciliation` / `cron_sync_status` — runtime test that `UNKNOWN_PARTIAL_DELIVERY` → Gateway `LATE_SUCCESS` converges exactly once.
- `agent/internal/queue/queue.go::BeginPrint` — keep the primitive duplicate-print guard aligned with every future production caller.
- `src/app/api/team/invitations/route.ts` — consider a bounded resend/recovery mechanism if invitation-provider ambiguity becomes a product requirement.

## 2026-09-26 continuation — transaction / side-effect final pass

### Findings / Risks
- [FIXED] Odoo ambiguous submission recovery preserves `UNKNOWN_SUBMISSION_OUTCOME` after a transient/first `404` lookup; deterministic company-namespaced Gateway idempotency remains the surviving remote-operation identity until `gateway_job_id` is recovered.
- [WATCH] Invitation email provider ambiguity intentionally leaves a committed invitation active when the provider response is uncertain; no automatic resend is attempted, so an operator recovery/resend path may be desirable later.

### Recheck Later
- `odoo_addons/print_gateway/models/print_job.py::_lookup_gateway_job_for_ambiguous_submission` — live response-loss/404/recovery race should prove convergence without duplicate Gateway creation.
- `src/lib/billing-operation.ts` / `src/app/api/billing/webhook/route.ts` — live Stripe duplicate/out-of-order webhook and ambiguous mutation responses remain runtime-only validation points.
- `agent/internal/queue/queue.go` / `agent/internal/agent/agent.go` — live SQLite crash/restart plus physical printer tests remain required to prove the persisted local outbox and printer-side ambiguity protocol under actual process crashes.

## 2026-09-26 continuation — transaction / side-effect adversarial pass

### Findings / Risks
- [FIXED] Printer certification payload was not deterministic for an explicit `Idempotency-Key`: it embedded `requestId` and wall-clock time, so a response-loss retry with the same key produced a different idempotency fingerprint and `IDEMPOTENCY_CONFLICT`. Fixed payload construction to derive printable content only from stable request/key inputs; request correlation remains in logs/timeline.
- [FIXED] `reprint_after_crash=true` was documented as Gateway lease reclaim but stale `printing` recovery actually terminalized the job as failed/unknown, so the real post-restart path never redelivered the job. Added an explicit fenced `printing -> queued` crash-recovery transition requiring the exact preserved claim token, live TTL, and retry budget; delivery attempts are not refunded because the prior attempt crossed the physical boundary.

### Recheck Later
- `src/app/api/printers/[id]/certify/route.ts` — runtime retry-after-response-loss should reuse the same certification job for an identical idempotency key.
- `src/app/api/agent/jobs/route.ts` + `agent/internal/agent/agent.go::recoverInterruptedJobs` — runtime restart race should prove the explicit crash-reprint path creates a new fenced attempt and never reuses the old claim token.

## 2026-09-26 continuation — source integrity / test contract

### Findings / Risks
- [FIXED] `tests/production-hardening-contract.test.ts` contained malformed string literals in an existing Agent panic regression block (`printing` / `failed` quoting) and one undefined `panicMsg` expression. The test file could not be parsed by TypeScript. Fixed the assertions to match the actual Agent panic source.

### Recheck Later
- `tests/production-hardening-contract.test.ts` — execute through Vitest when repository dependencies are available; current pass verifies TypeScript parsing only because `node_modules` is absent.
