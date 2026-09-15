# Security Architecture

> See also: [SECURITY_MODEL.md](./SECURITY_MODEL.md), [ARCHITECTURE.md](./ARCHITECTURE.md) § 5

## Authentication

### Agent Authentication
- Format: `Bearer {agentId}:{secret}`
- Secret stored as SHA-256 hash
- Comparison: SHA-256 of provided secret vs stored hash using `timingSafeEqual` on both digests
- Lifecycle check: agent must be `active`, tenant must be `active`

### API Key Authentication (Odoo → Gateway)
- Format: `Bearer {api_key}`
- Key stored as SHA-256 hash with prefix for lookup
- Scoped to tenant via `api_keys.tenant_id`

### Customer Authentication
- Email/password with bcrypt hash
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
| Print job submission | Per-API-key window | minute + hour limits in `print_job_rate_limits` |
| Heartbeat payload | Max 500 printers | Truncated at gateway |

## Input Validation

- **All API routes**: Zod schema validation on request body/params
- **Print payloads**: Database CHECK constraint (`payloadContractCheck`)
- **Protocol enforcement**: Printer capability gating prevents incompatible routing
- **ZPL/TSPL/ESC/POS**: Character sanitization prevents command injection
- **SQL**: Parameterized queries via Drizzle ORM (no raw string interpolation)
- **Document IDs**: Strict integer validation in report download controller

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
