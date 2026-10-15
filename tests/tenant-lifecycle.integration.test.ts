import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db } from "../src/db";
import { tenants, users, tenantUsers } from "../src/db/schema";
import { issueSessionPair, rotateRefreshToken, type RefreshResult } from "../src/lib/session-tokens";
import { eq } from "drizzle-orm";
import { hasTestDatabase, applyMigrations, closePool, pool } from "./helpers/pg";
import { transitionTenantLifecycle, TenantLifecycleError } from "../src/lib/tenant-lifecycle";
import { requireActiveTenant, requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../src/lib/tenant-guard";
import { nanoid } from "../src/lib/nanoid";
import { verifyPlatformTokenSignature, PlatformMutationAuthorityChangedError } from "../src/lib/platform-auth";
import { generateOpaqueToken, hashPassword, hashToken, normalizeEmail, verifyPassword } from "../src/lib/password";
import { POST as verifyEmail } from "../src/app/api/auth/verify-email/route";
import { POST as resetPassword } from "../src/app/api/auth/reset-password/route";
import { authenticateForTenant } from "../src/lib/customer-auth";

const suite = describe.skipIf(!hasTestDatabase);

function tenantId() {
  return `tenant_lifecycle_test_${nanoid(8)}`;
}

async function createTestTenant(id: string, name = "Test Tenant") {
  await db.insert(tenants).values({ id, name });
}

suite("Tenant Lifecycle", () => {
  beforeAll(async () => {
    vi.stubEnv("GATEWAY_JWT_SECRET", "tenant-lifecycle-test-secret-32-characters");
    await applyMigrations();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });

  describe("mailbox-owner password setup", () => {
    it("invalidates a preregistrant password before email proof becomes usable, then completes owner setup", async () => {
      const userId = `usr_setup_${nanoid(12)}`;
      const email = normalizeEmail(`setup_${nanoid(10)}@example.test`);
      const oldPassword = "attacker_preset_password_123";
      const ownerPassword = "mailbox_owner_password_456";
      const proof = generateOpaqueToken();
      const olderReset = generateOpaqueToken();
      await db.insert(users).values({ id: userId, email, passwordHash: await hashPassword(oldPassword) });
      await pool().query("INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '10 minutes')", [`evt_${nanoid(12)}`, userId, await hashToken(proof)]);
      await pool().query("INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '10 minutes')", [`prt_${nanoid(12)}`, userId, await hashToken(olderReset)]);

      const response = await verifyEmail(new Request("http://gateway.test/api/auth/verify-email", {
        method: "POST", body: JSON.stringify({ token: proof }),
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.json();
      expect(result.requiresPasswordSetup).toBe(true);
      const destination = new URL(result.next, "http://gateway.test");
      expect(destination.pathname).toBe("/reset-password");
      expect(destination.searchParams.get("setup")).toBe("1");
      const resetToken = destination.searchParams.get("token");
      expect(resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const current = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(current?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(await verifyPassword(oldPassword, current!.passwordHash)).toBe(false);
      const membership = await db.query.tenantUsers.findFirst({ where: eq(tenantUsers.userId, userId) });
      expect(membership?.role).toBe("owner");
      expect(await authenticateForTenant(email, oldPassword, membership!.tenantId)).toBeNull();
      const preSetupSessions = await pool().query("SELECT id FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
      expect(preSetupSessions.rows).toHaveLength(0);
      const oldReset = await pool().query("SELECT consumed_at FROM password_reset_tokens WHERE token_hash = $1", [await hashToken(olderReset)]);
      expect(oldReset.rows[0].consumed_at).not.toBeNull();

      const resetRequest = () => new Request("http://gateway.test/api/auth/reset-password", {
        method: "POST", body: JSON.stringify({ token: resetToken, password: ownerPassword }),
      });
      const saved = await resetPassword(resetRequest());
      expect(saved.status).toBe(200);
      expect(saved.headers.get("set-cookie")).toBeNull();
      const identity = await authenticateForTenant(email, ownerPassword, membership!.tenantId);
      expect(identity?.userId).toBe(userId);
      expect(await authenticateForTenant(email, oldPassword, membership!.tenantId)).toBeNull();
      const pair = await issueSessionPair({ kind: "customer", userId, tenantId: membership!.tenantId, role: "owner", email, credentialVersion: identity!.credentialVersion });
      expect(pair.accessToken).toBeTruthy();
      expect((await resetPassword(resetRequest())).status).toBe(400);
      expect((await verifyEmail(new Request("http://gateway.test/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token: proof }) }))).status).toBe(400);
    });

    it("consumes a redundant email proof without resetting an already verified account", async () => {
      const userId = `usr_verified_${nanoid(12)}`;
      const passwordHash = await hashPassword("already_verified_password_123");
      const proof = generateOpaqueToken();
      await db.insert(users).values({ id: userId, email: `verified_${nanoid(10)}@example.test`, passwordHash, emailVerifiedAt: new Date() });
      await pool().query("INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '10 minutes')", [`evt_${nanoid(12)}`, userId, await hashToken(proof)]);
      const response = await verifyEmail(new Request("http://gateway.test/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token: proof }) }));
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(response.json()).resolves.toEqual({ ok: true, next: "/login", requiresPasswordSetup: false });
      expect((await db.query.users.findFirst({ where: eq(users.id, userId) }))?.passwordHash).toBe(passwordHash);
      expect((await pool().query("SELECT id FROM password_reset_tokens WHERE user_id = $1", [userId])).rows).toHaveLength(0);
      expect((await pool().query("SELECT tenant_id FROM tenant_users WHERE user_id = $1", [userId])).rows).toHaveLength(0);
    });
  });

  describe("transitionTenantLifecycle", () => {
    it("revokes refresh families when a tenant is suspended", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const pair = await issueSessionPair({
        kind: "manager",
        tenantId: id,
        role: "admin",
      });

      await transitionTenantLifecycle(id, "suspended", "Billing overdue", { type: "platform", id: "admin1" });

      const row = (await pool().query(
        "SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE family_id = $1",
        [pair.familyId],
      )).rows[0];
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe("tenant_suspended");
    });

    it("suspends an active tenant", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const result = await transitionTenantLifecycle(id, "suspended", "Billing overdue", { type: "platform", id: "admin1" });
      expect(result.changed).toBe(true);
      expect(result.lifecycle).toBe("suspended");
      expect(result.previousLifecycle).toBe("active");
      const row = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
      expect(row).toBeDefined();
      expect(row!.lifecycle).toBe("suspended");
      expect(row!.suspendedAt).toBeInstanceOf(Date);
      expect(row!.lifecycleReason).toBe("Billing overdue");
    });

    it("reactivates a suspended tenant", async () => {
      const id = tenantId();
      await createTestTenant(id);
      await transitionTenantLifecycle(id, "suspended", "Test suspension", { type: "platform", id: "admin1" });
      const result = await transitionTenantLifecycle(id, "active", "Payment received", { type: "platform", id: "admin1" });
      expect(result.changed).toBe(true);
      expect(result.lifecycle).toBe("active");
      expect(result.previousLifecycle).toBe("suspended");
      const row = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
      expect(row!.lifecycle).toBe("active");
      expect(row!.suspendedAt).toBeNull();
      expect(row!.lifecycleReason).toBe("Payment received");
    });

    it("soft-deletes an active tenant", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const result = await transitionTenantLifecycle(id, "deleted", "Account closed by user", { type: "platform", id: "admin1" });
      expect(result.changed).toBe(true);
      expect(result.lifecycle).toBe("deleted");
      const row = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
      expect(row!.lifecycle).toBe("deleted");
      expect(row!.deletedAt).toBeInstanceOf(Date);
    });

    it("soft-deletes a suspended tenant", async () => {
      const id = tenantId();
      await createTestTenant(id);
      await transitionTenantLifecycle(id, "suspended", "Test", { type: "platform", id: "admin1" });
      const result = await transitionTenantLifecycle(id, "deleted", "Account removal", { type: "platform", id: "admin1" });
      expect(result.changed).toBe(true);
      expect(result.lifecycle).toBe("deleted");
      expect(result.previousLifecycle).toBe("suspended");
    });

    it("rejects transition from deleted (terminal state)", async () => {
      const id = tenantId();
      await createTestTenant(id);
      await transitionTenantLifecycle(id, "deleted", "Closed", { type: "platform", id: "admin1" });
      await expect(transitionTenantLifecycle(id, "active", "Attempted reactivation", { type: "platform", id: "admin1" })).rejects.toThrow(TenantLifecycleError);
      await expect(transitionTenantLifecycle(id, "suspended", "Attempted suspension", { type: "platform", id: "admin1" })).rejects.toThrow(TenantLifecycleError);
    });

    it("is a no-op when target equals current state", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const result = await transitionTenantLifecycle(id, "active", "Already active", { type: "platform", id: "admin1" });
      expect(result.changed).toBe(false);
      expect(result.lifecycle).toBe("active");
    });

    it("rejects non-existent tenant", async () => {
      await expect(transitionTenantLifecycle("nonexistent_tenant_9999", "suspended", "Test", { type: "platform", id: "admin1" })).rejects.toThrow(TenantLifecycleError);
    });

    it("rejects empty reason", async () => {
      const id = tenantId();
      await createTestTenant(id);
      await expect(transitionTenantLifecycle(id, "suspended", "", { type: "platform", id: "admin1" })).rejects.toThrow(TenantLifecycleError);
    });

    it("preserves terminal deletion under concurrent lifecycle requests", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const [deleted, suspended] = await Promise.allSettled([
        transitionTenantLifecycle(id, "deleted", "Delete concurrently", { type: "platform", id: "delete" }),
        transitionTenantLifecycle(id, "suspended", "Suspend concurrently", { type: "platform", id: "suspend" }),
      ]);
      const row = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
      expect(deleted.status).toBe("fulfilled");
      expect(row!.lifecycle).toBe("deleted");
      // Both may legitimately commit when suspend wins the lock first and
      // delete immediately follows. What is forbidden is a later stale
      // suspend overwriting the terminal deletion.
      if (suspended.status === "fulfilled") {
        expect(suspended.value.previousLifecycle).toBe("active");
        expect(suspended.value.lifecycle).toBe("suspended");
      }
    });
  });

  describe("fresh platform mutation authority", () => {
    it.each(["owner_changed", "session_revoked", "email_changed"] as const)("does not mutate a tenant after %s following preflight", async change => {
      const id = tenantId();
      const userId = `usr_${nanoid(12)}`;
      const email = `platform_${nanoid(8)}@example.test`;
      await createTestTenant(id);
      await db.insert(users).values({ id: userId, email, passwordHash: "unused", emailVerifiedAt: new Date(), isPlatformOwner: true });
      try {
        const pair = await issueSessionPair({ kind: "platform", userId, email });
        const claims = verifyPlatformTokenSignature(pair.accessToken);
        expect(claims).not.toBeNull();
        if (!claims) throw new Error("Expected admitted platform claims");
        if (change === "owner_changed") await pool().query("UPDATE users SET is_platform_owner = false WHERE id = $1", [userId]);
        if (change === "email_changed") await pool().query("UPDATE users SET email = $2 WHERE id = $1", [userId, `changed_${nanoid(8)}@example.test`]);
        if (change === "session_revoked") await pool().query("UPDATE refresh_tokens SET revoked_at = clock_timestamp() WHERE family_id = $1", [pair.familyId]);
        await expect(transitionTenantLifecycle(id, "suspended", "Delayed platform mutation", { type: "platform", id: userId, claims }))
          .rejects.toBeInstanceOf(PlatformMutationAuthorityChangedError);
      expect((await db.query.tenants.findFirst({ where: eq(tenants.id, id) }))?.lifecycle).toBe("active");
      } finally {
        await db.update(users).set({ isPlatformOwner: false }).where(eq(users.id, userId));
      }
    });
  });

  describe("session minting lifecycle fence", () => {
    it.each(["initial", "rotation"] as const)("suspension revokes an in-flight %s session before reactivation", async mode => {
      const id = tenantId();
      await createTestTenant(id);
      const principal = { kind: "manager" as const, tenantId: id, role: "admin" };
      const previous = mode === "rotation" ? await issueSessionPair(principal) : null;
      const gate = await pool().connect();
      const gateKey = 1841202610;
      let operation: Promise<RefreshResult> | undefined;
      let suspension: ReturnType<typeof transitionTenantLifecycle> | undefined;
      try {
        // Static test-only DDL in the isolated worker schema. The gate leaves
        // every inserted row byte-identical; it supplies deterministic timing.
        await pool().query(`CREATE FUNCTION auth_session_test_gate() RETURNS trigger AS $$
          BEGIN
            PERFORM pg_advisory_xact_lock(TG_ARGV[0]::bigint);
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql`);
        await pool().query(`CREATE TRIGGER auth_session_test_gate BEFORE INSERT ON refresh_tokens
          FOR EACH ROW EXECUTE FUNCTION auth_session_test_gate('1841202610')`);
        await gate.query("SELECT pg_advisory_lock($1::bigint)", [gateKey]);
        operation = mode === "initial"
          ? issueSessionPair(principal).then(pair => ({ status: "rotated" as const, pair }))
          : rotateRefreshToken("manager", previous!.refreshToken);
        // Own rejection immediately even if the expected gate is not reached.
        void operation.catch(() => undefined);

        let atGate = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await pool().query(`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0
              AND objid = $1::oid AND objsubid = 1 AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          ) AS waiting`, [gateKey]);
          if (waiting.rows[0]?.waiting === true) { atGate = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(atGate).toBe(true);
        let suspensionFinished = false;
        suspension = transitionTenantLifecycle(id, "suspended", "Session race regression", { type: "platform", id: "suspend" })
          .finally(() => { suspensionFinished = true; });
        void suspension.catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 75));
        expect(suspensionFinished).toBe(false);

        await gate.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
        const outcome = await operation;
        expect(outcome.status).toBe("rotated");
        if (outcome.status !== "rotated") throw new Error("Expected a real inserted session");
        await suspension;
        const rows = (await pool().query("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE family_id = $1", [outcome.pair.familyId])).rows;
        expect(rows.length).toBe(mode === "rotation" ? 2 : 1);
        expect(rows.every(row => row.revoked_at && row.revoked_reason === "tenant_suspended")).toBe(true);
        await transitionTenantLifecycle(id, "active", "Reactivation after race", { type: "platform", id: "reactivate" });
        expect(await rotateRefreshToken("manager", outcome.pair.refreshToken)).toEqual({ status: "invalid" });
      } finally {
        await gate.query("SELECT pg_advisory_unlock($1::bigint)", [gateKey]);
        await Promise.allSettled([operation, suspension].filter((pending): pending is NonNullable<typeof pending> => !!pending));
        await pool().query("DROP TRIGGER IF EXISTS auth_session_test_gate ON refresh_tokens");
        await pool().query("DROP FUNCTION IF EXISTS auth_session_test_gate()");
        gate.release();
      }
    });
  });

  describe("transactional runtime fence", () => {
    it("prevents tenant suspension from committing over an in-flight active runtime write", async () => {
      const id = tenantId();
      await createTestTenant(id);

      let releaseRuntime!: () => void;
      const holdRuntime = new Promise<void>((resolve) => { releaseRuntime = resolve; });
      let fenceAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => { fenceAcquired = resolve; });

      const runtimeTx = db.transaction(async (tx) => {
        await requireActiveTenantInTransaction(tx, id);
        fenceAcquired();
        await holdRuntime;
      });

      await acquired;
      let transitionFinished = false;
      const transition = transitionTenantLifecycle(
        id,
        "suspended",
        "Concurrent suspension",
        { type: "platform", id: "suspend" },
      ).finally(() => {
        transitionFinished = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(transitionFinished).toBe(false);

      releaseRuntime();
      await runtimeTx;
      const result = await transition;
      expect(result.lifecycle).toBe("suspended");
    });
  });

  describe("requireActiveTenant", () => {
    it("passes for an active tenant", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const result = await requireActiveTenant(id);
      expect(result).toBe("active");
    });
    it("throws TenantSuspendedError for suspended tenant", async () => {
      const id = tenantId();
      await createTestTenant(id);
      await transitionTenantLifecycle(id, "suspended", "Test", { type: "platform", id: "admin1" });
      await expect(requireActiveTenant(id)).rejects.toThrow(TenantSuspendedError);
    });
    it("throws TenantDeletedError for deleted tenant", async () => {
      const id = tenantId();
      await createTestTenant(id);
      await transitionTenantLifecycle(id, "deleted", "Test", { type: "platform", id: "admin1" });
      await expect(requireActiveTenant(id)).rejects.toThrow(TenantDeletedError);
    });
    it("throws TenantDeletedError for non-existent tenant", async () => {
      await expect(requireActiveTenant("totally_nonexistent_tenant")).rejects.toThrow(TenantDeletedError);
    });
  });

  describe("cross-tenant lifecycle isolation", () => {
    it("suspending tenant A does not affect tenant B", async () => {
      const idA = tenantId();
      const idB = tenantId();
      await createTestTenant(idA, "Tenant A");
      await createTestTenant(idB, "Tenant B");
      await transitionTenantLifecycle(idA, "suspended", "Only A", { type: "platform", id: "admin1" });
      expect(await requireActiveTenant(idB)).toBe("active");
      await expect(requireActiveTenant(idA)).rejects.toThrow(TenantSuspendedError);
    });
  });

  describe("legacy platform authority boundary (C066)", () => {
    async function tenantOwnerSession(tenantId: string): Promise<{ cookie: string; userId: string }> {
      const userId = `usr_${nanoid(12)}`;
      await db.insert(users).values({ id: userId, email: `owner_${nanoid(8)}@tenant.local`, passwordHash: "argon2id$test" });
      await db.insert(tenantUsers).values({ userId, tenantId, role: "owner" });
      const pair = await issueSessionPair({ kind: "manager", tenantId, userId, role: "owner" });
      return { cookie: `mgr_session=${pair.accessToken}`, userId };
    }

    it("denies tenant manager sessions on the global metrics endpoint", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const session = await tenantOwnerSession(id);
      // Non-vacuous: the session itself validates as a tenant manager.
      const { validateManager } = await import("../src/lib/manager-auth");
      const claims = await validateManager(new Request("http://gateway.test/api/metrics", { headers: { cookie: session.cookie } }));
      expect(claims?.userId).toBe(session.userId);
      const { GET } = await import("../src/app/api/metrics/route");
      const res = await GET(new Request("http://gateway.test/api/metrics", { headers: { cookie: session.cookie } }));
      expect(res.status).toBe(401);
    });

    it("denies tenant manager sessions on the legacy tenant lifecycle endpoint", async () => {
      const id = tenantId();
      await createTestTenant(id);
      const victim = tenantId();
      await createTestTenant(victim);
      const session = await tenantOwnerSession(id);
      const { PATCH } = await import("../src/app/api/admin/tenants/[id]/lifecycle/route");
      const res = await PATCH(
        new Request("http://gateway.test/api/admin/tenants/x/lifecycle", {
          method: "PATCH",
          headers: { cookie: session.cookie, "content-type": "application/json" },
          body: JSON.stringify({ lifecycle: "suspended", reason: "privilege escalation probe" }),
        }),
        { params: Promise.resolve({ id: victim }) },
      );
      expect(res.status).toBe(401);
      const row = await db.query.tenants.findFirst({ where: eq(tenants.id, victim) });
      expect(row!.lifecycle).toBe("active");
    });
  });
});
