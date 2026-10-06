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


### P1 — Heartbeat rejected current TCP/Windows-spooler connection aliases
The desktop/CLI legitimately emits `connectionType=tcp` and legacy installations may emit `connectionType=windows_spooler`. Heartbeat normalization only canonicalized those aliases when they arrived through the legacy `type` field, so otherwise-valid printers could exist locally but be skipped by Gateway inventory. Both current and legacy fields now canonicalize to `network` / `spooler`, with an integration regression covering persistence.

### P1 — Manual Agent registry accepted non-executable transport/protocol contracts
`RegisterManual()` persisted arbitrary connection/protocol strings without sharing the Agent runtime validator. This allowed a CLI/manual printer to be saved locally while being impossible to construct or rejected later by heartbeat. Manual registration now canonicalizes aliases, normalizes USB driver queues to spooler, and reuses `config.ValidatePrinterConfig()` before persistence.

### P2 — Windows Rust logger harness drifted behind ACL helper contract
The production logger gained Manager ACL helper calls, but `src-tauri/tests/audit_logging.rs` mocked only the old data-root function. Windows CI therefore failed before installer construction. The harness now exposes the same security-helper surface without weakening production ACL enforcement.


### P1 — Direct USB ZPL/TSPL validated but rejected by the runtime backend
The Agent configuration validator and Gateway capability matrix allowed direct USB byte transports declared as ZPL or TSPL, but the Agent factory and USB `SupportsKind` implementation accepted only RAW/ESC-POS. A printer could therefore configure and synchronize successfully and fail only at physical dispatch. Direct USB now executes all four explicitly declared byte languages (raw/escpos/zpl/tspl); Windows local diagnostic tickets are protocol-aware.

### P1 — Local ZPL/TSPL diagnostic names could inject printer-language commands
The generic diagnostic text sanitizer removed C0 controls but not ZPL command delimiters or TSPL quoted-field delimiters. A crafted Windows queue/display name could alter the local Agent test ticket. Protocol-specific sanitizers now strip ZPL command delimiters and neutralize TSPL quotes/backslashes, with injection regressions.

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
