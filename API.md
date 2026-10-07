# Gateway API

The Odoo integration contract is intentionally small. Odoo owns business records, destination/report context, bindings and print intent. Gateway owns runtime agents, printers, queues and physical execution.

## Odoo API key rotation

Rotating an Odoo API key creates a new key and immediately removes write capability from the previous key. The previous key remains read-only for 60 minutes so in-flight Odoo status synchronization can reconcile jobs created under the old credential. After that grace period the previous key is rejected completely. Update the Odoo installation with the new key during the grace window before removing the old key.

## Authentication

### Agent
`Authorization: Bearer <agent-id>:<secret>`.

### Manager
`mgr_session` cookie or manager bearer session, according to `src/lib/manager-auth.ts`.

Manager fleet reads `GET /api/agents` and `GET /api/printers` are bounded per request (`limit` maximum 1000). Legacy `offset` pagination remains supported up to 10,000 for compatibility and scan protection. Fleets can exceed that size because resource entitlements may be `unlimited`; callers that need deeper traversal must use keyset pagination instead of ever-increasing offsets. Pass the previous page's final `createdAt` and `id` as `beforeCreatedAt` and `beforeId`. The pair is required together and cannot be combined with a non-zero offset. Responses remain JSON arrays for backward compatibility and expose `X-Has-More`; when another page exists they also expose `X-Next-Before-Created-At` and `X-Next-Before-Id`. Ordering is stable by `(createdAt DESC, id DESC)`. These authenticated fleet responses are `no-store`.

Fleet status fields are evidence-based. `status` is the current effective presentation state: stale or missing Agent/printer observations resolve to `unknown`, not `offline` or the last reported value. `reportedStatus` retains the last raw device/Agent report for diagnostics, and `freshness` (`fresh`/`stale`/`missing`) states whether that report can be treated as current. Agent reachability and physical printer state remain separate facts.

### Odoo
`Authorization: Bearer odoo_<key>` or `X-Api-Key: odoo_<key>`.

Odoo Gateway authentication is based on the Odoo installation API key. The Odoo database name is not used as an authentication requirement. Odoo may still send `X-Odoo-Database` for informational purposes; the Gateway ignores it for authentication.

The raw Odoo key is returned only when generated. Gateway persists only its cryptographic hash plus lifecycle metadata; rotated keys use a bounded read-only grace window before full invalidation.

## `GET /api/odoo/health`

Authenticated with the Odoo installation key. Returns the authenticated integration health, including its replicated Odoo activation state (`enabled`). This endpoint is used by the Odoo **Test Connection** button.

## `GET /api/odoo/printers`

Authenticated with the same Odoo installation key. Returns a sanitized list of non-retired runtime printers and agent display information. This is read-only runtime discovery for the Odoo Print Binding selector; the endpoint never creates or changes printers and does not return agent secrets.

## `POST /api/print/jobs`

Request:

```json
{
  "printerId": "runtime-printer-id",
  "documentType": "receipt",
  "destination": "Main POS",
  "payload": {
    "type": "pdf",
    "encoding": "base64",
    "data": "JVBERi0xLjQK..."
  },
  "expiresAt": "2026-09-07T15:00:00Z",
  "idempotencyKey": "stable-for-one-logical-print"
}
```

No Gateway branch ID, Gateway destination ID, Gateway document-type ID, agent provisioning data, or printer-creation data is accepted.

The Gateway validates the Odoo key, payload, expiration and idempotency before queueing the runtime job. The Odoo installation key is a credential for the Odoo integration API surface documented here. It is not a Manager or Platform credential and is not accepted by generic console endpoints. It is not restricted by document type. A created Odoo-originated job is stamped with the authenticated API-key identity. Status lookup is scoped to Odoo-originated jobs in the authenticated tenant after successful API-key authentication; `apiKeyId` must be present but is treated as credential provenance rather than an equality check against the current key, so credential rotation does not strand historical jobs. Internal Manager-created jobs without an Odoo API-key provenance remain outside the Odoo integration flow.

`201` means a new job was accepted. `200` means an idempotent retry matched an existing job and returns that job identity. A reused key with different routing/payload data returns `409 IDEMPOTENCY_CONFLICT`.

