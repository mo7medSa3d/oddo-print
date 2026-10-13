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

## E2E Capture test (staging only)

The domain staging deploy script writes `YASEIR_E2E_CAPTURE_ENABLED=1` to
`deploy/domain-test/.env.domain-test` **if the setting is absent**. The staging
Compose file passes it to the Gateway service; production's separate Compose
configuration still defaults to `0`. An explicit existing `0` in staging is
preserved, so the feature can be disabled without modifying source code.

Redeploy with the usual script after updating the staging branch. It checks
`GET /api/odoo/test-captures` **without an API key**: HTTP `401` means the
feature-gated endpoint is present, while `404` indicates the capture route is
missing or disabled. The smoke script checks the same endpoint by default; set
`SMOKE_EXPECT_E2E_CAPTURE=0` only if intentionally opting out.

For an assigned **Windows Agent**, independently opt into simulation in its
protected YAML configuration and restart the Agent service:

```yaml
server:
  url: https://print.yaseir.cloud
  e2e_capture_tests: true
```

This does not install a virtual printer, print paper, use a Windows spooler
queue, or change production print-job status. With an offline Agent, an accepted
capture stays queued until it reconnects or the test expires. The Agent setting
cannot be changed by deploying the Gateway; configure it on the Windows host.
Odoo 19 must have the updated `print_gateway` addon installed/upgraded for the
wizard and its readonly Agent picker fix to appear.

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

The setup script migrates the database and configures the public HTTPS deployment before starting the Gateway. Workspace-domain binding is optional: it preserves an existing owner or registers `print.yaseir.cloud` automatically when there is one active non-platform workspace. With no eligible workspace or several possible owners, it skips binding and continues deployment without choosing an arbitrary workspace. Set `MANAGER_TENANT_ID` only when you deliberately want to select an existing active workspace as the domain owner. Conflicting or invalid explicit owners still fail. Reruns preserve the database, accounts, secrets, and existing domain owner.

Authentication and HTTPS enforcement remain identical to main; fake Stripe provisioning and email capture are unchanged.
