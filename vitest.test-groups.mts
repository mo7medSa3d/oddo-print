/**
 * Canonical test classification shared by the unit and PostgreSQL integration
 * Vitest configs and by the classification contract test.
 *
 * Keep database-dependent suites here. Unit tests must remain runnable without
 * PostgreSQL or other external services.
 */
export const integrationVitestTestFiles = [
  "tests/control-plane-concurrency.integration.test.ts",
  "tests/agent-deletion.test.ts",
  "tests/agent-lifecycle.integration.test.ts",
  "tests/agent-registration.test.ts",
  "tests/architecture-pg.test.ts",
  "tests/auth-rate-limit.test.ts",
  "tests/session-tokens.integration.test.ts",
  "tests/batch-status.test.ts",
  "tests/odoo-gateway-activation-sync.test.ts",
  "tests/odoo-configuration-billing-race.integration.test.ts",
  "tests/agent-heartbeat-pagination.test.ts",
  "tests/billing-webhook-concurrency.integration.test.ts",
  "tests/billing-webhook.test.ts",
  "tests/database-clock.integration.test.ts",
  "tests/billing-entitlement-access.test.ts",
  "tests/odoo-runtime-discovery-billing.integration.test.ts",
  "tests/checkout-plan-conflict.integration.test.ts",
  "tests/dashboard-payload-projection.test.ts",
  "tests/discovery-approval.test.ts",
  "tests/e2e-job-flow.test.ts",
  "tests/health.test.ts",
  "tests/heartbeat-enabled.test.ts",
  "tests/job-maintenance.test.ts",
  "tests/job-status-postgres-concurrency.test.ts",
  "tests/print-quota.test.ts",
  "tests/legacy-print-authorization.test.ts",
  "tests/lifecycle-delivery.test.ts",
  "tests/manager-auth.test.ts",
  "tests/migration-upgrade.integration.test.ts",
  "tests/multi-instance-gateway.test.ts",
  "tests/platform-control-plane.test.ts",
  "tests/platform-stats.test.ts",
  "tests/printer-desired-state.test.ts",
  "tests/print-idempotency.test.ts",
  "tests/routing-availability.test.ts",
  "tests/runtime-constraints.test.ts",
  "tests/tenant-isolation.test.ts",
  "tests/tenant-lifecycle.integration.test.ts",
  "tests/trial-conversion.integration.test.ts",
  "tests/ws-claim-delivery.test.ts",
  "tests/ws-listener-setup-race.test.ts",
  "tests/ws-socket-cap.test.ts",
] as const;

export const integrationTestFiles = [
  ...integrationVitestTestFiles,
  "tests/ci-tripwire.check.ts",
] as const;