Typical failures include `400` invalid input, `401` authentication failure, `404` unknown runtime printer/job, `422 CAPABILITY_MISMATCH` when the payload cannot be delivered by the selected printer, `429 PRINT_JOB_RATE_LIMITED`, `503` runtime/queue availability failure and `500` internal failure. Gateway-enabled Odoo printing never converts these failures into browser/native printing.

## `GET /api/print/jobs?id=<jobId>`

Authenticated with the Odoo installation key. Returns the runtime status and routing identifiers for Odoo-originated jobs belonging to the authenticated tenant. Internal Manager-created jobs are outside this integration surface. A job belonging to another tenant, or a non-Odoo job in the same tenant, is returned as `404 Not found`. API-key rotation does not hide Odoo jobs created with the previous credential.

## Agent heartbeat pagination

`POST /api/agent/heartbeat` is the Agent runtime inventory and liveness contract. The `500` printer limit is a per-request page ceiling, not a tenant or Agent fleet-size ceiling.

The current Agent sends:
- `heartbeatPage`: 1-based page number.
- `heartbeatPageCount`: total number of pages in this heartbeat cycle.
- `inventorySnapshotId`: one safe token shared by all pages in a cycle.
- `inventorySnapshotVersion`: a positive int64 decimal **string**, shared by all pages. Never encode it as a JSON number: nanosecond-seeded values exceed JavaScript's exact integer range.
- `inventoryComplete`: whether the local registry was read authoritatively.
- `printers`: at most 500 entries per page and no more than 256 KB of serialized printer metadata per page.
- `desiredStateAcks`: at most 500 entries per page.
- `gatewayOwnedPrinterIds`: the Gateway-owned IDs represented on that page, used to preserve the manager-owned/deletion fence.
- `keepAliveJobIds`: the existing bounded execution keep-alive set.

Agents with more than 500 printers send multiple pages. The Gateway accepts legacy heartbeats without page fields as a single page for backward compatibility. On the current contract, the final page is the only page that returns the complete `desiredState` snapshot; the Agent applies that snapshot only after the final page succeeds.

Snapshot ordering is checked under the Agent row lock before any presence, metadata, liveness or keep-alive write. A first page must exceed the retained version; every continuation must use that exact version, token, page count and expected page. The version survives final-page completion and Gateway restarts. A stale, replayed or downgraded request returns `409 INVENTORY_SNAPSHOT_CONFLICT` with `minimumSnapshotVersion` as a decimal string. The Agent advances its process counter from that value and starts a new cycle, so clock rollback or a process restart does not require clock synchronization.

Only an ordered, versioned, complete and error-free final page can mark missing Agent-owned printers absent. Legacy clients without a version may add/refresh observations before the first versioned writer is accepted; they cannot declare absence. Once a versioned writer is established, versionless writes are refused. Deploy migration `0080`, then the Gateway, then upgrade Agents; downgrading an Agent requires deliberate re-pairing rather than weakening the retained fence.

Agent-owned printer registration remains subject to the tenant plan's `max_printers` entitlement. Exceeding that capacity returns `429 MAX_PRINTERS_EXCEEDED`; existing printer observations are not a substitute for entitlement and manager-owned printers remain governed by desired state.

## Runtime ownership boundary

Gateway APIs for Branches, business destinations, business document catalogs and Odoo-to-Gateway business synchronization are intentionally absent. Agents register runtime resources with Gateway; Odoo references those runtime printers only when creating bindings.

## Reliability contract

The Odoo addon commits a durable outbox row before making the HTTP submission. The same logical operation key is reused for retry attempts, but the value sent to Gateway is a deterministic company-namespaced digest because Odoo uniqueness is company-scoped while Gateway uniqueness is tenant-scoped. This prevents two Odoo companies under one Gateway tenant from colliding on the same caller-supplied idempotency key. Network timeouts are recorded as an unknown physical outcome instead of a definite failure. Gateway-side Odoo idempotency is tenant-scoped so credential rotation does not strand retries; Odoo status reads remain tenant-scoped after installation-key authentication so API-key rotation does not strand historical jobs.

## Customer SaaS authentication and billing

