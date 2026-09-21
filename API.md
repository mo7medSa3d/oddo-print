# Gateway API

The Odoo integration contract is intentionally small. Odoo owns business records, destination/report context, bindings and print intent. Gateway owns runtime agents, printers, queues and physical execution.

## Authentication

### Agent
`Authorization: Bearer <agent-id>:<secret>`.

### Manager
`mgr_session` cookie or manager bearer session, according to `src/lib/manager-auth.ts`.

### Odoo
`Authorization: Bearer odoo_<key>` or `X-Api-Key: odoo_<key>`.

Odoo Gateway authentication is based on the Odoo installation API key. The Odoo database name is not used as an authentication requirement. Odoo may still send `X-Odoo-Database` for informational purposes; the Gateway ignores it for authentication.

The raw Odoo key is returned only when generated. Gateway persists only its cryptographic hash and a revoke timestamp.

## `GET /api/odoo/health`

Authenticated with the Odoo installation key. Returns `{ "ok": true }` only for a valid, non-revoked key. This endpoint is used by the Odoo **Test Connection** button.

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

The Gateway validates the Odoo key, payload, expiration and idempotency before queueing the runtime job. A created Odoo-originated job is stamped with the authenticated API-key identity. Status lookup is scoped to that API key; idempotency remains tenant-scoped so credential rotation can safely replay an existing logical operation. Internal Manager-created jobs may omit that identity and are not exposed through this Odoo status endpoint.

`201` means a new job was accepted. `200` means an idempotent retry matched an existing job and returns that job identity. A reused key with different routing/payload data returns `409 IDEMPOTENCY_CONFLICT`.

Typical failures include `400` invalid input, `401` authentication failure, `404` unknown runtime printer/job, `422 CAPABILITY_MISMATCH` when the payload cannot be delivered by the selected printer, `429 PRINT_JOB_RATE_LIMITED`, `503` runtime/queue availability failure and `500` internal failure. Gateway-enabled Odoo printing never converts these failures into browser/native printing.

## `GET /api/print/jobs?id=<jobId>`

Authenticated with the Odoo installation key. Returns the runtime status and routing identifiers only when the requested job was created with that same API key. A job belonging to another installation, or a legacy/internal job without an Odoo API-key identity, is returned as `404 Not found`.

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
      "status": "completed",
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
Only jobs matching the authenticated installation key and authorized document types are returned.
