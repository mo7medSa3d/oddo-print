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
- Password reset with time-limited, single-use tokens (SHA-256 hashed)
- Rate limiting on login attempts (per-key lockout in `auth_rate_limits`)

### Manager Sessions
- Server-side sessions in `manager_sessions` table
- JWT with per-session JTI (JSON Token Identifier)
- HttpOnly signed cookies
- Session bound to `userId`, `tenantId`, and role at authentication time

### Reverse Proxy Trust
- `TRUST_PROXY_SECRET` header validated on every request
- Minimum 32 characters, reject known placeholder values
- Required for production mode (`NODE_ENV=production`)

## Rate Limiting

| Scope | Mechanism | Parameters |
|-------|-----------|------------|
| Auth (login) | Per-key with progressive lockout | `auth_rate_limits` table |
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

- Application-level: All queries include `tenant_id` filter
- Database: Composite FK constraints prevent cross-tenant references
- Auth: Tenant context derived server-side, never from client-supplied values
- Session: Tenant bound at authentication, not per-request

## Audit Trail

The `audit_events` table records:
- Actor type (user, agent, system, platform)
- Actor ID
- Action (e.g., `agent.registered`, `billing.checkout.session.completed`)
- Resource type and ID
- Metadata (JSON)

## Secrets Management

- Never log raw API keys, agent secrets, passwords, or pairing values
- Pairing codes are single-use with expiry
- Agent secrets are hashed at creation, raw value shown once
- Environment secrets validated on startup (reject placeholders)


## Pairing and Job Delivery

Agent pairing codes are short-lived, hashed, and single-use. Successful pairing mints the long-lived Agent credential; the pairing value is not the Agent identity.

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