Customer authentication uses `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/verify-email`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, and `POST /api/auth/select-tenant`. The `/api/auth/me` browser probe also accepts Manager workspace sessions; their refresh stays at `/api/auth/manager/refresh`. Legacy manager bootstrap endpoints remain under `/api/auth/manager/*`.

Workspace lifecycle uses `POST /api/onboarding`. Team lifecycle uses `GET/POST/DELETE /api/team/invitations`, `POST /api/team/invitations/accept`, `GET/PATCH/DELETE /api/team/members`, and `POST /api/team/ownership`. Team collection reads are bounded and paginated: both GET routes accept `limit`/`offset` (default 50, maximum 100) and return `hasMore`, `offset`, `limit`, and the tenant-scoped `total` alongside the collection.

Billing uses `GET /api/billing/plans`, `POST /api/billing/checkout`, `POST /api/billing/portal`, `POST /api/billing/cancel`, `POST /api/billing/resume`, and `POST /api/billing/webhook`. Stripe webhook events are signature-verified and persisted by provider event ID before processing; the application database remains the local subscription/entitlement source of truth.

The public plan catalog is provisioned with `npm run db:provision-plans` using operator-supplied `STRIPE_PLAN_CATALOG` JSON. No Stripe Price IDs or commercial limits are hardcoded in the repository.

## `POST /api/print/jobs/batch-status`

Authenticated with the Odoo installation key. Request a batch of print job statuses. Max 100 job IDs per request.

Request:

```json
{
  "jobIds": ["job-1", "job-2"]
}
```

Response:

```json
{
  "jobs": [
    {
      "jobId": "job-1",
      "status": "success",
      "printerId": "runtime-printer-id",
      "agentId": "agent-id",
      "destination": "Main POS",
      "documentType": "receipt",
      "error": null,
      "deliveredAt": "2026-09-07T15:00:00.000Z",
      "ackedAt": "2026-09-07T15:00:05.000Z",
      "updatedAt": "2026-09-07T15:00:05.000Z"
    }
  ]
}
```
Only Odoo-originated jobs in the authenticated tenant are returned. The current installation key does not have to equal the key recorded on a historical job, so rotation does not strand status synchronization.

Discovery reports use the additive `errors: string[]` contract in `contracts/print-payload-contract.json` (maximum 64 messages, 2048 UTF-16 units each). The Gateway returns these in session `stats.errors`; optional unavailable device fields are omitted, and protocol defaults to `unknown`. Odoo consumes approved runtime printers, not discovery candidates or source diagnostics; no addon producer emits discovery reports.

Stripe subscription normalization supports both pre-Basil subscription-level periods and Basil+ `items.data[0].current_period_start/current_period_end`. Gateway checkout creates one plan item; its price and billing period come from the same item. Existing Gateway billing response/database field names are unchanged.

New physical dispatch requires an acknowledged, claim-fenced `printing` response (`success: true`, `status: "printing"`). Local delivery receipt age is diagnostic only; a buffered frame may already have a stale claim. An unacknowledged admission sends no hardware bytes. Printing that already crossed this boundary retains its durable outcome reporting through a later disconnect. Repeated admission for the same live printing claim is acknowledged without creating another job or physical attempt.

Printer destinations permit private IPv4 and IPv6 ULA (`fc00::/7`) or link-local literals across Gateway and Agent. Loopback, unspecified, multicast and instance metadata endpoints remain rejected; metadata rejection applies to equivalent expanded IPv6 spellings.

Terminal Agent reports echo their immutable attempt claim token. Matching closed-attempt SHA-256 evidence permits acknowledgement retries of the same terminal status only; it cannot authorize execution, replace evidence or extend reconciliation age. Agents retain terminal outbox tokens until the JSON response confirms success and the requested status. New claims clear closed acknowledgement evidence.

An Agent may return a delivered/ACKed `claimed` job before printing admission with a recognized pre-execution rejection reason and its current claim token. The atomic update requires remaining TTL/retry budget, clears delivery evidence and refunds the delivery attempt. Stale claims and attempts already admitted to `printing` reject this hand-back; explicit crash recovery remains separate.

Discovery provisioning creates manager-owned printers at desired revision 1 so the owning Agent receives and applies their newly allocated runtime IDs. Existing exact network endpoints, spooler queues and matching stable runtime identities converge instead of allocating duplicate targets. IPP IPv6 URLs retain brackets and separate resource paths.

