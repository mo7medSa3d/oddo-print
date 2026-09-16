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
| `TRUST_PROXY_SECRET` | ≥ 32 chars, shared with reverse proxy |
| `APP_BASE_URL` | Public-facing Gateway URL used by email/billing callbacks |

### Billing (Optional)

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |

### Platform Operations

| Variable | Description |
|----------|-------------|
| `PLATFORM_TENANT_ID` | Tenant ID for platform admin operations |
| `STALE_AGENT_THRESHOLD_SECONDS` | Agent heartbeat staleness (default: 90) |

## Deployment Steps

### 1. Database Setup

```bash
createdb print_gateway
DATABASE_URL="postgresql://user:pass@host:5432/print_gateway" npm run db:migrate
```

### 2. Build & Start Gateway

```bash
npm ci --production
npm run build
NODE_ENV=production npm start
```

### 3. Configure Reverse Proxy (Caddy Example)

```caddyfile
gateway.example.com {
    reverse_proxy localhost:3000 {
        header_up X-Gateway-Proxy-Token {$TRUST_PROXY_SECRET}
    }
}
```

### 4. Build & Deploy Agent (Windows)

```bash
cd agent
GOOS=windows GOARCH=amd64 go build -o print-agent.exe ./cmd/agent
```

Deploy `print-agent.exe` with a YAML config file pointing to the Gateway URL.

## Docker Deployment

```bash
docker-compose up -d
```

The `docker-compose.yml` includes Gateway, PostgreSQL, and Caddy services.

## Health Checks

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Gateway liveness (returns 200 when operational) |
| Agent heartbeat | Agent liveness (30s interval via WebSocket or HTTP) |

## Security Checklist

- [ ] `GATEWAY_JWT_SECRET` is random, ≥ 32 chars, not a placeholder
- [ ] `TRUST_PROXY_SECRET` is random, ≥ 32 chars, not a placeholder
- [ ] `DATABASE_URL` uses SSL in production (`?sslmode=require`)
- [ ] Caddy/proxy terminates TLS with a valid certificate
- [ ] Stripe webhook secret is configured for billing
- [ ] `NODE_ENV=production` is set

## Graceful Shutdown

The Gateway handles `SIGTERM` and `SIGINT`:
1. Closes WebSocket connections (1001 Going Away)
2. Stops accepting new requests
3. Drains in-flight requests (10s timeout)
4. Closes database pool
