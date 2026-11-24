import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  guard: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn(),
  clock: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("../src/lib/platform-auth", () => ({
  requirePlatformOwner: mocks.auth,
  requirePlatformReadAuthorityInTransaction: mocks.guard,
  requirePlatformActorInTransaction: vi.fn(),
  PlatformUnauthorizedError: class PlatformUnauthorizedError extends Error {},
  PlatformMutationAuthorityChangedError: class PlatformMutationAuthorityChangedError extends Error {},
}));
vi.mock("../src/db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/lib/database-clock", () => ({ databaseNowMs: mocks.clock }));
vi.mock("../src/lib/manual-usage-report", () => ({ logicalUsageReport: mocks.usage }));

import { PlatformUnauthorizedError } from "../src/lib/platform-auth";
import { GET } from "../src/app/api/platform/tenants/[id]/route";

const dialect = new PgDialect();
const req = () => new Request("http://gateway.test/api/platform/tenants/tenant-a");
const ctx = { params: Promise.resolve({ id: "tenant-a" }) };

describe("Platform tenant detail personal and credential metadata read fence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ userId: "owner" });
    mocks.guard.mockResolvedValue(undefined);
    mocks.clock.mockResolvedValue(Date.now());
    mocks.usage.mockResolvedValue({ used: 0 });
    mocks.execute.mockImplementation(async (fragment: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const query = dialect.sqlToQuery(fragment).sql;
      return { rows: query.includes("FROM tenants t LEFT JOIN") ? [{ id: "tenant-a", lifecycle: "active" }] : [] };
    });
    mocks.transaction.mockImplementation(async (fn: (tx: {execute: typeof mocks.execute}) => unknown) => fn({ execute: mocks.execute }));
  });

  it("holds current Platform Owner authority before selecting any tenant member email", async () => {
    const response = await GET(req(), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ workspace: { id: "tenant-a" }, members: [], credentials: [], requests: [] });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.guard).toHaveBeenCalledOnce();
    expect(mocks.guard.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[0]);
  });

  it("returns no private tenant details when a previously valid Platform session is revoked", async () => {
    mocks.guard.mockRejectedValueOnce(new PlatformUnauthorizedError());
    const response = await GET(req(), ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
  });
});

describe("Platform Owner workspace member removal", () => {
  it("offers removal for non-owner members and keeps workspace owners protected", async () => {
    const { readFileSync } = await import("node:fs");
    const detail = readFileSync("src/app/platform/tenants/[id]/page.tsx", "utf8");
    const removal = readFileSync("src/app/api/platform/tenants/[id]/members/route.ts", "utf8");
    expect(detail).toContain("removeWorkspaceMember");
    expect(detail).toContain("/api/platform/tenants/${encodeURIComponent(id)}/members?userId=");
    expect(detail).toContain("member.role !== 'owner'");
    expect(removal).toContain('if (target.role === "owner") throw new ManualSubscriptionError("TRANSFER_OWNER_FIRST", 409)');
    expect(removal).toContain("revokeUserTenantRefreshFamiliesInTransaction");
    expect(removal).toContain('action: "team.member.removed"');
  });
});

describe("Platform Owner subscription date direction", () => {
  it("isolates subscription dates from surrounding Arabic text", async () => {
    const { readFileSync } = await import("node:fs");
    const detail = readFileSync("src/app/platform/tenants/[id]/page.tsx", "utf8");
    expect(detail).toContain('<bdi dir="ltr">{formatDate(s.currentPeriodStart)}</bdi>');
    expect(detail).toContain('<bdi dir="ltr">{formatDate(s.currentPeriodEnd)}</bdi>');
  });
});
