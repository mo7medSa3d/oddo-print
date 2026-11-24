import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { db } from "../src/db";
import { managerSessions } from "../src/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { applyMigrations, closePool, hasTestDatabase, pool, truncateAll } from "./helpers/pg";
import {
  revokeLegacyManagerSessionsForUserInTransaction,
  revokeManagerSession,
} from "../src/lib/manager-auth";

/**
 * TEN-03: session revocation must be tenant-scoped where the caller knows the
 * tenant, while account-level security events (password reset, email
 * verification) intentionally revoke every session of that account.
 */
const suite = describe.skipIf(!hasTestDatabase);

suite("tenant-scoped session revocation", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => {
    await truncateAll();
    for (const tenantId of ["tenant_a", "tenant_b"]) {
      await pool().query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, `Tenant ${tenantId}`]);
    }
    await pool().query(
      "INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, clock_timestamp())",
      ["user_shared", "shared@example.test", "unused"],
    );
    for (const tenantId of ["tenant_a", "tenant_b"]) {
      await pool().query(
        "INSERT INTO tenant_users (user_id, tenant_id, role) VALUES ($1, $2, 'admin')",
        ["user_shared", tenantId],
      );
    }
  });

  async function insertLegacySession(jti: string, tenantId: string, userId = "user_shared"): Promise<void> {
    await pool().query(
      "INSERT INTO manager_sessions (jti, tenant_id, user_id, role, expires_at) VALUES ($1, $2, $3, 'admin', clock_timestamp() + interval '1 hour')",
      [jti, tenantId, userId],
    );
  }

  async function revokedAt(jti: string): Promise<Date | null> {
    const row = await db.query.managerSessions.findFirst({ where: eq(managerSessions.jti, jti) });
    return row?.revokedAt ?? null;
  }

  it("logout revocation stays inside the caller's tenant", async () => {
    await insertLegacySession("jti_a", "tenant_a");
    await insertLegacySession("jti_b", "tenant_b");

    await revokeManagerSession("jti_a", "tenant_a");

    expect(await revokedAt("jti_a")).not.toBeNull();
    // The same account's session in another tenant must survive a
    // workspace-scoped logout.
    expect(await revokedAt("jti_b")).toBeNull();
  });

  it("a tenant-scoped revocation never touches another tenant's session with the same jti", async () => {
    await insertLegacySession("jti_only_b", "tenant_b");

    // Revoking with a mismatched tenant must not revoke the row.
    await revokeManagerSession("jti_only_b", "tenant_a");

    expect(await revokedAt("jti_only_b")).toBeNull();
  });

  it("account-wide revocation intentionally clears every tenant of that user", async () => {
    await insertLegacySession("jti_a", "tenant_a");
    await insertLegacySession("jti_b", "tenant_b");

    // Password reset / email verification path: no tenant scope, so all of the
    // account's legacy sessions are revoked on purpose.
    await db.transaction((tx) => revokeLegacyManagerSessionsForUserInTransaction(tx, "user_shared"));

    expect(await revokedAt("jti_a")).not.toBeNull();
    expect(await revokedAt("jti_b")).not.toBeNull();
  });

  it("tenant-scoped user revocation leaves other tenants untouched", async () => {
    await insertLegacySession("jti_a", "tenant_a");
    await insertLegacySession("jti_b", "tenant_b");

    await db.transaction((tx) =>
      revokeLegacyManagerSessionsForUserInTransaction(tx, "user_shared", "tenant_a"),
    );

    expect(await revokedAt("jti_a")).not.toBeNull();
    expect(await revokedAt("jti_b")).toBeNull();
  });

  it("revocation never leaves a session row partially written", async () => {
    await insertLegacySession("jti_a", "tenant_a");
    await revokeManagerSession("jti_a", "tenant_a");
    const row = await db.query.managerSessions.findFirst({
      where: and(eq(managerSessions.jti, "jti_a"), isNull(managerSessions.revokedAt)),
    });
    expect(row).toBeUndefined();
  });
});