Rediscovery invalidates candidate approval when transport, endpoint, queue, device class or capabilities change. The existing provisioned printer link remains historical evidence; its manager-owned configuration never changes implicitly. A changed candidate requires fresh review before provisioning.

Refresh rotation, password reset, membership edits, ownership transfers and workspace switching serialize on the affected users before family/token writes. Ownership transfers acquire both users in sorted ID order. A rotation either precedes a revocation (and its successor is revoked) or validates after the authoritative principal change.

Cached test-connection responses retain `live:false` and expose `printerLastSeenAt`/`printerObservationFresh`. Reachability requires fresh printer observation as well as a fresh online active Agent; a new Agent heartbeat alone cannot revive an old printer observation.

Billing status includes `entitlementBlocked`; `hasSubscription` matches enforcement: active/trialing need a live recorded period, past_due retains payment-recovery access, and an entitlement block disables all three.

Checkout intents persist `checkout_request_params` with their Stripe idempotency key before any external request. Recovery replays the original price, URLs and metadata, even after catalog/origin changes; the separately fenced tenant customer remains stable. Legacy creating intents without a snapshot return CHECKOUT_RECONCILIATION_REQUIRED and need Stripe/operator reconciliation, because their original accepted parameters cannot safely be reconstructed.

Checkout recovery also requires its PostgreSQL `checkout_intent_created_at` age to be under 23 hours. Stripe may prune idempotency keys after 24 hours; older or undated unresolved intents require reconciliation and are never automatically replayed or replaced.

Stripe subscription snapshots capture `stripe_state_revision` before retrieval and compare it under the authoritative row lock before applying. Concurrent commits force rollback and a bounded refetch outside the transaction; exhausted contention returns retryable 503. Lifecycle/checkout commits and explicit cancellation/resume advance the revision. A canceled identity remains terminal; replacement subscriptions retain their separate binding rules.

Changing a plan price affects future checkout while its retired Price IDs remain bound to that same plan for existing subscriptions. Catalog creation/update/provisioning share the historical uniqueness guard. Unknown or ambiguous price mappings remain entitlement-blocked.

Terminal history cleanup removes document payloads and timeline events, retaining compact completion receipts. Accepted operation keys remain reserved for the tenant lifetime: identical retries return the original terminal job; mismatched requests return 409. Integration lookups by job ID/key and batch status remain available after cleanup. Closed Agent status replays require the original owner and hashed claim token. Manager job detail reports archived=true when only the receipt remains; archived jobs cannot be reprinted without resubmitting document content as a new explicit operation.

Platform tenant/subscription lists accept bounded offset and search, return limit and hasMore, and sort by creation time plus tenant ID. Subscription filter accepts all/active/attention/other; search and filters apply before pagination. Directory controls navigate 100-row pages rather than silently truncating 300 records.

Desktop local discovery IPC preserves optional agentId metadata from CLI JSON; absent owner provenance cannot authorize a discovered USB/spooler selection for another Agent. Gateway USB registration uses numeric 16-bit VID/PID, never hexadecimal strings or null/NaN.


### Explicit resource deletion and browser workspace sessions
Dashboard deletion now permanently removes an authorized Agent and its owned printers, including online or retired Agents. Job payload/event rows are removed only after compact operation receipts reserve their accepted keys. Undelivered work is cancelled; work carrying delivery/execution evidence retains an unknown physical outcome. The transaction invalidates Agent access and publishes the existing cross-instance session notification.
`DELETE /api/odoo/keys` with `{id, remove:true}` erases active or revoked credentials atomically and removes them from the list. A nonusable history reference retains accepted job attribution and Odoo reconciliation; the original credential hash and all access are removed. Ordinary `{id}` revokes without deleting and advances the activation revision.
`GET /api/auth/me` accepts the same Manager/Customer workspace cookies as the console, returns `kind` and permission names, and never returns credentials. Refresh-kind hints on 401 guide the browser to the existing kind-specific refresh route; Manager refresh cookies are scoped to `/api/auth/manager`.
Dashboard result actions return `{ok:true,data}` or `{ok:false,status,code,error}` so expected failures are not thrown into React production error masking. Full unexpected server diagnostics remain only in Gateway logs.
