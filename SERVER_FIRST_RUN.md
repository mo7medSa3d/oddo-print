# Yasser Server First-Run Guide

This is the canonical first deployment path for a fresh production server.

**Repository:** https://github.com/mo7medSa3d/oddo-print  
**Web app:** Yasser Gateway  
**Customer portal:** `/signup` → `/verify-email` → `/onboarding` → `/login` → `/dashboard`  
**Platform control plane:** `/platform/login`

## 0. What runs on the server

For the Docker deployment, the server runs:

```text
Internet
  ↓
Caddy :80/:443
  ↓
Yasser Gateway :3000
  ↓
PostgreSQL 16
```

The Windows Yasser Agent/Desktop Manager runs at the customer site, not inside the Gateway server.

## 1. Prepare the server

Ubuntu/Debian example:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates openssl
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Create the application directory:

```bash
sudo mkdir -p /opt/yasser
sudo chown "$USER":"$USER" /opt/yasser
cd /opt/yasser
```

Clone the current repository:

```bash
git clone https://github.com/mo7medSa3d/oddo-print.git .
git checkout main
git pull --ff-only origin main
```

Before deployment, record the exact release commit:

```bash
git rev-parse HEAD
```

## 2. Create the DNS record

Create an A/AAAA record for the Gateway domain, for example:

```text
gw.example.com → <SERVER_PUBLIC_IP>
```

Open only the required public ports:

```text
80/tcp   HTTP → Caddy / ACME
443/tcp  HTTPS → Caddy
```

Do not expose PostgreSQL 5432 to the Internet.

## 3. Create production environment

Create `/opt/yasser/.env`.

Minimum production values:

```dotenv
POSTGRES_DB=yasser_db
POSTGRES_USER=odoo_print
POSTGRES_PASSWORD=<long-random-password>

GATEWAY_DOMAIN=gw.example.com
GATEWAY_JWT_SECRET=<random-32+-character-secret>
TRUST_PROXY_SECRET=<different-random-32+-character-secret>

APP_BASE_URL=https://gw.example.com
COOKIE_SECURE=1
TRUST_PROXY=1

MANAGER_USERNAME=admin
MANAGER_PASSWORD_HASH=
```

Generate secrets instead of inventing them:

```bash
openssl rand -base64 48
openssl rand -base64 48
openssl rand -base64 48
```

Do not commit `.env`.

### Email is required for the real first-customer flow

Set:

```dotenv
RESEND_API_KEY=<resend-api-key>
EMAIL_FROM=Yasser <no-reply@example.com>
```

The registration endpoint deliberately keeps its response generic and suppresses provider errors to avoid account enumeration. Therefore a missing/broken email provider can look like a successful signup while leaving the user unable to verify the account. Treat transactional email as a required production dependency, not an optional first-run component.

## 4. Billing plan catalog must exist before onboarding

The customer onboarding UI only shows plans with a valid `stripePriceId`.

For a real deployment, provision at least one Stripe Price in the correct Stripe mode and provide the catalog as `STRIPE_PLAN_CATALOG`.

Example shape:

```bash
export STRIPE_PLAN_CATALOG='[
  {
    "id": "starter",
    "name": "Starter",
    "priceId": "price_XXXXXXXX",
    "currency": "usd",
    "interval": "month",
    "entitlements": {
      "max_agents": 2,
      "max_printers": 5,
      "max_jobs_per_minute": 60,
      "max_concurrent_jobs": 8
    }
  }
]'
```

For paid checkout, also configure:

```dotenv
STRIPE_SECRET_KEY=<stripe-secret>
STRIPE_WEBHOOK_SECRET=<stripe-webhook-secret>
STRIPE_PUBLISHABLE_KEY=<stripe-publishable-key>
```

Do not put monetary amounts in source; the plan catalog is tied to the Stripe Price IDs.

## 5. First deployment

Start the stack:

```bash
cd /opt/yasser
sudo docker compose up -d --build
sudo docker compose ps
```

Expected services:

```text
postgres   healthy
migrate    exited(0)
gateway    running/healthy
caddy      running
```

Check the logs:

```bash
sudo docker compose logs --tail=200 migrate
sudo docker compose logs --tail=200 gateway
sudo docker compose logs --tail=200 caddy
```

## 6. Verify the server before creating a customer

Liveness:

```bash
curl -fsS https://gw.example.com/api/live
```

Expected:

```json
{"ok":true}
```

