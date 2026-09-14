/**
 * Test-group source of truth.
 *
 * These suites require a real PostgreSQL database and therefore belong to the
 * integration group. Keep this list synchronized with DATABASE_URL-gated tests.
 */
export const integrationTestFiles = [
  "tests/agent-deletion.test.ts",
  "tests/agent-registration.test.ts",
  "tests/architecture-pg.test.ts",
  "tests/auth-rate-limit.test.ts",
  "tests/batch-status.test.ts",
  "tests/dashboard-payload-projection.test.ts",
  "tests/discovery-approval.test.ts",
  "tests/e2e-job-flow.test.ts",
  "tests/health.test.ts",
  "tests/heartbeat-enabled.test.ts",
  "tests/job-maintenance.test.ts",
  "tests/job-status-postgres-concurrency.test.ts",
  "tests/legacy-print-authorization.test.ts",
  "tests/lifecycle-delivery.test.ts",
  "tests/manager-auth.test.ts",
  "tests/migration-upgrade.integration.test.ts",
  "tests/multi-instance-gateway.test.ts",
  "tests/print-idempotency.test.ts",
  "tests/routing-availability.test.ts",
  "tests/runtime-constraints.test.ts",
  "tests/tenant-isolation.test.ts",
  "tests/ws-claim-delivery.test.ts",
  "tests/ws-listener-setup-race.test.ts",
  "tests/ws-socket-cap.test.ts",
  "tests/ci-tripwire.check.ts",
] as const;

export const integrationVitestTestFiles = integrationTestFiles.filter((file) => file.endsWith(".test.ts"));
