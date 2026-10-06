# AUDIT FINDINGS

## Confirmed and fixed — 2026-10-06

### P1 — Production Secure cookie could be disabled by stale environment override
`sessionCookieSecure()` honored COOKIE_SECURE=0 before checking NODE_ENV. Production now always returns Secure=true.

### P1 — Desktop Manager ProgramData trust-root lacked ACL hardening
`%ProgramData%\YaseirManager` contains the configured Gateway origin but previously relied on directory creation only. A pre-created or loosely-permissioned path could allow local origin tampering. The Manager now hardens ownership/DACL before reading or writing settings/logs and refuses reparse points.

### P1 — Logout could retain browser credentials during session-store outage
Generic, manager, and platform logout validated database-backed sessions before protected error handling. A PostgreSQL/session-store failure could return before Set-Cookie clearing. Validation failures now yield 503 while still clearing browser credentials.

### P2 — Stale printer protocol-alias unit fixture
The fixture used a removed printerType value and omitted required agentId. Runtime schema was correct; the test was updated without weakening validation.

## Reviewed with no confirmed defect in this batch

- Agent pairing: one-time code, collision fence, rate limit, tenant/billing lock, hashed Gateway secret.
- Workspace session/refresh families: rotation, reuse detection, lifecycle/membership checks, revocation.
- Billing/webhook identity and ordering fences.
- Tenant-scoped Agent/Printer/Discovery/Job object access and composite database FKs.
- Job physical-outcome/idempotency/retention boundaries.
- Odoo controller ACL/record-rule/runtime scope and encrypted Gateway credentials.
- WebSocket proxy/origin/auth/lifecycle/capacity/claim fencing.
- Tauri manager-token proxy boundary and Agent-console path allowlist.

## Open verification

Complete remaining HTTP route negative-auth audit and final-head CI/Docker/Windows/Security/Static Security verification.
