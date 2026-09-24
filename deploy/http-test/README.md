# Yasser HTTP Test Deployment

This is an isolated deployment path for validating the real Gateway runtime before a public Domain/TLS is introduced.

It intentionally uses:

- Yasser Gateway in production runtime mode.
- PostgreSQL 16.
- Caddy as an HTTP-only reverse proxy.
- `COOKIE_SECURE=0` only under `YASSER_HTTP_TEST_MODE=1`.
- Local verification-email capture instead of Resend.
- A fake Stripe Price ID only for the trial/onboarding test; HTTP test mode does not contact Stripe when provisioning this isolated plan.
- A fixed test-only platform tenant identity (`http-test-platform`) so the production lifecycle protection check remains enabled.
- No public PostgreSQL port.
- No dependency on the production `GATEWAY_DOMAIN`.

## Start

From the repository root:

`bash deploy/http-test/setup-http-test.sh`

The script generates real random test secrets, detects the server public IPv4, chooses port 80 when free (otherwise 8080), starts the stack, waits for health, and provisions the test plan.

## Full first-run auth smoke

`bash deploy/http-test/smoke-http-test.sh`

The smoke creates a fresh test user on every run and verifies:

`signup → verification email capture → verification → first workspace/trial → login → /api/auth/me → logout`

The captured verification link is stored under:

`deploy/http-test/test-data/verification-email.txt`

## Agent

Use the Gateway URL printed by the setup script and pair the Agent with it:

`powershell -ExecutionPolicy Bypass -File .\deploy\http-test\windows-agent-http-test.ps1 -ServerUrl "http://SERVER_IP[:PORT]" -PairingCode "PAIRING_CODE"`

## Odoo

Use the Gateway URL from setup and set:

`ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP=1`

Do not keep the HTTP test flag when moving to the real Domain + HTTPS deployment.
