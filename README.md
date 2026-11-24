# Yaseir — Direct Odoo 19 Printing & License-Only Control Plane

Yaseir delivers direct, low-latency physical printing for **Odoo 19** without routing print payloads through a cloud middleman. Odoo owns the durable print outbox and job state; the local **Go Agent** connects directly to Odoo over RFC 6455 WebSocket (`/api/agent/ws`) with automatic 5-second HTTPS polling fallback; the **Windows Admin-Only Desktop Manager** (`src-tauri/`) configures and supervises the local Agent service under Windows Administrator privileges; and **Yaseir Cloud** operates strictly as a **License-Only Gateway** issuing signed **Ed25519 v2** license bundles.

---

## Architecture Overview

```text
Odoo 19 (business truth, durable outbox, pg_notify('print_gateway_job_ready'))
        ⇅ Direct WSS /api/agent/ws + 5s HTTPS polling fallback
          (register / heartbeat / claim / ACK)
Go Agent (Windows service, local SQLite recovery, offline Ed25519 v2 verification)
        ↑ Managed locally by Windows Admin-Only Desktop Manager (Tauri + UAC elevation)
        ↓
Windows Spooler / RAW TCP 9100 / USB / IPP
        ↓
Physical Printer

Yaseir Cloud (Next.js + PostgreSQL + Drizzle, 21 tables)
        ── Account, workspace, manual subscription & Ed25519 v2 licensing ONLY
           (/api/license/refresh, /api/license/verify)
```

| Component | Responsibility | Boundary |
|---|---|---|
| **Odoo 19 (`print_gateway` addon)** | Business records, printer bindings, durable outbox, `pg_notify('print_gateway_job_ready', ...)` wakeups, `/api/agent/ws`, claim leases, ACKs, audit history | Single source of truth for print jobs; never forwards print payloads to Cloud |
| **Go Agent (`agent/`)** | Zero-dependency RFC 6455 WebSocket (`/api/agent/ws`) + 5s HTTPS fallback, offline Ed25519 v2 license enforcement (`PinnedPublicKeyB64`), local SQLite state, physical print execution | Connects directly to Odoo over HTTPS; fail-closed if license is invalid or revoked |
| **Windows Admin-Only Desktop Manager (`src-tauri/`)** | Windows-only Tauri UI requiring Administrator elevation (UAC `runas` / `require_admin()`) for Odoo HTTPS URL setup, Agent service control, pairing, printer discovery, and health | Local host administration only; does not maintain a second job queue or mirror history to Cloud |
| **Yaseir Cloud (`src/`, `server.ts`)** | Tenant accounts, manual subscriptions, platform admin, and Ed25519 v2 signed license issuance/verification (`/api/license/refresh`, `/api/license/verify`) | Control plane only; no print-job APIs, queues, or dispatch workers |

> **Reliability note:** Claim tokens fence stale Agents, and outcomes that cross the physical hardware boundary without a final ACK remain terminal (`unknown`) rather than replaying automatically.

---

## Requirements

| Dependency | Version / Notes |
|---|---|
| **Node.js** | `24.22.1` (`.nvmrc` / `package.json` engines: `>=24.15.0`) |
| **npm** | `>=12.2.1` |
| **PostgreSQL** | 16+ (dedicated owner role for migrations, least-privilege runtime role for Gateway) |
| **Go** | `1.26+` (`agent/go.mod`: `go 1.26.0`, toolchain `go1.26.11`) |
| **Odoo** | 19.0 with `odoo_addons/print_gateway` |
| **Windows (Site Host)** | Windows 10/11 with Administrator privileges for the Desktop Manager & Go Agent service |
| **Docker & Caddy** | Required for containerized production deployment with automatic TLS |

---

## Quick Setup (Local Development)

```bash
cp .env.example .env
# Edit .env with local PostgreSQL credentials and development secrets

npm ci
npm run db:reset      # Drops/recreates schema and applies the clean initial migration
npm run dev           # Starts custom server.ts (Next.js + security headers) on :3000
```

---

## Environment Configuration

Every variable supporting `runtimeSecret` also accepts a `*_FILE` variant (e.g., `GATEWAY_JWT_SECRET_FILE=/run/secrets/gateway_jwt_secret`) for Docker Secrets.

