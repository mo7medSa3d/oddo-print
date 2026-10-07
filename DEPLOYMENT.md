# Deployment Guide

> See also: [INSTALLATION.md](./INSTALLATION.md), [OPERATIONS.md](./OPERATIONS.md)

## Production Stack

```
Internet → Caddy (TLS + reverse proxy) → Gateway (Node.js) → PostgreSQL 16
                                                             → Go Agent (per site)
```

## Prerequisites

| Component | Minimum Version |
|-----------|----------------|
| Node.js | ≥ 24.15.0 |
| PostgreSQL | 16+ |
| Go | 1.26 (agent build) |
| Caddy | 2.x (or any reverse proxy) |

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `GATEWAY_JWT_SECRET` | ≥ 32 chars, random, for manager/customer session signing |
| `TRUST_PROXY_SECRET` | ≥ 32 chars, shared with reverse proxy; required when `TRUST_PROXY=1` |
| `APP_BASE_URL` | Public-facing HTTPS origin used by email/billing callbacks |

### Email and Billing Providers (Optional)

These variables are forwarded by `docker-compose.yml` as empty strings when unset, so missing optional providers do not prevent the core Gateway from starting.

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | Resend API key; leave unset to disable provider-backed email |
| `EMAIL_FROM` | Sender address used when email delivery is configured |
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `STRIPE_API_VERSION` | Optional pinned Stripe API version |
| `STRIPE_PLAN_CATALOG` | Optional plan catalog configuration |

### Platform Operations

| Variable | Description |
|----------|-------------|
| `PLATFORM_TENANT_ID` | Tenant ID for the protected platform workspace; **required in production** so platform lifecycle protection cannot fail open |
| `STALE_AGENT_THRESHOLD_SECONDS` | Agent heartbeat staleness (default: 90) |

## Deployment Steps

### 1. Database Setup

```bash
createdb print_gateway
DATABASE_URL="postgresql://user:pass@host:5432/print_gateway" npm run db:migrate
```

### 2. Build & Start Gateway

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

