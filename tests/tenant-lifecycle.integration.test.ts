import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db } from "../src/db";
import { tenants } from "../src/db/schema";
import { issueSessionPair } from "../src/lib/session-tokens";
import { eq } from "drizzle-orm";
import { hasTestDatabase, applyMigrations, closePool, pool } from "./helpers/pg";
import { transitionTenantLifecycle, TenantLifecycleError } from "../src/lib/tenant-lifecycle";
import { requireActiveTenant, requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../src/lib/tenant-guard";
import { nanoid } from "../src/lib/nanoid";

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
});