Database readiness:

```bash
curl -fsS https://gw.example.com/api/health
```

Expected:

```json
{"ok":true}
```

Check TLS:

```bash
curl -I https://gw.example.com/
```

You should get a normal HTTPS response from Caddy/Gateway.

## 7. Provision the plans

Because the compose stack does not automatically create the commercial plan catalog, run:

```bash
cd /opt/yasser
set -a
. ./.env
set +a

sudo -E docker compose run --rm   -e STRIPE_PLAN_CATALOG="$STRIPE_PLAN_CATALOG"   gateway npm run db:provision-plans
```

Verify that the command ends with:

```text
Provisioned N Stripe-backed plan(s).
```

Then confirm the public plan endpoint:

```bash
curl -fsS https://gw.example.com/api/billing/plans
```

It should return at least one plan.

## 8. First customer registration

Open:

```text
https://gw.example.com/signup
```

Create a customer using:

- a real reachable email address;
- a password of at least 12 characters.

The browser calls:

```text
POST /api/auth/register
```

The expected HTTP result is `202`. This does **not** mean the user is verified; it means the account creation flow returned its generic response.

## 9. Email verification

Check the customer's inbox.

The verification link opens:

```text
https://gw.example.com/verify-email?token=...
```

The page calls:

```text
POST /api/auth/verify-email
```

A successful verification:

1. consumes the one-time token;
2. marks the user verified;
3. creates the first workspace if the user has no membership yet;
4. creates a customer/manager session cookie;
5. redirects to `/onboarding`.

The verification token expires after 30 minutes.

## 10. First workspace setup

On `/onboarding`:

1. Enter the workspace name.
2. Select a provisioned plan.
3. Choose **Start trial** or **Continue to checkout**.

For a trial, the server creates a 30-day `trialing` subscription for that workspace.

For checkout, the browser is redirected to Stripe after the Gateway validates the selected plan.

Do not skip plan provisioning; an empty plan catalog means onboarding cannot complete.

## 11. Customer login

After verification and workspace setup, open:

```text
https://gw.example.com/login
```

Enter the same customer email/password.

The browser calls:

```text
POST /api/auth/login
```

For one workspace, the Gateway returns `200` and sets the `mgr_session` HttpOnly cookie.

For multiple workspaces, login returns `409` with a short-lived selection token and workspace IDs; the UI then calls:

```text
POST /api/auth/select-tenant
```

The selected active workspace is then stored in a new server-side session.

## 12. Verify the authenticated Gateway session

From the same browser session, request:

```text
GET /api/auth/me
```

Expected shape:

```json
{
  "authenticated": true,
  "tenantId": "ten_...",
  "userId": "usr_...",
  "role": "owner",
  "exp": 1234567890
}
```

From curl, use a cookie jar:

```bash
curl -i -c /tmp/yasser-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}' \
  https://gw.example.com/api/auth/login
```

Then:

```bash
curl -i -b /tmp/yasser-cookies.txt \
  https://gw.example.com/api/auth/me
```

Do not paste the cookie/token into tickets, chat, or logs.

## 13. Verify logout

```bash
curl -i -b /tmp/yasser-cookies.txt \
  -X POST \
  https://gw.example.com/api/auth/logout
```

Then:

```bash
curl -i -b /tmp/yasser-cookies.txt \
  https://gw.example.com/api/auth/me
```

Expected result: `401` / `authenticated: false`.

## 14. Create and pair a Yasser Agent

Sign in to the customer Gateway dashboard:

```text
https://gw.example.com/dashboard
```

Create an Agent from the dashboard. The Gateway generates a one-time pairing code.

On the Windows machine, install the Yasser Print Manager / Yasser Agent bundle.

Run the bundled CLI from an elevated Administrator terminal:

```powershell
yasser-agent-cli.exe -pair <PAIRING_CODE> -server https://gw.example.com
```

The pairing code expires after 10 minutes.

The Agent then starts using the canonical Windows service configuration under the Yasser Agent runtime data directory.

## 15. Verify Agent heartbeat

Back in:

```text
https://gw.example.com/dashboard
```

The Agent should move from offline to online after heartbeat registration.

The Gateway uses heartbeat freshness, not only the persisted status field, to determine effective online availability.

A stale heartbeat is treated as offline.

## 16. Register/discover a printer on the Agent

Examples:

Network ESC/POS:

