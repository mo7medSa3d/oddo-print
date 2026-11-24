# Deployment Guide

> See also: [INSTALLATION.md](./INSTALLATION.md), [OPERATIONS.md](./OPERATIONS.md)

## Production Stack

```
Internet → Caddy (TLS + reverse proxy) → Gateway (Node.js) → PostgreSQL 16
                                                             → Go Agent (per site)
```

## Prerequisites

| Component | Release profile |
|-----------|----------------|
| Node.js / npm | Node 24.22.1 (`.nvmrc`), npm 12.2.1 (`packageManager`) |
| PostgreSQL | 16+; use the pinned image/profile in `Dockerfile.secure-images` for bundled deployment |
| Go | 1.26.11 (`agent/go.mod`) for the Agent build |
| Caddy | Pinned dependency/source profile in `Dockerfile.secure-images` and `docs/runtime-hardening/` |

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| PostgreSQL runtime identity | Either `DATABASE_URL` / `DATABASE_URL_FILE`, or complete `PGHOST`, `PGUSER`, `PGDATABASE` plus the runtime password (`PGPASSWORD_FILE` preferred). The Gateway must use the restricted runtime role, not the bootstrap or owner identity. |
| `GATEWAY_JWT_SECRET` | ≥ 32 chars, random, for manager/customer session signing |
| `TRUST_PROXY_SECRET` | ≥ 32 chars, shared with reverse proxy; required when `TRUST_PROXY=1` |
| `APP_BASE_URL` | Public-facing HTTPS origin used by authentication links and application navigation |

### Manual activation and email configuration

These variables are forwarded by `docker-compose.yml` as empty strings when unset, so missing optional providers do not prevent the core Gateway from starting.

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | Resend API key; leave unset to disable provider-backed email |
| `EMAIL_FROM` | Sender address used when email delivery is configured |
| `YASEIR_PLAN_CATALOG` | Optional bootstrap JSON array of `{id,name,description,monthlyQuota}`; preserves existing plans |
| `YASEIR_ACTIVATION_WHATSAPP` | Official activation contact in E.164 digits; the link contains only a persisted opaque request reference |
| `YASEIR_AGENT_DOWNLOAD_URL` | HTTPS URL of the verified official Windows installer; configure only after signing and acceptance |

V4 uses manual platform-owner activation. Payment-provider credentials are not required or forwarded. Retired checkout, portal, webhook, cancel and resume routes return HTTP 410 without changing subscriptions or processing money. Historical provider identifiers and billing events remain available as retained evidence. External financial settlement and any legacy recurring provider charges must be reconciled by the business operator; a local V4 migration does not contact or cancel an external account.

### Platform Operations

| Variable | Description |
|----------|-------------|
| `PLATFORM_TENANT_ID` | Tenant ID for the protected platform workspace; **required in production** so platform lifecycle protection cannot fail open |
| `STALE_AGENT_THRESHOLD_SECONDS` | Agent heartbeat staleness (default: 90) |

> **Forward-only migration cutover:** Before running `scripts/deploy-compose.sh`
> for an upgrade, arrange a maintenance window. The script builds first, then
> stops Caddy and drains the old Gateway (up to 60 seconds) **before** running
> database role/migration/verification gates. If a gate fails, public ingress
> stays offline; do not restart a pre-migration Gateway against the upgraded
> schema. Drain any *other* Gateway replicas/admission writers separately.
> Back up the database and review migration `0102`'s cutover reconciliation
> limitation and mandatory forward-only migration `0103_retained_print_attempt_evidence.sql`
> in `MIGRATION.md` before deploying Gateway code that reads or writes retained
> print attempt receipt columns. Never run the updated Gateway before 0103 is applied. `--resume` only reopens ingress after the gates for the
> exact reviewed release have exited successfully.

## Deployment Steps

### 1. Database Setup

Follow [PostgreSQL deployment roles](docs/DATABASE_ROLES.md) to create distinct
bootstrap, migration-owner and runtime identities. The bundled profile is for
a dedicated PostgreSQL cluster; an existing shared service needs its own
reviewed role policy. Keep the bootstrap and owner credentials out of the
Gateway runtime.