| Variable | Required in Prod | Default | Description |
|---|:---:|---|---|
| `NODE_ENV` | Yes | `development` | Set to `production` in production deployments |
| `PORT` / `HOSTNAME` | No | `3000` / `0.0.0.0` | HTTP bind port and interface |
| `DATABASE_URL` | Yes* | — | PostgreSQL URI (*or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`/`PGPASSWORD_FILE`) |
| `GATEWAY_JWT_SECRET` | Yes | — | Signing secret (`>= 32` chars; supports `_FILE`) |
| `APP_BASE_URL` | Yes | `http://localhost:3000` | Public `https://` origin (e.g., `https://print.example.com`) |
| `TRUST_PROXY` | Yes | `0` | Set `1` behind Caddy (non-loopback production binds refuse startup otherwise) |
| `TRUST_PROXY_SECRET` | Yes | — | Shared secret (`>= 32` chars; injected by Caddy via `X-Gateway-Proxy-Token`; supports `_FILE`) |
| `COOKIE_SECURE` | Yes | `1` | Must remain enabled in production (`0` for local HTTP dev only) |
| `PLATFORM_TENANT_ID` | Yes | — | Real platform workspace ID |
| `MANAGER_USERNAME` | Yes | `admin` | Operator/manager login username |
| `MANAGER_PASSWORD_HASH` | Yes | — | Argon2id hash (supports `_FILE`; never enable `ALLOW_PLAINTEXT_MANAGER_PASSWORD` in prod) |
| `LICENSE_SIGNING_PRIVATE_KEY_PEM` | Yes | — | Ed25519 PKCS#8 private key PEM used by `/api/license/refresh` (supports `_FILE`) |
| `LICENSE_SIGNING_PUBLIC_KEY_PEM` | No | Derived | Optional Ed25519 SPKI public key PEM override for `/api/license/verify` (supports `_FILE`) |
| `LICENSE_SIGNING_KEY_ID` | No | `k1` | Key identifier (`key_id`) embedded in signed v2 license bundles |
| `LICENSE_REFRESH_SECRET` | No | — | Optional master bearer secret (`>= 32` chars; supports `_FILE`) for server-to-server license calls |
| `YASEIR_LICENSE_PUBLIC_KEY_B64` | Agent | — | Base64-encoded 32-byte raw Ed25519 public key for Go Agent build-time pinning or runtime fallback |
| `GATEWAY_DOMAIN` | Compose | — | Public DNS hostname for Caddy automatic HTTPS/TLS |
| `YASEIR_DEPLOYMENT_ID` | Compose | — | Immutable non-secret release SHA passed at Docker build and runtime |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Compose | `yasser_db` / `odoo_print` | Bootstrap PostgreSQL database and administrator credentials |
| `POSTGRES_OWNER_USER` / `POSTGRES_OWNER_PASSWORD` | Compose | `yaseir_owner` | Migration-owner PostgreSQL role credentials |
| `POSTGRES_RUNTIME_USER` / `POSTGRES_RUNTIME_PASSWORD` | Compose | `yaseir_runtime` | Least-privilege runtime PostgreSQL role credentials |
| `PLATFORM_OWNER_EMAIL` / `PLATFORM_OWNER_PASSWORD` | Bootstrap | — | Initial platform owner credentials for `npm run platform:bootstrap` (supports `_FILE`) |
| `RESEND_API_KEY` / `EMAIL_FROM` | No | — | Optional transactional email provider for verification and password setup |
| `YASEIR_PLAN_CATALOG` | No | — | Optional initial plan catalog for `npm run db:provision-plans` |
| `METRICS_SCRAPE_TOKEN_FILE` | No | — | Optional path to 64-hex-char token file for unattended read-only metrics |
| `LOG_LEVEL` | No | `info` (`debug` in dev) | `debug` \| `info` \| `warn` \| `error` |

---

## Run & Test Commands

```bash
# Typecheck, lint, unit & integration tests, production build
npm run typecheck
npm run lint
npm test
npm run test:unit
npm run test:integration
npm run build

# Repository verification & hardening checks
npm run db:docs:check
npm run i18n:check
npm run i18n:odoo:check
npm run typography:check
python3 scripts/verify-direct-print-architecture.py
python3 scripts/check-ui-copy.py
python3 scripts/check-native-backports.py
python3 scripts/check-thmanyah-coverage.py
python3 -m unittest tests/test_v15_hardening.py
python3 tests/production-source-audit.py

# Go Agent tests
cd agent && go test ./... && go test -race ./...
```

---

## Production Deployment

### 1. Database Initialization

For a fresh PostgreSQL database (or intentional clean wipe — requires `-- --force` when `NODE_ENV=production`):

```bash
npm run db:reset              # Development / staging fresh reset
# Or in production with explicit confirmation:
NODE_ENV=production npm run db:reset -- --force

# Standard forward migration on existing deployments:
npm run db:migrate
npm run platform:bootstrap
npm run db:provision-plans
```

When deploying via Docker Compose, `database_roles` → `migrate` → `database_verify` automatically configure least-privilege PostgreSQL roles and apply migrations before `gateway` starts.

### 2. Ed25519 Key Generation & Pinning

Generate a production Ed25519 keypair and extract the raw 32-byte Base64 public key for Agent and Odoo pinning:

```bash
# 1. Generate Ed25519 private key (PKCS#8 PEM) and public key (SPKI PEM)
openssl genpkey -algorithm ED25519 -out license_private.pem
openssl pkey -in license_private.pem -pubout -out license_public.pem

# 2. Extract raw 32-byte Ed25519 public key in Base64 (for Go Agent & Odoo)
YASEIR_LICENSE_PUBLIC_KEY_B64=$(openssl pkey -pubin -in license_public.pem -outform DER | tail -c 32 | base64 -w0)
echo "$YASEIR_LICENSE_PUBLIC_KEY_B64"
```

- **Yaseir Cloud Gateway:** Provide `license_private.pem` via `LICENSE_SIGNING_PRIVATE_KEY_PEM_FILE` (or `LICENSE_SIGNING_PRIVATE_KEY_PEM`) and set `LICENSE_SIGNING_KEY_ID` (e.g., `k1`).
- **Go Agent:** Pin the public key at build time so the Agent enforces Ed25519 v2 signatures offline (fail-closed):
  ```bash
  cd agent && make build YASEIR_LICENSE_PUBLIC_KEY_B64="$YASEIR_LICENSE_PUBLIC_KEY_B64"
  # Equivalent ldflag: -X github.com/yaseir-agent/agent/internal/license.PinnedPublicKeyB64=<b64>
  ```
- **Odoo 19 Addon:** Set `print_gateway.license_public_key_b64` in Odoo System Parameters (or pin `PINNED_LICENSE_PUBLIC_KEY_B64` in `odoo_addons/print_gateway/models/print_config.py`).

### 3. Containerized Deployment (Docker Compose + Caddy TLS)

```bash
# Export required secrets and release SHA (YASEIR_DEPLOYMENT_ID, GATEWAY_DOMAIN,
# APP_BASE_URL, GATEWAY_JWT_SECRET, TRUST_PROXY_SECRET, MANAGER_PASSWORD_HASH,
# POSTGRES_* passwords, LICENSE_SIGNING_PRIVATE_KEY_PEM)
docker compose up -d --build
```

- `gateway` runs as non-root `node` with `cap_drop: [ALL]`, `no-new-privileges:true`, and a `/api/health` healthcheck.
- `caddy` runs as non-root `10001:10001`, manages automatic HTTPS/TLS for `GATEWAY_DOMAIN`, strips spoofed `X-Forwarded-For`, injects `X-Gateway-Proxy-Token`, and applies HSTS and security headers.
- `Dockerfile.odoo-hardened` provides a digest-pinned, non-root (`odoo`) Odoo 19 runtime with healthcheck and isolated CPython 3.12 venv.

### 4. Odoo 19 License Activation & Agent Pairing

1. Install the `print_gateway` addon in Odoo 19.
2. In Yaseir Cloud, approve the workspace's manual subscription (`/platform/subscription-requests`) and issue an Odoo-enabled tenant API key.
3. In Odoo **Print Gateway → Configuration**, enter the Yaseir Cloud HTTPS URL, tenant API key, and `license_public_key_b64`, then refresh the signed Ed25519 v2 license (`/api/license/refresh`).
4. Create an Agent pairing code in Odoo and pair the **Windows Admin-Only Desktop Manager / Go Agent** directly with the **Odoo HTTPS base URL** (never the Cloud Gateway URL).
5. Bind Odoo document types and POS printers to the local printers reported by the paired Agent.

---

## Further Documentation

- [DIRECT_PRINT_ARCHITECTURE.md](DIRECT_PRINT_ARCHITECTURE.md) & [DIRECT_PRINT_MODE.md](DIRECT_PRINT_MODE.md) — Direct WebSocket/HTTP contract and Ed25519 v2 licensing boundaries
- [SERVER_FIRST_RUN.md](SERVER_FIRST_RUN.md) — First-run production deployment and end-to-end smoke test
- [DEPLOYMENT.md](DEPLOYMENT.md) & [OPERATIONS.md](OPERATIONS.md) — Production operations, backups, and role separation
- [API.md](API.md), [INSTALLATION.md](INSTALLATION.md), [SECURITY.md](SECURITY.md), [TYPOGRAPHY.md](TYPOGRAPHY.md), [CHANGELOG.md](CHANGELOG.md)
