# Gateway API

The Odoo integration contract is intentionally small. Odoo owns business records, destination/report context, bindings and print intent. Gateway owns runtime agents, printers, queues and physical execution.

## Odoo API key rotation

Rotating an Odoo API key creates a new key and immediately removes write capability from the previous key. The previous key remains read-only for 60 minutes so in-flight Odoo status synchronization can reconcile jobs created under the old credential. After that grace period the previous key is rejected completely. Update the Odoo installation with the new key during the grace window before removing the old key.

## Authentication

### Agent
`Authorization: Bearer <agent-id>:<secret>`.

### Manager
`mgr_session` cookie or manager bearer session, according to `src/lib/manager-auth.ts`.

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

The Gateway validates the Odoo key, payload, expiration and idempotency before queueing the runtime job. The Odoo installation key is a credential for the Odoo integration API surface documented here. It is not a Manager or Platform credential and is not accepted by generic console endpoints. It is not restricted by document type. A created Odoo-originated job is stamped with the authenticated API-key identity. Status lookup is scoped to that API key; idempotency remains tenant-scoped so credential rotation can safely replay an existing logical operation. Internal Manager-created jobs may omit that identity and are not exposed through this Odoo status endpoint.

`201` means a new job was accepted. `200` means an idempotent retry matched an existing job and returns that job identity. A reused key with different routing/payload data returns `409 IDEMPOTENCY_CONFLICT`.

Typical failures include `400` invalid input, `401` authentication failure, `404` unknown runtime printer/job, `422 CAPABILITY_MISMATCH` when the payload cannot be delivered by the selected printer, `429 PRINT_JOB_RATE_LIMITED`, `503` runtime/queue availability failure and `500` internal failure. Gateway-enabled Odoo printing never converts these failures into browser/native printing.

## `GET /api/print/jobs?id=<jobId>`

Authenticated with the Odoo installation key. Returns the runtime status and routing identifiers only when the requested job was created with that same API key. A job belonging to another installation, or a legacy/internal job without an Odoo API-key identity, is returned as `404 Not found`.

## Agent heartbeat pagination

`POST /api/agent/heartbeat` is the Agent runtime inventory and liveness contract. The `500` printer limit is a per-request page ceiling, not a tenant or Agent fleet-size ceiling.

The current Agent sends:
- `heartbeatPage`: 1-based page number.
- `heartbeatPageCount`: total number of pages in this heartbeat cycle.
- `printers`: at most 500 entries per page and no more than 256 KB of serialized printer metadata per page.
- `desiredStateAcks`: at most 500 entries per page.
- `gatewayOwnedPrinterIds`: the Gateway-owned IDs represented on that page, used to preserve the manager-owned/deletion fence.
- `keepAliveJobIds`: the existing bounded execution keep-alive set.

Agents with more than 500 printers send multiple pages. The Gateway accepts legacy heartbeats without page fields as a single page for backward compatibility. On the current contract, the final page is the only page that returns the complete `desiredState` snapshot; the Agent applies that snapshot only after the final page succeeds.

Agent-owned printer registration remains subject to the tenant plan's `max_printers` entitlement. Exceeding that capacity returns `429 MAX_PRINTERS_EXCEEDED`; existing printer observations are not a substitute for entitlement and manager-owned printers remain governed by desired state.

## Runtime ownership boundary

Gateway APIs for Branches, business destinations, business document catalogs and Odoo-to-Gateway business synchronization are intentionally absent. Agents register runtime resources with Gateway; Odoo references those runtime printers only when creating bindings.

## Reliability contract

The Odoo addon commits a durable outbox row before making the HTTP submission. The same idempotency key is reused for retry attempts of that logical operation. Network timeouts are recorded as an unknown physical outcome instead of a definite failure. Gateway-side Odoo idempotency is tenant-scoped so credential rotation does not strand retries; Odoo status reads remain installation/API-key scoped.

## Customer SaaS authentication and billing

Customer authentication uses `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/verify-email`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, and `POST /api/auth/select-tenant`. Legacy manager bootstrap endpoints remain under `/api/auth/manager/*`.

Workspace lifecycle uses `POST /api/onboarding`. Team lifecycle uses `GET/POST/DELETE /api/team/invitations`, `POST /api/team/invitations/accept`, `GET/PATCH/DELETE /api/team/members`, and `POST /api/team/ownership`.

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
Only jobs matching the authenticated installation key are returned.
