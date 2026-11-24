# Security Architecture

> See also: [ARCHITECTURE.md](./ARCHITECTURE.md) § 5

## Authentication

### Agent Authentication
- Format: `Bearer {agentId}:{secret}`
- Secret stored as SHA-256 hash
- Comparison: SHA-256 of provided secret vs stored hash using `timingSafeEqual` on both digests
- Lifecycle check: agent must be `active`, tenant must be `active`

### API Key Authentication (Odoo → Gateway)
- Format: `Bearer {api_key}`
- Key stored as a SHA-256 hash of the full credential
- Scoped to tenant via `api_keys.tenant_id`

### Customer Authentication
- Email/password with Argon2id hash (legacy scrypt hashes auto-upgraded on login)
- Email verification required before full access
- Email verification, password recovery and initial password-setup proofs use single-use SHA-256-hashed tokens with a maximum ten-minute lifetime. Issuance, preflight and atomic consumption use PostgreSQL time. The consumer also caps age from the original creation timestamp, rejects future creation timestamps and preserves a shorter stored expiry, including for outstanding tokens issued under an older policy. These mailbox proofs cannot be substituted for a login session or current-password confirmation. Expired reset/setup pages provide an explicit link to request a new reset email; verification pages retain the resend path. Delayed email delivery does not extend proof authority.
- Mailbox-owner password setup, password reset and platform bootstrap screen common/contextual and compromised passwords without sending plaintext or the full hash to a provider. Provider failure blocks new password selection; it does not disable existing sign-in. See [password screening](./security/PASSWORD_SCREENING.md) for the bounded protocol, corpus provenance and exact-string handling.
- Rate limiting on authentication-adjacent attempts uses the existing PostgreSQL dual-key reservation design (`auth_rate_limits`): account key always, trusted-proxy IP key when available.
- Rate-limit responses after reservation expose `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and epoch-second `X-RateLimit-Reset`, with `Retry-After` on throttled responses.
- Account-scoped failures keep the existing 5/10/15/20 progressive curve.
- Trusted-proxy IP failures use a separate NAT-tolerant 20/30/40/50 progressive curve, so a shared source address can absorb normal multi-user bursts without triggering the account-style lock too early.

### Manager Sessions
- v2 access sessions use versioned HS256 JWTs with a 15-minute lifetime and explicit session kind, JTI, SID, and refresh-family identifiers. Access tokens are stateless and are not stored in the refresh-token ledger.
- v2 refresh sessions are opaque random secrets; PostgreSQL stores only SHA-256 token hashes. Workspace families have a 30-day absolute lifetime, a 30-minute inactivity limit, and a 5-second ordinary-refresh rotation grace window. Platform families have an eight-hour absolute lifetime and require thirty-minute activity freshness; background refresh does not extend activity.
- A refresh token presented after the grace window is treated as reuse/replay: the entire family is revoked, `auth.refresh.reuse_detected` is audited, and a notification email is attempted when an account email is available.
- Refresh rotation revalidates the live security principal (tenant lifecycle, tenant membership/role, verified customer email, or Platform Owner status) before minting a new access token.
- Password reset revokes every refresh family for the affected user.
- Production access and refresh cookies use `__Host-` names, `Secure`, `HttpOnly`, `Path=/` and no Domain attribute. Access cookies use SameSite=Lax; refresh cookies use SameSite=Strict. Distinct manager/customer/platform names preserve kind isolation. Production never accepts former unprefixed or `__Secure-` cookies; authentication transitions expire their former scoped names. This is an intentional sign-in cutover. Development keeps the old names and narrow refresh paths for local HTTP use.
- The packaged desktop uses its paired Agent identity through the bundled Agent CLI. The Tauri renderer supplies bounded request parameters to the native bridge, not Agent credentials or manager refresh headers (`src/desktop/lib/ipc.ts`, `src-tauri/src/commands.rs`). It does not use the browser's manager-refresh session flow.
- Pre-v2 manager/customer sessions and workspace families without persisted policy are denied after migration `0091`; fresh password sign-in is required. Every legacy platform session and every platform family without persisted password/session policy is denied; administrators must sign in with their password.
- Session kinds are explicit: Platform APIs accept only v2 `kind=platform`; tenant-scoped Workspace APIs explicitly accept v2 `kind=manager` or `kind=customer` because both represent authenticated workspace principals with the same tenant/role authorization model. Customer authentication endpoints generate `kind=customer`, while manager login generates `kind=manager`. A v2 token never falls through into legacy validation as a different session kind.
- Legacy `manager_sessions` rows remain only for revocation and cleanup. `platform_sessions` rows remain only for revocation and cleanup.
- New session issuance has no write path into `manager_sessions` or `platform_sessions`; those tables are retained only for pre-v2 revocation/GC. The unused `manager-session-tx` adapter was removed after a repository-wide caller scan found no external callers.
- Refresh-family rotation and family revocation use a PostgreSQL transaction-scoped advisory lock keyed by `family_id`, preventing concurrent rotation/replay/logout operations from bypassing family-wide revocation.
- Tenant suspension/deletion revokes all v2 refresh families for that tenant; password reset revokes all refresh families for the affected user. Request-admission classification recognizes the shared production cookie names (`__Host-mgr_session`, `__Host-cust_session`, `__Host-plt_session`) and separately configured nonproduction names.
- Gateway housekeeping runs on the existing 5-minute in-process maintenance loop; expired refresh-token cleanup was added to that existing loop rather than introducing a new scheduler.
- `scripts/acceptance/platform-browser.mjs` exercises production HTTPS cookies, password login/confirmation, privileged mutations, expiry, session revocation and cross-origin refusal with a real Chromium browser and a disposable database. Its scoped result must be read from the release evidence. It uses an ephemeral loopback certificate pin, not public PKI, and does not establish deployed proxy acceptance.

### Rate-limit failure mode
Authentication-adjacent routes keep PostgreSQL-backed rate limiting fail-closed. If `reserveAuthAttempt` cannot obtain a decision because the limiter store is unavailable, the route returns HTTP 503 and does not attempt authentication without rate-limit protection. This prevents an attacker from deliberately disrupting the limiter store to manufacture a fail-open bypass.

The availability tradeoff is intentional: legitimate login, registration, password-reset, and verification-resend requests can be temporarily blocked during a rate-limiter-specific PostgreSQL failure. PostgreSQL is already a hard dependency for Gateway authentication and most other Gateway operations, so a limiter-store outage is expected to correlate with a broader database availability problem in which authentication would not be reliably completable anyway. No narrowly-scoped fail-open exception is currently justified.

### Reverse Proxy Trust
- `TRUST_PROXY_SECRET` header validated on every request EXCEPT the two
  unauthenticated liveness probes `GET /api/health` and `GET /api/live`
  (server.ts proxy bypass — intentional so load balancers can probe without the
  secret; neither probe returns sensitive data)
- Minimum 32 characters, reject known placeholder values
- Required for production mode (`NODE_ENV=production`)

## Rate Limiting

| Scope | Mechanism | Parameters |
|-------|-----------|------------|
| Auth-adjacent endpoints | PostgreSQL dual-key reservation | Account key always; trusted-proxy IP key when available; 15-minute window |
| Auth response metadata | Compatibility response headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, epoch-second `X-RateLimit-Reset`, plus `Retry-After` when throttled |
| Rate-limit storage failure | Fail closed | Authentication-adjacent requests return HTTP 503 rather than bypassing the limiter; no fail-open exception |
| WebSocket upgrade | Per-IP rate check | At upgrade time |
| WebSocket messages | Per-agent token bucket | 20 capacity, 5 refill/s |
| Print job admission | Atomic tenant plan entitlements | `max_jobs_per_minute` and `max_concurrent_jobs` are enforced inside the PostgreSQL transaction that creates/claims work; billing-period print credits are reserved atomically |
| Heartbeat payload | Schema/size validation | Gateway rejects oversized or malformed control-plane payloads before applying state |

## Input Validation

- **API input validation**: Zod schemas are used for structured request bodies/parameters; endpoints with only simple probes, fixed identifiers, or security-sensitive primitive checks use explicit type/length validation.
- **Print payloads**: Database CHECK constraint (`payloadContractCheck`)
- **Protocol enforcement**: Printer capability gating prevents incompatible routing
- **ZPL/TSPL/ESC/POS**: Character sanitization prevents command injection
- **SQL**: Value inputs remain parameterized; dynamic SQL identifiers are composed with `psycopg2.sql.Identifier()` and `SQL(...).format()`, never interpolated as raw identifiers.
- **Report IDs**: Odoo-side report interception validates selected record IDs before routing; the native `/report/download` controller remains untouched

## Tenant Isolation

- Application-level: Tenant-scoped routes and services derive tenant context from the authenticated principal and apply tenant/ownership predicates. Global account lookup, authorized Platform operations, and maintenance queries have different scopes; this is application-enforced isolation, not PostgreSQL row-level security.
- Database: Composite FK constraints enforce tenant consistency on the relations they cover. Relations with single-column references, such as a capture's API key reference, additionally rely on service-layer ownership checks before insertion.
- Auth: Tenant context derived server-side, never from client-supplied values
- Session: Tenant bound at authentication, not per-request

## Audit Trail

The `audit_events` table records:
- Actor type (user, agent, system, platform)
- Actor ID
- Action (e.g., `agent.registered`, `billing.checkout.session.completed`)
- Resource type and ID
- Metadata (JSON)

Persisted audit rows are durable, but not every business operation and audit write share one transaction. For example, `src/lib/agent-control.ts` records pairing-code creation after the business transaction and logs an audit-write failure without rolling back that transaction. Audit availability must therefore be monitored independently.

## Secrets Management

- Never log raw API keys, agent secrets, passwords, or pairing values
- Pairing codes are single-use with expiry
- Agent secrets are hashed at creation, raw value shown once
- Environment secrets validated on startup (reject placeholders)

### Credential hashing and entropy

Hashing strength is chosen per credential, not uniformly:

| Credential | Entropy | Stored form | Rationale |
|---|---|---|---|
| Agent bearer secret | 192-bit random | SHA-256 | High-entropy random value: no dictionary to attack, so a slow KDF only adds latency. Compared in constant time. |
| Odoo API key | 256-bit random | SHA-256 | Same as above. |
| Customer/manager password | human-chosen | Argon2id | Low-entropy, user-chosen: needs a slow memory-hard KDF plus a per-user salt. |
| Pairing code | ~30-bit, human-typed | HMAC-SHA256 over a server-side pepper | The only low-entropy machine-issued credential. A database leak must not be enough to reverse it, so the stored hash is keyed with a pepper derived (HKDF) from `GATEWAY_JWT_SECRET`. |

Gateway pairing-code hashes are keyed with an HKDF-derived pepper from `GATEWAY_JWT_SECRET`; the Gateway fails closed when that secret is unavailable. The separate direct Odoo Agent pairing endpoint uses an HKDF-derived HMAC key from the deployment-managed `ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V{n}_B64` root described in `INSTALLATION.md`. Neither path falls back to an unkeyed digest. Rotating the corresponding key invalidates outstanding pairing codes; they are short-lived, single-use, and must be re-issued after rotation or this hardening update. Odoo's direct registration endpoint still requires edge/database-backed request throttling as a separate defense against online guessing.

### Agent credential at-rest threat model

- Windows: `agent-secrets.dat` is DPAPI-sealed (`LOCAL_MACHINE` scope, so the
  LocalSystem service and the user-context desktop manager share it) and the
  file/directory carry restrictive Windows DACLs (`EnsureSecureFileACL`).
  Residual risk: any local principal that can read the file can DPAPI-decrypt
  it under machine scope. Mitigation is host access control; a local
  administrator is already outside the threat boundary.
- POSIX (Linux/arm64): no sealed storage exists; the file is base64-framed
  with `0600` permissions only. `SaveSecret` logs an explicit warning.
  Deployments must use full-disk encryption and restrict host access.
- Egress: the Gateway control-plane HTTP/WebSocket clients never inherit
  `HTTP(S)_PROXY` unless `YASEIR_AGENT_ALLOW_PROXY=1` is set, so Bearer
  credentials and print payloads are not routed to a proxy by default.


## Pairing and Job Delivery

Agent pairing codes are short-lived, hashed, and single-use. Successful pairing mints the long-lived Agent credential; the pairing value is not the Agent identity.

Pairing rate limiting includes a source-IP budget and a bucket keyed by the presented code's hash. The latter limits repeated attempts with the same presented value; distinct guesses use distinct buckets, so it does not by itself aggregate distributed guessing against all valid codes.

Gateway print delivery retains claim-token fencing, stale-claim recovery, and PostgreSQL `SKIP LOCKED` coordination. Jobs with uncertain physical outcomes remain unknown until a later reconciliation establishes the result; they are not blindly retried.

## Odoo Gateway Credential Protection

The Odoo-to-Gateway installation credential is stored as authenticated ciphertext using AES-256-GCM. The encryption root is deployment-managed and must not be stored in PostgreSQL, source control, the addon, or the same backup set as the database.

Configure the deployment-managed credential key versions before installing or upgrading the addon:

- `ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION`
- `ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64` (base64-encoded 32-byte key)
- Additional versions follow the same naming pattern.

Generate key material outside the repository and inject it through the deployment secret store. Never place actual key material in committed `.env` files, documentation, database backups, or logs.

Missing or invalid key material must fail closed during credential migration or use; there is no plaintext fallback. Credential rotation is performed by provisioning the new key version, switching the active version, completing re-encryption, and only then retiring the old version.


### Alerting boundary
The `audit_events` table is a durable audit trail, not an alerting system. The current repository exposes the audit feed to Platform Owners, but does not include a configured real-time alert sink/provider. Operational alerting for high-severity security events remains an explicit deployment/infrastructure responsibility; it must not be inferred from audit writes alone.

### Rate-limit storage failure policy
The Gateway deliberately keeps authentication rate limiting fail-closed. If the PostgreSQL reservation operation fails, the affected authentication-adjacent request returns HTTP 503 rather than proceeding without an authoritative limiter decision. This prevents an attacker from attempting to bypass brute-force protection by disrupting the limiter store. The tradeoff is that legitimate authentication traffic can be temporarily blocked during a limiter-specific PostgreSQL failure. PostgreSQL is already a hard dependency for Gateway authentication and most other control-plane operations, so a limiter-storage outage is expected to correlate with a broader database availability problem where authentication cannot be completed reliably anyway. No narrowly-scoped fail-open exception is justified by the current architecture.

## Platform password authentication and session management

Verified Platform Owners sign in with email and password and immediately receive the dedicated platform access/refresh cookie pair. A workspace owner or administrator cannot obtain platform authority through their workspace role. Issuance locks the current account and compares an internal proof of the password verification to its current password hash; caller-supplied IDs, stale proofs or a hash change during issuance cannot mint authority. The durable platform policy stores a one-way fingerprint of the salted password verifier, not a password or reusable login credential. Access, refresh, session inventory and transactional mutation checks compare that fingerprint to the current verifier and recheck verified owner status. See `src/lib/platform-auth.ts`, `src/lib/platform-session-security.ts` and `src/lib/session-tokens.ts`.

Privileged platform writes require a current platform session for the same account, with the exact session SID and family locked through commit. No password re-confirmation is requested: a valid, non-expired, non-revoked session authorizes sensitive platform actions directly. `/platform/security` lists and revokes the account's sessions without a password prompt; every revocation is audited. Background status and refresh never advance activity.

Workspace Settings and Platform Security show only the signed-in account's live sessions across its workspaces and customer/manager/platform sign-in types. Workspace revocation requires only the current session. Ending a platform family requires a current same-account platform session. Neither inventory endpoint discloses or revokes another user's family. These are separate checks from workspace role permissions.

Migration `0093_password_only_authentication` removes the former factor stores while preserving accounts, password hashes, memberships, refresh families, revocation state and original session deadlines. Stop every older instance before applying it. The migration is transactional, uses no cascading drops, and refuses unexpected dependencies. Old migration hashes remain immutable. See `MIGRATION.md` for the upgrade and restore boundary.

This is single-factor authentication for every human role. There is no second password proof for sensitive actions: a valid session alone authorizes them, so a stolen live session can act until the session expires or is revoked. A login password does not protect an account when an attacker knows the password. Phishing, keylogging, password reuse and mailbox compromise remain material risks, particularly for the cross-tenant Platform Owner. Rate limits, strong password hashing, screened new passwords, secure cookies and session controls do not provide MFA or phishing resistance. The mandatory-MFA requirement ASVS V6.3.3 is an explicit unmet requirement for this product policy; no ASVS Level 2 compliance or certification claim is made. See [password authentication policy](docs/PASSWORD_AUTHENTICATION.md).

## Dependency update admission

The locked dependency graph is installed with `npm ci`. Routine npm resolution and Dependabot version updates wait seven days after publication (`.npmrc` and `.github/dependabot.yml`). This delay is an additional supply-chain control, not a vulnerability scanner or a reason to leave a known vulnerability unpatched. GitHub Dependabot security updates do not use its version-update cooldown.

For an urgent verified npm security fix younger than seven days, record the advisory, exact package/version, provenance and regression results; use a one-command `npm install --save-exact package@version --min-release-age=0` in the isolated remediation branch, review the resulting lockfile, and rerun the complete applicable gates. Do not add permanent global exclusions or hide scanner findings. The repository-pinned toolchain is npm 12.2.1 (`package.json`); older clients must be checked for support of `min-release-age` before they resolve new versions. The locked-install compatibility check is recorded separately from a full install with lifecycle scripts.

References: [npm configuration](https://docs.npmjs.com/cli/v11/using-npm/config/) and [Dependabot cooldown](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown).

## Human workspace inactivity (no password step-up)

Customer and manager access, refresh and transactional mutation guards require a matching `workspace_session_security` row, a live exact refresh-token SID, current tenant membership/role and the current password-verifier snapshot. The database clock enforces thirty minutes without foreground activity and the original thirty-day absolute lifetime. Missing state, expired state, future timestamps and changed credentials fail closed. Background GETs, session probes and refresh never record activity. The AppShell sends a throttled activity request only on trusted input in a visible document. Successful human mutations also record activity inside their transaction. Activity cannot revive an expired family.

Tenant settings, team/role changes, Agent pairing/lifecycle administration, printer configuration, job retry/cancellation, integration credentials/bindings and billing changes require a live authorized session; no password confirmation is requested for any of them. Ordinary reads and inventory remain available to a live authorized session. An expired or revoked session fails authentication and the user signs in again; no destructive request is retried automatically after a session error. Session revocation requests check the configured origin and use durable rate limits where applicable.

Fresh email/password login atomically replaces only the presented same-kind, same-principal and same-tenant family, preserving other devices and scopes. A multi-workspace account receives a one-use signed chooser before its selected tenant session is created; this preserves the original password-verification time. Workspace switching and invitation acceptance carry the source login timestamp and earliest deadline into the destination family, so they cannot extend the original deadline. The development/test environment-manager path remains opt-in, bound to its current configured username, tenant and password verifier, and forbidden in production. Pre-policy/v1 sessions require sign-in. Paired Agent APIs retain their separate machine-credential policy.

## Session lifetimes, cookies and refresh-failure codes (as implemented)

This section documents the code as it stands; it makes no claim about client
UX behaviour (wording, redirects and retries live in client code).

### Lifetimes

| Item | Workspace (manager + customer) | Platform owner |
|---|---|---|
| Access token | 15 min (`ACCESS_TOKEN_TTL_SECONDS`, `src/lib/session-tokens.ts`); `exp - iat` must equal 900 s | 15 min, same exactness rule |
| Idle timeout | 30 min since `last_seen_at` (DB clock, `WORKSPACE_IDLE_MS`) | 30 min since `last_seen_at` (`PLATFORM_SESSION_IDLE_MS`) |
| Absolute lifetime | 30 days from family creation (`REFRESH_FAMILY_TTL_MS`); refresh never extends it, and a persisted shorter deadline also wins | 8 h from family creation (`PLATFORM_SESSION_TTL_MS`) |
| Step-up (password-proof freshness) | REMOVED — no password re-confirmation is requested for any action while the session is valid | REMOVED — same |
| Remember Me | NONE — no flag exists in any login UI or login API, and none was added. Adding one would create a second session system, so every family gets the absolute lifetime above whether or not the user wanted persistence. | NONE (same) |

Idle extension asymmetry: workspace `last_seen_at` is written only by
`POST /api/auth/activity` with `{ touch: true }`, called only on trusted
input events (pointerdown/keydown/wheel/touchstart) in a visible document,
at most once per 60 s. Refresh, probes and polling never extend it.
Platform data requests do extend `last_seen_at`, except `/api/platform/auth/me` and
`/refresh`.

### Refresh rotation and revocation (unchanged by error-code differentiation)

- Storage: SHA-256 hash only (`tokenHash`); presented tokens are 32 random
  bytes, base64url. No token plaintext is stored, logged or returned in an
  error body.
- Every successful refresh rotates: a new row in the same family, the old
  row stamped `replaced_by` / `replaced_at`.
- Grace: 5 s (`REFRESH_ROTATION_GRACE_MS`). A replaced token presented
  within grace rotates again and revokes the previous successor
  (`rotation_grace_superseded`); the grace window is not extended.
- Reuse: a replaced token presented after grace revokes the whole family
  (`refresh_reuse_detected`), writes an audit event behind a savepoint so
  the revocation survives an audit-write failure, and attempts a
  notification email to the stored address.
- Other family revocations on refresh failure: workspace policy failure
  (`workspace_session_expired`, covering idle expiry, credential-version
  mismatch, tenant suspension, membership loss and missing policy state)
  and principal failure (`principal_invalid`) revoke the whole family.
  Absolute expiry revokes with `absolute_expired`. Logout, login
  replacement, tenant switch (source family only) and session-inventory
  actions revoke with their own recorded reasons.
- Failed refresh always answers 401 and clears both cookie pairs of that
  kind; clearing on failure is intentional (dead cookies are not kept).
  Success behaviour and success bodies are unchanged.

### Cookies (all HttpOnly, never in localStorage/sessionStorage)

Names are `__Host-` prefixed in production, bare otherwise
(`sessionCookieName`, `src/lib/session-config.ts`). Secure is always on in
production; in non-production only with `COOKIE_SECURE=1/true`.

| Cookie | Path: production | Path: non-production | SameSite | Max-Age / Expires |
|---|---|---|---|---|
| `mgr_session` / `cust_session` / `plt_session` (access JWT) | `/` | `/` | Lax | 900 s, `Expires` = access expiry |
| `mgr_refresh` / `cust_refresh` / `plt_refresh` (refresh token) | `/` | `/api/auth/manager` / `/api/auth` / `/api/platform/auth` respectively | Strict | workspace 30 days, platform 8 h |

### Refresh-failure codes (401 `{ error, code }`)

Returned by `POST /api/auth/refresh`, `/api/auth/manager/refresh` and
`/api/platform/auth/refresh`. Type: `RefreshFailureCode` in
`src/lib/session-tokens.ts`; mapping function: `refreshFailureCode`.
The `error` string is an English fallback; clients resolve the message
from `code` (see `src/lib/api-error-keys.ts`, whose 401 fallback is
`errors.sessionExpired`).

| Code | Internal outcome it reports |
|---|---|
| `REFRESH_TOKEN_REQUIRED` | Route-level only: no refresh token was presented, so rotation never ran |
| `REFRESH_TOKEN_INVALID` | No token row for this kind, wrong-kind presentation, unrevoked row mismatch, or a workspace row with no tenant. Unknown vs wrong-kind stay merged: both mean "this endpoint has no usable token" |
| `REFRESH_TOKEN_REVOKED` | The presented row is already revoked and its recorded reason is none of the specific ones below (logout, login_replaced, reauthentication, user_session_revocation, rotation_grace_superseded, or an unrecorded reason) |
| `REFRESH_TOKEN_REUSED` | Reuse detected: a replaced token presented after the 5 s grace (family revoked, audit + email attempted), or a row already revoked with `refresh_reuse_detected` |
| `REFRESH_TOKEN_EXPIRED` | Absolute family deadline passed, persisted token expiry passed, or rotation failed with `REFRESH_FAMILY_EXPIRED` (including from the grace window) |
| `TENANT_SUSPENDED` | Tenant lifecycle gate raised `TenantSuspendedError`, or the presented row was revoked with `tenant_suspended`. Note: the code reports the recorded death reason, not current tenant state — a token revoked during a suspension keeps this code after reactivation |
| `TENANT_DELETED` | Tenant lifecycle gate raised `TenantDeletedError` |
| `PRINCIPAL_INVALID` | `refreshPrincipalStillValid` failed (tenant not active, membership/role mismatch, user missing, email mismatch, unverified customer, non-owner platform user), or a row revoked with `principal_invalid` |
| `SESSION_IDLE_EXPIRED` | The policy row's `last_seen_at` is already past the 30-minute fence (read-only DB-clock diagnostic inside the rotation transaction; revocation behaviour unchanged). Server English fallback: "Session expired due to inactivity". This is the code clients render as "signed out due to inactivity" |
| `WORKSPACE_SESSION_EXPIRED` | Workspace policy check failed for a reason other than idle (missing policy row, policy expiry, credential-version mismatch, membership loss), or a row revoked with `workspace_session_expired` |
| `PLATFORM_SESSION_EXPIRED` | Platform policy check failed for a reason other than idle, or an equivalent platform policy death |

Merged by design (not distinguishable in the current code without changing
behaviour, so kept merged): unknown token vs wrong-kind presentation (both
`REFRESH_TOKEN_INVALID`); workspace policy deaths other than idle (all
`WORKSPACE_SESSION_EXPIRED` — `readWorkspaceSessionState` returns a single
null for missing row, policy expiry, credential mismatch and membership
loss); platform policy deaths other than idle (all
`PLATFORM_SESSION_EXPIRED`).

Client-wording gap: no dedicated EN+AR "signed out due to inactivity" i18n
key exists (`src/i18n/messages/en.ts`, `src/i18n/messages/ar.ts` contain
only the `workspaceSecurity.idleExpires` label and the generic
`errors.sessionExpired` key). Until a dedicated key is added, clients map
`SESSION_IDLE_EXPIRED` to the existing `errors.sessionExpired` key
("Your session expired. Sign in again to continue." /
"انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة."); no new i18n key was
invented in server code.

### CSRF / origin guard body alignment

Mutating `/api/*` requests carrying session cookies must prove same origin
(`src/server/request-guard.ts`, `guardApiRequest`); failure short-circuits
before the route runs. The body was `{ success: false, error:
"CSRF_VALIDATION_FAILED" }`, which did not match the routes'
`{ error, code }` shape, so client `code` lookups missed it. It is now
`{ success: false, error: "CSRF_VALIDATION_FAILED", code:
"CSRF_VALIDATION_FAILED" }` at the same 403 status, with the same guard
conditions and fail-closed behaviour. The `code` field mirrors `error` in
all `rejectRequest` responses (405/411/413/503 included) as an additive,
backward-compatible change; `success` and `error` are unchanged. No
guard condition was weakened and no request class was unguarded.