```powershell
yasser-agent-cli.exe printers add --name "Kitchen" --type network --endpoint 192.168.1.50:9100 --protocol escpos --device-class thermal
```

Windows spooler:

```powershell
yasser-agent-cli.exe printers add --name "HP LaserJet" --type spooler --spooler-name "HP LaserJet" --protocol spooler --device-class laser
```

List local printers:

```powershell
yasser-agent-cli.exe printers list
```

Use discovery only when appropriate:

```powershell
yasser-agent-cli.exe printers discover
```

The test-print path for an already selected printer does not perform a network discovery scan.

## 17. Gateway test print

From the Gateway dashboard, select the printer and use its **Test Print** action.

The Gateway creates a real durable `test_page` job.

The flow is:

```text
Browser
  → Gateway
  → durable print_jobs row
  → Agent claim
  → Agent physical transport
  → Printer
```

The dashboard should show the job moving through its runtime lifecycle.

A successful HTTP submission means the job was accepted by the Gateway queue; it is not by itself proof that paper physically came out.

## 18. Direct Agent printer test

For an already registered local printer:

```powershell
yasser-agent-cli.exe printers list
yasser-agent-cli.exe printers test <PRINTER_ID>
```

The command reports byte submission to the selected local transport.

This is separate from the Gateway dashboard test path.

## 19. Odoo integration test

After Gateway + Agent + Printer are healthy:

1. Install/upgrade the `print_gateway` Odoo 19 addon.
2. Set the Gateway URL and Gateway API key in Odoo.
3. Test the connection.
4. Create the required Print Binding.
5. Run a normal Odoo backend report.
6. Run a POS receipt / Print Bill / kitchen preparation path.
7. Verify the job appears in the Gateway dashboard.
8. Verify the job reaches the intended Agent and Printer.
9. Verify Gateway-disabled mode still follows native Odoo printing.

The Odoo addon remains the Odoo integration layer; product branding is Yasser Print Manager / Yasser Agent.

## 20. Platform Control Plane (optional, operator-only)

The customer flow does not require the platform control plane.

For platform administration, bootstrap the first Platform Owner from the server:

```bash
cd /opt/yasser
export PLATFORM_OWNER_EMAIL='owner@example.com'
export PLATFORM_OWNER_PASSWORD='use-a-long-secret'
sudo -E docker compose run --rm gateway npm run platform:bootstrap
```

Then open:

```text
https://gw.example.com/platform/login
```

Sign in with the Platform Owner email/password.

This is separate from the normal customer `/login` flow.

## 21. Final release smoke checklist

Run these in order:

```bash
curl -fsS https://gw.example.com/api/live
curl -fsS https://gw.example.com/api/health
curl -fsS https://gw.example.com/api/billing/plans

sudo docker compose ps
sudo docker compose logs --tail=100 gateway
```

Then verify in the browser:

```text
/signup
  → email arrives
  → /verify-email
  → /onboarding
  → /dashboard
  → logout
  → /login
  → /dashboard
```

Then verify infrastructure:

```text
Gateway
  → create Agent
  → pair Windows Yasser Agent
  → Agent online
  → printer visible
  → Gateway Test Print
  → job lifecycle visible
```

Then verify Odoo:

```text
Odoo 19
  → Gateway configuration
  → Test Connection
  → binding
  → backend report
  → POS receipt/kitchen
  → Gateway job visible
```

## 22. Important production notes

- Do not expose PostgreSQL publicly.
- Do not use `ALLOW_PLAINTEXT_MANAGER_PASSWORD=1` in production.
- Keep `COOKIE_SECURE=1` behind HTTPS.
- Keep `TRUST_PROXY=1` only with the trusted Caddy proxy path and matching `TRUST_PROXY_SECRET`.
- Keep all secrets out of Git.
- Back up the PostgreSQL volume before upgrades.
- Run database migrations before the Gateway application rollout.
- Physical printer output must be validated on real hardware; source-level tests cannot prove paper delivery.
- The repository's historical audit reports are retained for engineering history and are explicitly marked Historical / Superseded.

## Current authentication map

```text
Customer:
  /signup
    ↓
  /verify-email
    ↓
  /onboarding
    ↓
  /login
    ↓
  /dashboard

Existing customer with multiple workspaces:
  /login
    ↓
  409 + selectionToken
    ↓
  /api/auth/select-tenant
    ↓
  /dashboard

Platform operator:
  /platform/login
    ↓
  /platform/dashboard
```
