import { sql, type SQL } from "drizzle-orm";

// The test gateway is not a production sign-up service: once provisioned it
// accepts logins/invitations to the existing workspace, not new tenants.
// This switch cannot be enabled accidentally on a production deployment.
export function isSingleWorkspaceStaging(): boolean {
  return process.env.YASEIR_HTTP_TEST_MODE === "1" &&
    process.env.YASEIR_STAGING_SINGLE_WORKSPACE === "1" &&
    process.env.APP_BASE_URL === "https://print.yaseir.cloud";
}

export const STAGING_WORKSPACE_EXISTS_MESSAGE =
  "This staging Gateway already has a workspace. Sign in to the existing workspace; ask its owner for access.";

export class StagingWorkspaceExistsError extends Error {
  readonly code = "STAGING_WORKSPACE_EXISTS";
  constructor() {
    super(STAGING_WORKSPACE_EXISTS_MESSAGE);
    this.name = "StagingWorkspaceExistsError";
  }
}

type SqlRunner = { execute(statement: SQL): Promise<{ rows: unknown[] }> };

export async function stagingWorkspaceExists(runner: SqlRunner): Promise<boolean> {
  if (!isSingleWorkspaceStaging()) return false;
  const platformTenantId = process.env.PLATFORM_TENANT_ID ?? "http-test-platform";
  // Include suspended tenants: they must not silently free a second workspace
  // slot. The old staging data must be explicitly archived/reset by an operator.
  const existing = await runner.execute(sql`
    SELECT id FROM tenants
    WHERE id <> ${platformTenantId} AND lifecycle <> 'deleted'
    LIMIT 1
  `);
  return existing.rows.length > 0;
}

export async function assertStagingWorkspaceSlot(runner: SqlRunner): Promise<void> {
  if (!isSingleWorkspaceStaging()) return;
  // Both competing verification transactions take this lock before checking
  // the one-workspace invariant and inserting the first tenant. The lock is
  // released at COMMIT/ROLLBACK and cannot be bypassed by a preflight race.
  await runner.execute(sql`SELECT pg_advisory_xact_lock(hashtext('yaseir-staging-single-workspace'))`);
  if (await stagingWorkspaceExists(runner)) throw new StagingWorkspaceExistsError();
}
