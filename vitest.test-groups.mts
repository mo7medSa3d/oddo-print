/**
 * Canonical test classification shared by the unit and PostgreSQL integration
 * Vitest configs and by the classification contract test.
 *
 * Keep database- and production-build-dependent suites here. Unit tests must
 * remain runnable without PostgreSQL, a production build or external services.
 */
// The license-only control-plane schema retired the printing/fleet runtime.
// Suites that only assert those removed tables and routes are parked here and
// re-enabled when that runtime returns; the rest of the integration group is
// unchanged.
const retiredPrintingRuntimeSuites = [
  "tests/architecture-pg.test.ts",
  "tests/ci-tripwire.check.ts",
  "tests/odoo-auto-enrollment.integration.test.ts",
  "tests/odoo-legacy-resolution-inventory-live-authority.integration.test.ts",
  "tests/platform-database-live-authority.integration.test.ts",
  "tests/platform-stats-live-authority.integration.test.ts",
  "tests/runtime-constraints.test.ts",
  "tests/tenant-batch-fencing.integration.test.ts",
] as const;

export const integrationVitestTestFiles = [
  "tests/agent-identity-isolation.integration.test.ts",
  "tests/agent-lifecycle.integration.test.ts",
  "tests/billing-entitlement-access.test.ts",
  "tests/billing-page-snapshot-live-owner.integration.test.ts",
  "tests/billing-status-live-authority.integration.test.ts",
  "tests/billing-usage-live-owner.integration.test.ts",
  "tests/customer-workspace-options.integration.test.ts",
  "tests/dashboard-current-authority.integration.test.ts",
  "tests/database-clock.integration.test.ts",
  "tests/email-auth-token-lifetime.integration.test.ts",
  "tests/health.test.ts",
  "tests/invitation-onboarding.integration.test.ts",
  "tests/job-history-tenant-collision.integration.test.ts",
  "tests/job-release-guard.integration.test.ts",
  "tests/manager-auth.test.ts",
  "tests/manual-billing-history-migration.integration.test.ts",
  "tests/manual-only-billing-migration.integration.test.ts",
  "tests/manual-subscriptions.integration.test.ts",
  "tests/migration-upgrade.integration.test.ts",
  "tests/no-step-up.integration.test.ts",
  "tests/odoo-accepted-replay-purity.integration.test.ts",
  "tests/odoo-cutover-locking.integration.test.ts",
  "tests/odoo-installation-directory-live-authority.integration.test.ts",
  "tests/odoo-keys-inventory-live-authority.integration.test.ts",
  "tests/odoo-manual-enrollment.integration.test.ts",
  "tests/password-auth-migration.integration.test.ts",
  "tests/password-only-auth.integration.test.ts",
  "tests/physical-history-migration.integration.test.ts",
  "tests/platform-confidential-read-race.integration.test.ts",
  "tests/platform-control-plane.test.ts",
  "tests/platform-explorer-pagination.integration.test.ts",
  "tests/platform-owner-invitation-session.integration.test.ts",
  "tests/printer-desired-state.test.ts",
  "tests/queue-payload-budget.test.ts",
  "tests/server-http-acceptance.test.ts",
  "tests/session-account-inventory.integration.test.ts",
  "tests/session-inventory-live-authority.integration.test.ts",
  "tests/session-inventory.integration.test.ts",
  "tests/session-legacy-fallback.integration.test.ts",
  "tests/session-login-replacement.integration.test.ts",
  "tests/session-logout.integration.test.ts",
  "tests/session-renewal-lifecycle.integration.test.ts",
  "tests/session-tokens.integration.test.ts",
  "tests/settings-live-authority.integration.test.ts",
  "tests/subscription-owner-directory-live-authority.integration.test.ts",
  "tests/team-directory-live-authority.integration.test.ts",
  "tests/team-invitation-audit-actor.integration.test.ts",
  "tests/team-invitation-read-authority.integration.test.ts",
  "tests/tenant-lifecycle.integration.test.ts",
  "tests/tenant-scoped-session-revocation.integration.test.ts",
  "tests/workspace-invitation-independent.integration.test.ts",
] as const;

export const integrationTestFiles = [
  ...integrationVitestTestFiles,
] as const;

export { retiredPrintingRuntimeSuites };