> Build with the full install (`npm ci`): the Next.js build needs
> devDependencies. `npm ci --omit=dev` is for the runtime image only
> (as in the Dockerfile's final stage), never before `npm run build`.

### 3. Configure Reverse Proxy (Caddy Example)

Production startup requires `TRUST_PROXY=1` and a real `TRUST_PROXY_SECRET` whenever the Gateway binds a non-loopback interface. A loopback-only Gateway may omit proxy trust because it is not directly network-addressable. The bundled Docker deployment uses `0.0.0.0` inside the private Docker network, so it must keep `TRUST_PROXY=1`. The bundled Docker Compose keeps Gateway port 3000 private with Caddy as the public TLS entry point. Do not publish Gateway port 3000 directly to the Internet.



```caddyfile
gateway.example.com {
    reverse_proxy localhost:3000 {
        # Match the repo's secret-file pattern (see Caddyfile and
        # docker-compose.yml); avoid inlining the raw secret in configs.
        header_up X-Gateway-Proxy-Token {file./run/secrets/trust_proxy_secret}
    }
}
```

### 4. Build & Deploy Agent (Windows)

Upgrade Agents along with the Gateway inventory/desired-state contract. Migration `0080` must precede the Gateway that reads its retained inventory version. Versionless observations are additive before upgrade and cannot downgrade an established versioned writer. Manager fleets that exceed one desired-state page (64 rows or 512 KiB of array data) require an Agent with negotiated continuation support; older Agents stay fenced with `desiredStateUpgradeRequired` instead of applying a truncated list. Review the [heartbeat and desired-state contract](API.md#agent-heartbeat-pagination) for metadata budgets and recovery behavior.

```bash
cd agent
GOOS=windows GOARCH=amd64 go build -o print-agent.exe ./cmd/agent
```

Deploy `print-agent.exe` with a YAML config file pointing to the Gateway URL.

## Docker Deployment

```bash
docker-compose up -d
```

The `docker-compose.yml` includes Gateway, PostgreSQL, and Caddy services. Compose requires `APP_BASE_URL` and forwards the optional email/billing variables listed above; production secrets remain supplied through Compose secrets (`POSTGRES_PASSWORD`, `GATEWAY_JWT_SECRET`, `MANAGER_PASSWORD_HASH`, and `TRUST_PROXY_SECRET`).

## Health Checks

| Endpoint | Purpose |
|----------|---------|
| `GET /api/live` | Cheap unauthenticated liveness (no DB, no auth; Docker/Caddy probe) |
| `GET /api/health` | Gateway readiness (returns 200 when DB reachable, 503 otherwise; unauthenticated liveness probe) |
| `GET /api/system/health` | Full system health (manager auth `agents.read` required) |
| Agent heartbeat | Agent liveness (30s interval via WebSocket or HTTP) |

## Security Checklist

- [ ] `GATEWAY_JWT_SECRET` is random, ≥ 32 chars, not a placeholder
- [ ] `TRUST_PROXY_SECRET` is random, ≥ 32 chars, not a placeholder
- [ ] `DATABASE_URL` uses SSL in production (`?sslmode=require`)
- [ ] Caddy/proxy terminates TLS with a valid certificate
- [ ] Stripe webhook secret is configured for billing
- [ ] `NODE_ENV=production` is set
- [ ] `PLATFORM_TENANT_ID` is set to the immutable platform workspace ID
- [ ] `TRUST_PROXY=1` is enabled for the bundled reverse-proxy deployment
- [ ] Gateway port `3000` is private/unpublished; only the TLS reverse proxy is public
- [ ] Static security gates (CodeQL, Dependency Review, Gitleaks) are required branch checks

## Graceful Shutdown

The Gateway handles `SIGTERM` and `SIGINT`:
1. Closes WebSocket connections (1001 Going Away)
2. Stops accepting new requests
3. Drains in-flight requests (10s timeout)
4. Closes database pool

## Backup and Disaster Recovery

The Gateway's durable runtime truth is PostgreSQL. Agent SQLite and the Odoo
outbox protect their respective execution edges, but they are **not** a
replacement for a PostgreSQL backup. Production deployments must place backup
artifacts on storage independent from the database host/volume.

The repository provides logical backup/restore helpers for PostgreSQL 16+:

```bash
# Use standard libpq connection variables. Prefer a mounted secret file rather
# than putting a password or DATABASE_URL on a command line.
export PGHOST=db.example.internal PGPORT=5432 PGDATABASE=print_gateway PGUSER=backup
export PGPASSWORD_FILE=/run/secrets/postgres_password
export BACKUP_DIR=/mnt/independent-backups/yaseir
scripts/postgres-backup.sh
```

The backup helper creates PostgreSQL custom-format archives, makes
`pg_restore --list` parse the completed archive before publication, and writes
a SHA-256 sidecar. Custom-format archives are intentionally used because
PostgreSQL supports inspection and selective/full restore through `pg_restore`.

Restore into an empty recovery database first whenever possible:

```bash
export PGHOST=recovery-db.example.internal PGPORT=5432 PGDATABASE=print_gateway_restore PGUSER=restore
export PGPASSWORD_FILE=/run/secrets/postgres_password
export RESTORE_CONFIRM=print_gateway_restore
scripts/postgres-restore.sh /mnt/independent-backups/yaseir/print_gateway-YYYYMMDDTHHMMSSZ.dump
```

The restore helper requires the matching checksum, validates the archive table
of contents, requires `RESTORE_CONFIRM` to exactly match `PGDATABASE`, and uses
`pg_restore --single-transaction` so a restore error rolls back the restore
transaction. A non-empty target is rejected by default. Deliberate destructive
replacement additionally requires `RESTORE_ALLOW_NONEMPTY=1`.

After every restore, before enabling traffic:

1. run `npm run db:migrate` using the restored database;
2. run `python3 scripts/check-db-docs.py` and the PostgreSQL integration gates;
3. verify `/api/health`, authenticated `/api/system/health`, Agent reconnects,
   and a controlled non-production print path;
4. keep the pre-restore database/volume isolated until reconciliation is complete.

**RPO/RTO are deployment properties, not values the application can truthfully
promise.** Define an RPO from the business's acceptable data-loss window, run
backups at least that often (or use provider PITR/WAL archiving for a tighter
RPO), and rehearse restores to measure the real RTO. A backup that has never
been restored in a recovery environment is not considered verified. Do not
restore archives from untrusted PostgreSQL superusers: restore executes archive
contents with database privileges.
