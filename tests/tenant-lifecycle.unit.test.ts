import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantFindFirst = vi.fn();
const tenantUpdate = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../src/db", () => ({
  db: {
    query: {
      tenants: {
        findFirst: (...args: unknown[]) => tenantFindFirst(...args),
      },
    },
    transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

vi.mock("../src/lib/audit", () => ({
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  transitionTenantLifecycle,
  TenantLifecycleError,
} from "../src/lib/tenant-lifecycle";
import {
  requireActiveTenant,
  TenantSuspendedError,
  TenantDeletedError,
} from "../src/lib/tenant-guard";

describe("Tenant Lifecycle Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("requireActiveTenant guard", () => {
    it("resolves when tenant is active", async () => {
      tenantFindFirst.mockResolvedValue({ id: "t1", lifecycle: "active" });
      await expect(requireActiveTenant("t1")).resolves.toBe("active");
    });

    it("throws TenantSuspendedError when tenant is suspended", async () => {
      tenantFindFirst.mockResolvedValue({ id: "t2", lifecycle: "suspended" });
      await expect(requireActiveTenant("t2")).rejects.toThrow(TenantSuspendedError);
    });

    it("throws TenantDeletedError when tenant is deleted", async () => {
      tenantFindFirst.mockResolvedValue({ id: "t3", lifecycle: "deleted" });
      await expect(requireActiveTenant("t3")).rejects.toThrow(TenantDeletedError);
    });

    it("throws TenantDeletedError when tenant is missing", async () => {
      tenantFindFirst.mockResolvedValue(null);
      await expect(requireActiveTenant("missing")).rejects.toThrow(TenantDeletedError);
    });
  });

  describe("transitionTenantLifecycle", () => {
    const mockTransitionTx = (lifecycle: string) => ({
      execute: vi.fn().mockResolvedValue({ rows: [{ id: "t1", lifecycle }] }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "t1", lifecycle: "suspended" }]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    it("validates transition from active to suspended", async () => {
      transactionMock.mockImplementation(async (cb) => cb(mockTransitionTx("active")));

      const result = await transitionTenantLifecycle(
        "t1",
        "suspended",
        "Payment issue",
        { type: "platform", id: "p1" }
      );
      expect(result.changed).toBe(true);
      expect(result.lifecycle).toBe("suspended");
      expect(result.previousLifecycle).toBe("active");
    });

    it("returns changed: false when target matches current", async () => {
      transactionMock.mockImplementation(async (cb) => cb(mockTransitionTx("active")));

      const result = await transitionTenantLifecycle(
        "t1",
        "active",
        "Already active",
        { type: "platform", id: "p1" }
      );
      expect(result.changed).toBe(false);
      expect(result.lifecycle).toBe("active");
    });

    it("rejects transition from deleted terminal state", async () => {
      tenantFindFirst.mockResolvedValue({ id: "t1", lifecycle: "deleted" });
      transactionMock.mockImplementation(async (cb) => cb(mockTransitionTx("deleted")));

      await expect(
        transitionTenantLifecycle(
          "t1",
          "active",
          "Try revive",
          { type: "platform", id: "p1" }
        )
      ).rejects.toThrow(TenantLifecycleError);
    });

    it("rejects transition for non-existent tenant", async () => {
      tenantFindFirst.mockResolvedValue(null);
      transactionMock.mockImplementation(async (cb) => cb({
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        update: vi.fn(),
        delete: vi.fn(),
      }));

      await expect(
        transitionTenantLifecycle(
          "unknown",
          "suspended",
          "Reason",
          { type: "platform", id: "p1" }
        )
      ).rejects.toThrow(TenantLifecycleError);
    });

    it("rejects empty reason", async () => {
      await expect(
        transitionTenantLifecycle(
          "t1",
          "suspended",
          "   ",
          { type: "platform", id: "p1" }
        )
      ).rejects.toThrow(TenantLifecycleError);
    });

    it("rejects invalid lifecycle state", async () => {
      await expect(
        transitionTenantLifecycle(
          "t1",
          // @ts-expect-error test invalid enum
          "invalid_state",
          "Reason",
          { type: "platform", id: "p1" }
        )
      ).rejects.toThrow(TenantLifecycleError);
    });
  });
});
