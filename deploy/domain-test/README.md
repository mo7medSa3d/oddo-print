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

## Fresh single-workspace staging

The shared HTTPS staging environment is configured to allow exactly one
workspace. Login never creates a workspace. The first verified signup can
create one; further registrations return STAGING_WORKSPACE_EXISTS. A
transaction-level PostgreSQL lock prevents two simultaneous verifications
from creating two tenants. Production continues to support multiple tenants.
The old HTTP smoke script created a disposable tenant per run; it is now
disabled unless explicitly opted into on an isolated loopback instance.

The accumulated accounts can be replaced with a new, clean staging database
without issuing unsafe foreign-key DELETEs. This also resets staging printer
registrations, Odoo API keys, pairing, test accounts, and session history in
the active environment. Backups retain all original data for recovery.

On the staging server, update the test branch without overwriting local edits.
Then run these two commands from /opt/yasser:

    bash deploy/domain-test/reset-staging-workspace.sh --dry-run
    bash deploy/domain-test/reset-staging-workspace.sh --apply

The apply step requires typing RESET HTTPS STAGING. It takes a PostgreSQL
custom-format dump, validates the archive with pg_restore, creates a private
environment backup, and only then switches to a brand-new Docker volume with
rotated staging credentials. It never runs docker volume rm or down -v.
Backups are private under your home directory at ~/.local/share/yaseir-staging-backups (outside the Git working tree). The original volume survives
unchanged. Keep it until you confirm the new environment works and choose a
safe retention policy.

After reset, visit https://print.yaseir.cloud/signup, register the single
intended account, verify its email, set a new password and complete onboarding
using the HTTP Test plan with a 30-day trial. The test-only verification email
is captured in the Gateway container at
/tmp/yaseir-domain-test-verification-email.txt. Read the captured email from
the VM, never paste the one-time token into public chats. After the single
signup, rerun bash deploy/domain-test/setup-domain-test.sh to bind the domain
to the new workspace; future self-signups remain blocked.

The new workspace must re-pair Windows Agents and regenerate Odoo API keys.
Platform Owner credentials must be bootstrapped separately using the project's
platform:bootstrap command. Old logins and API keys no longer work in the
fresh staging database. This operation must never be used on production.


### Creating a Go plan with staging's test Stripe Price

The HTTPS staging Gateway has **two explicitly allowlisted fake Stripe
Price IDs**: `price_http_test_yasser` and `price_go_yasser`. The Go
fixture is USD/month and allows the Platform Owner to create a Go plan
from **Platform → Plans** using that exact fake price, without a live
Stripe account. It does **not** charge money or create a real Stripe
Price: production continues to validate recurring Prices against Stripe.

Run `bash deploy/domain-test/setup-domain-test.sh` after updating this
branch. The setup script upgrades the original *stock* one-price catalog
to the two-price version while **preserving customised catalogs**. If
the server has a custom `STRIPE_PLAN_CATALOG`, review it before adding
`price_go_yasser` with currency `usd` and interval `month`; the
Gateway rejects prices not explicitly registered there. Avoid sharing
the entire .env file because it also contains secret values. Recheck
the allowed IDs without printing secrets:

```bash
cd /opt/yasser
grep '^STRIPE_PLAN_CATALOG=' deploy/domain-test/.env.domain-test | grep -o 'price_[a-zA-Z0-9_]*'
```

No Go database plan is auto-created: the Platform Owner still chooses
its limits, visibility and name in the web editor. Existing customer
subscriptions remain unchanged. New test prices do not constitute
verified payment-provider prices.

## Renew an expired HTTP Test trial (one tenant only)

The `http-test` plan is a 30-day staging trial. When it expires, the
subscription row can still say `trialing`, but the protected printing
entitlement correctly denies access. Deployment deliberately does **not**
auto-renew trials. Do not modify `tenant_subscriptions` in production.

From **Platform → Subscriptions**, confirm the exact tenant ID of the
logged-in workspace and the previous period end. For the reported incident the
old end timestamp was `2026-10-18T23:51:02.856Z`. Then on the staging VM:

```bash
cd /opt/yasser
git switch test/http-server-ready
git status --short
# Resolve any local changes before fetching; never use reset --hard.
git pull --ff-only origin test/http-server-ready

ENV_FILE=deploy/domain-test/.env.domain-test
COMPOSE=deploy/domain-test/docker-compose.yml
TENANT_ID=ten_REPLACE_WITH_VERIFIED_TENANT_ID

docker compose --env-file "$ENV_FILE" -f "$COMPOSE" exec -T postgres \
  sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' sh \
  -v "tenant_id=$TENANT_ID" \
  -v "expected_period_end=2026-10-18T23:51:02.856Z" \
  < deploy/domain-test/renew-expired-trial.sql
```

The transaction fails closed if the database is not `yasser_http_test`,
the tenant or exact old expiration differs, the workspace is disabled, the
trial is still live, or the subscription has Stripe billing, block flags or
pending checkout. Only the specified unlinked expired `http-test` trial is
extended **30 days**. The old usage history is preserved, a new billing
period begins, and an audit event is recorded. Check the output includes
`COMMIT`; then refresh
`https://print.yaseir.cloud/api/billing/status?includePlanName=1`
while authenticated. It should show `hasSubscription: true` and the
plan name again. This does not require a new Gateway image.

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