For Compose, the role, migration and runtime-verification jobs enforce this
order automatically. For a managed service or host deployment, run migrations
with the migration-owner environment, check the runtime privileges, then
start Gateway with a separate runtime-only environment. Do not carry the
owner's `DATABASE_URL` or `PGUSER` into the application process.

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
        # Replace client-supplied addresses before Gateway IP rate limiting.
        header_up X-Forwarded-For {http.request.remote.host}
        header_up -X-Real-Ip
    }
}
```

### 4. Build & Deploy Agent (Windows)

Upgrade Agents along with the Gateway inventory/desired-state contract. Migration `0080` must precede the Gateway that reads its retained inventory version. Versionless observations are additive before upgrade and cannot downgrade an established versioned writer. Manager fleets that exceed one desired-state page (64 rows or 512 KiB of array data) require an Agent with negotiated continuation support; older Agents stay fenced with `desiredStateUpgradeRequired` instead of applying a truncated list. Review the [heartbeat and desired-state contract](API.md#agent-heartbeat-pagination) for metadata budgets and recovery behavior.

Build the supported NSIS installer on a Windows host with the pinned Go, Node,
Rust/MSVC and CGO toolchains described in
[Windows toolchain acceptance](docs/WINDOWS_TOOLCHAIN_ACCEPTANCE.md):

```powershell
pwsh -File scripts/build-windows-installer.ps1 -Bundles nsis
```

Distribute only the installer that passes
[Windows release acceptance](docs/WINDOWS_RELEASE_ACCEPTANCE.md), including
the required signing and native install/upgrade/service/removal checks. The
Agent's SQLite runtime needs CGO; a plain cross-compiled executable does not
establish a working queue, service or installer. The customer installer bundles
the Agent and Desktop Manager. Pair the installed Agent to the Gateway through
the supported setup flow.

Use the Gateway origin root, such as `https://print.example.com` or `https://[2001:db8::1]:8443`. A trailing root slash and surrounding whitespace are normalized for all Agent HTTP and WebSocket endpoints; `/api`, other base paths, embedded credentials, queries and fragments are rejected with an explicit configuration error. The Desktop Manager also requires the origin root. Deploy a dedicated Gateway origin when a reverse proxy needs routing; a subpath deployment is not supported by the current Gateway/UI contract. Agent service configs and CLI pairing require an explicit HTTP(S) scheme; the Desktop Manager can add HTTPS to a bare hostname.

TLS verification and redirect refusal remain enabled. The Agent **never** sends bearer credentials over remote HTTP; `YASEIR_AGENT_ALLOW_INSECURE_HTTP=1` permits plaintext transport only to loopback (localhost, 127.0.0.1, ::1) in isolated development/test. The Desktop Manager likewise permits only loopback HTTP for local development. Remote HTTPS remains mandatory.

## Docker Deployment

```bash
# Use the reviewed immutable source revision; it is public, not a secret.
YASEIR_DEPLOYMENT_ID="$(git rev-parse --verify HEAD)" bash scripts/deploy-compose.sh
```

The helper builds one service at a time before changing running services, then
runs `database_roles`, `migrate` and `database_verify` in order. Back up the
database first and review migration rollback boundaries. For a release ZIP, use
its verified source-manifest hash instead of `git rev-parse`.

If those three gates completed successfully and only application startup failed,
use the same release ID, image artifacts and Compose options with
`bash scripts/deploy-compose.sh --resume`. It verifies the completed gates belong
to that release and PostgreSQL is healthy, then starts Gateway/Caddy without
rebuilding or replaying migrations. A failed gate must be resolved before resume;
never remove data or TLS volumes to recover. Additional Compose options follow
`--`, for example `-- --env-file reviewed.env`.

For legacy Caddy volumes containing root-owned files, back up both TLS volumes,
then add `--repair-caddy-storage` to the helper (including with `--resume`). This
is an explicit, idempotent ownership/mode migration to UID/GID 10001. Only its
disposable maintenance container receives CHOWN, FOWNER and DAC_OVERRIDE; Caddy
continues running without capabilities. Certificate bytes and directory names
are retained. The helper stops on any repair failure before application startup;
correct the underlying volume access and repeat the same resume command. Never
delete certificates or grant those capabilities to the long-running service.

The `docker-compose.yml` includes Gateway, PostgreSQL, Caddy and the one-shot
`database_roles`, `migrate` and `database_verify` jobs. Compose requires
`APP_BASE_URL` and forwards the email and manual-activation settings listed
above. Set three independent PostgreSQL secrets (`POSTGRES_PASSWORD`,
`POSTGRES_OWNER_PASSWORD`, `POSTGRES_RUNTIME_PASSWORD`) as described in the
role guide, together with `GATEWAY_JWT_SECRET`, `MANAGER_PASSWORD_HASH` and
`TRUST_PROXY_SECRET`. Compose mounts the secrets per service; Gateway receives
only the runtime database credential. Existing-volume conversion requires the
role guide's backup and maintenance procedure before ordinary startup.

## Health Checks

| Endpoint | Purpose |
|----------|---------|
| `GET /api/live` | Cheap unauthenticated process liveness (no DB, no auth) |
| `GET /api/health` | Gateway readiness (200 only with database connectivity; 503 otherwise); used by Docker deployment health checks |
| `GET /api/agents/health` | Authenticated per-Agent health and connectivity details (manager `agents.read` permission required) |
| Agent heartbeat | Agent liveness (30s interval via WebSocket or HTTP) |

Container readiness now depends on PostgreSQL through `/api/health`. Keep `/api/live` only for process-only diagnostics; it must not admit requests when the database is unavailable. The production Gateway also refuses startup without a PostgreSQL URL or a complete `PGHOST`/`PGUSER`/`PGDATABASE` identity.

After publishing the Gateway behind a publicly trusted TLS certificate, run the external HTTPS + unauthenticated WSS rejection acceptance test from an operator machine with the repository's installed Node dependencies:

