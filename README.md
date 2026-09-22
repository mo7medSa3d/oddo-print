# Yasser — Cloud Printing Platform

Silent Odoo enterprise printing through Yasser Gateway, Yasser Agent, and Yasser Print Manager.

```text
Odoo ERP
  -> Yasser Gateway (HTTPS / WSS)
  -> Central Print Router
  -> Yasser Agent / Yasser Print Manager
  -> Physical Hardware Printers
```

## Ownership

Odoo owns companies/branches, business records, POS configuration, report context, and print intent.
The addon stores only Gateway connection settings, native Odoo print bindings, and a durable print outbox.
Gateway owns agents, heartbeats, runtime printers, queueing, delivery, and execution state.

The addon does not create or synchronize branches, agents, printers, destinations, or document types.

## Odoo configuration

Normal operation requires only Gateway URL, API Key, Test Connection, and Gateway Printing Enabled.

The primary binding is `Destination + Document Type -> Printer`.
The destination is an existing Odoo object such as POS configuration, warehouse operation type, report action, or company context. The printer id is a Gateway runtime identity and is never provisioned by the addon.

## Printing

Backend reports use `print_gateway.print_router` from the `ir.actions.report.report_action()` integration hook.
POS printing uses the Odoo 19 `PosStore.printReceipt()` hook, covering receipt print, POS reprint, and Restaurant Print Bill paths.

When Gateway printing is enabled, printing is silent: no browser print dialog, PDF navigation, `window.print()`, or native fallback is allowed. Failures are surfaced to the user.

When Gateway printing is disabled, the native Odoo print path is preserved.

## Reliability

Each logical print operation creates one durable Odoo outbox row and one idempotency key before external submission. Retries reuse that key. Gateway-side idempotency prevents transport retries from creating a second logical print job.

A transport interruption is represented as an unknown physical outcome until Gateway status reconciliation establishes the result.

## Gateway API key

Managers can generate an Odoo API key, copy the raw value once, and revoke it. Gateway stores only the cryptographic hash and never returns raw secrets from list/read endpoints.

## Platform plans and entitlements

The Platform Control Plane manages the commercial plan catalog at `/platform/plans`.
A plan contains the Yasser-side entitlements `max_agents`, `max_printers`, `max_jobs_per_minute`, and `max_concurrent_jobs`.
These limits are enforced server-side from the tenant's current subscription plan; they are not UI-only values.

Stripe remains the source of truth for money and recurring billing. Create the Stripe Product/Price in Stripe, then bind its `price_...` (and optional `prod_...`) ID to the Yasser plan. Gateway validates that the Price is recurring and matches the plan currency/interval before a plan can become billable. Existing subscriptions continue using their current Stripe subscription price even when the plan's current price reference is changed for future checkout.

Plan `Active` controls whether new customer checkout can use the plan. `Public` controls whether it appears in the public pricing/onboarding catalog. Archiving or hiding a plan does not remove entitlements from existing subscriptions. During Stripe `past_due` recovery, printing remains available; `unpaid`, `paused`, and canceled states do not provision runtime entitlements. A paused subscription resumes through Stripe's subscription resume API after a valid payment method is available.

Customer Portal must be configured in Stripe with the Yasser subscription Prices you intend to offer for upgrades/downgrades. Portal changes are synchronized back through `customer.subscription.updated` webhooks.

The legacy `STRIPE_PLAN_CATALOG` / `npm run db:provision-plans` path remains available for first-boot/operator provisioning; Platform Admin changes to the managed catalog fields are preserved across subsequent provisioning runs.

## Development

```bash
Node.js 24.21.0 is the project runtime baseline.

npm ci
npm run typecheck
npm run lint
npm test
npm run build
cd agent && go test ./... && go test -race ./...
```

PostgreSQL, Odoo 19, Windows, and physical-printer E2E are release gates and must only be reported as passing when the real environment has executed them.

For a production server first deployment and end-to-end smoke test, follow [SERVER_FIRST_RUN.md](SERVER_FIRST_RUN.md).

See [API.md](API.md), [INSTALLATION.md](INSTALLATION.md), [DEPLOYMENT.md](DEPLOYMENT.md), [OPERATIONS.md](OPERATIONS.md), and [SECURITY.md](SECURITY.md).

