# Yaseir Domain Staging

HTTPS staging for the `test/http-server-ready` branch.

Domain: `print.yaseir.cloud`

Architecture:

```
Cloudflare → Caddy :443 → Gateway :3000 (private) → PostgreSQL
```

This directory reuses the existing PostgreSQL volume so staging data is not reset. Fake Stripe plans and email capture remain enabled. `YASEIR_HTTP_TEST_MODE` controls these test features only; it cannot disable HTTPS, Secure cookies, proxy authentication, or tenant isolation.

The legacy `deploy/http-test` files are retained for migration history; they are no longer a supported deployment or CI entry point. Use this HTTPS deployment.

## Cloudflare

Create an A record:

```text
Name: print
Content: <Azure VM public IPv4>
Proxy status: Proxied
```

Set Cloudflare SSL/TLS encryption mode to `Full (strict)`.

Caddy needs inbound ports 80 and 443 and will manage the public TLS certificate automatically when the DNS record points at the server.

## Deploy

From the repository root:

```bash
bash deploy/domain-test/setup-domain-test.sh
```

The script stops the old HTTP-only stack without deleting its PostgreSQL volume, reuses its secrets when available, starts Caddy + Gateway over HTTPS, validates the local HTTPS certificate and path, and provisions the existing test plan catalog.

## Verify

```bash
bash deploy/domain-test/smoke-domain-test.sh
```

Or:

```bash
curl -fsS https://print.yaseir.cloud/api/live
curl -fsS https://print.yaseir.cloud/api/health
```

Expected liveness:

```json
{"ok":true}
```

Application URLs:

```text
Gateway / Browser: https://print.yaseir.cloud
Odoo Gateway URL:  https://print.yaseir.cloud
Agent URL:         https://print.yaseir.cloud
Agent WebSocket:   wss://print.yaseir.cloud/api/agent/ws
```

Do not expose Gateway port 3000. Caddy is the only public application entry point.

Do not run `deploy/http-test` and `deploy/domain-test` simultaneously because they intentionally share the same PostgreSQL volume.

The setup script migrates the database and registers `print.yaseir.cloud` for the existing staging workspace automatically before starting the Gateway. Reruns preserve the domain's existing owner, database, accounts, and secrets. No manual domain verification or `MANAGER_TENANT_ID` is needed when the domain is already registered or there is one active non-platform workspace. If several workspaces exist and the domain has no owner yet, set `MANAGER_TENANT_ID` once so setup cannot attach it to the wrong workspace. On an empty database, rerun setup after creating the first workspace.

Authentication and HTTPS enforcement remain identical to main; fake Stripe provisioning and email capture are unchanged.