```bash
node scripts/check-public-gateway.mjs https://print.example.com
```

This proves that HTTPS is publicly trusted and the WebSocket route is reachable through the same TLS proxy without granting access to an unauthenticated Agent. It does not replace a paired real-Agent and physical-printer acceptance test.

## Security Checklist

- [ ] `GATEWAY_JWT_SECRET` is random, ≥ 32 chars, not a placeholder
- [ ] `TRUST_PROXY_SECRET` is random, ≥ 32 chars, not a placeholder
- [ ] Remote PostgreSQL connections use the deployment's verified TLS configuration; the bundled PostgreSQL port remains unpublished on the private container network
- [ ] Gateway uses the restricted runtime database identity; bootstrap and owner credentials are confined to their jobs
- [ ] Caddy/proxy terminates TLS with a publicly trusted certificate; `node scripts/check-public-gateway.mjs https://print.example.com` passes from outside the VPS
- [ ] Manual plans, official activation contact and a verified Windows download URL are configured
- [ ] Any historical external recurring charges have been reconciled by the business operator
- [ ] `NODE_ENV=production` is set
- [ ] `PLATFORM_TENANT_ID` is set to the immutable platform workspace ID
- [ ] `TRUST_PROXY=1` is enabled for the bundled reverse-proxy deployment
- [ ] Gateway port `3000` is private/unpublished; only the TLS reverse proxy is public
- [ ] `main` has a protected GitHub Ruleset requiring CodeQL, CI, Go/Odoo/Windows change-scoped checks and independent CODEOWNERS review; enable GitHub Dependency Review when the repository's dependency graph supports it

## Graceful Shutdown

The Gateway handles `SIGTERM` and `SIGINT`:

1. Marks admission as shutting down and closes Agent WebSockets with 1001 Going Away.
2. Drains accepted WebSocket work, closes the HTTP listener and drains HTTP requests.
3. Waits for accepted Next.js background work and tracked maintenance tasks.
4. Flushes bounded authorization-denial summaries and closes the database pool.

`server.ts` enforces a 45-second overall drain deadline. Compose allows 60 seconds
before forcibly stopping the container. An interrupted delivery retains its
claim and uncertainty evidence; shutdown does not authorize automatic reprinting.

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

Restore **only into a new empty recovery database**. Do not restore over a
live or previously populated database:

```bash
export PGHOST=recovery-db.example.internal PGPORT=5432 PGDATABASE=print_gateway_restore PGUSER=restore
export PGPASSWORD_FILE=/run/secrets/postgres_password
export RESTORE_CONFIRM=print_gateway_restore
scripts/postgres-restore.sh /mnt/independent-backups/yaseir/print_gateway-YYYYMMDDTHHMMSSZ.dump
```

The restore helper requires the matching checksum, validates the archive table
of contents, requires `RESTORE_CONFIRM` to exactly match `PGDATABASE`, and uses
`pg_restore --single-transaction` so a restore error rolls back the restore
transaction. A non-empty target is **always** rejected, even when a legacy
`RESTORE_ALLOW_NONEMPTY=1` environment variable is present. To recover a live
environment, provision a new empty database, restore there, verify service and
printer state, and cut over explicitly. Keep the original database intact for
reconciliation and rollback; never use `--clean` on the active database.

After every restore, before enabling traffic:

1. run `npm run db:migrate` against the restored database using the migration owner;
2. verify the restricted runtime role, then run `python3 scripts/check-db-docs.py` and the PostgreSQL integration gates;
3. verify `/api/health`, an authenticated protected API request, Agent reconnects,
   and a controlled non-production print path;
4. keep the pre-restore database/volume isolated until reconciliation is complete.

**RPO/RTO are deployment properties, not values the application can truthfully
promise.** Define an RPO from the business's acceptable data-loss window, run
backups at least that often (or use provider PITR/WAL archiving for a tighter
RPO), and rehearse restores to measure the real RTO. A backup that has never
been restored in a recovery environment is not considered verified. Do not
restore archives from untrusted PostgreSQL superusers: restore executes archive
contents with database privileges.

Schedule example (systemd timer, daily 02:00 UTC; equivalent cron:
`0 2 * * *`):

```ini
# /etc/systemd/system/yaseir-backup.service
[Service]
Type=oneshot
Environment=PGHOST=db.example.internal PGPORT=5432 PGDATABASE=print_gateway PGUSER=backup
Environment=PGPASSWORD_FILE=/run/secrets/postgres_password
Environment=BACKUP_DIR=/mnt/independent-backups/yaseir
ExecStart=/opt/yaseir/scripts/postgres-backup.sh
```

```ini
# /etc/systemd/system/yaseir-backup.timer
[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

The Docker workflow's eligible stack jobs exercise a backup/restore round trip:
backup, restore into a scratch database, compare the `tenants` row count and
drop that scratch database. This limited CI check does not establish complete
data equivalence or a deployment RPO/RTO. Run the broader
`scripts/acceptance/postgres-restore-drill.mjs` against an isolated recovery
environment, and rehearse the deployment's actual independent-backup recovery
procedure before approving production.
