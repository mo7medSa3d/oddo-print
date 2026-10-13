import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[][], now: 0, select: vi.fn(), delete: vi.fn() }));
function select() {
  state.select();
  const rows = state.rows.shift() ?? [];
  const chain = { from: () => chain, leftJoin: () => chain, where: () => chain,
    orderBy: () => chain, limit: () => chain, for: async () => rows,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
  return chain;
}
vi.mock("../src/db", () => ({ db: { select, execute: async () => ({ rows: [{ now_ms: String(state.now) }] }),
  transaction: async (fn: (tx: unknown) => unknown) => fn({ select, delete: state.delete }) } }));
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: async () => ({ tenantId: "tenant-1", userId: "user-1" }) }));
vi.mock("../src/lib/authorization", () => ({ requireManagerPermission: () => {} }));
vi.mock("../src/lib/tenant-guard", () => ({ requireActiveTenantInTransaction: async () => {} }));
vi.mock("../src/lib/manager-mutation-authorization", () => ({ requireManagerActorInTransaction: async () => {},
  ManagerMutationAuthorityChangedError: class extends Error {} }));
vi.mock("../src/lib/e2e-capture", () => ({ captureEnabled: () => true, readBoundedCaptureJSON: (req: Request) => req.json() }));
import { DELETE, GET } from "../src/app/api/test-captures/route";

const runId = `cap_${"a".repeat(32)}`;
const databaseNow = Date.parse("2026-10-13T10:00:00Z");
const expiresAt = new Date(databaseNow + 60_000);

describe("capture console authoritative expiry clock", () => {
  beforeEach(() => { vi.clearAllMocks(); state.rows = []; state.now = databaseNow; });
  afterEach(() => vi.restoreAllMocks());

  it.each([databaseNow - 3_600_000, databaseNow + 3_600_000])("presents live and expired captures consistently with PostgreSQL under host clock skew (%d)", async hostNow => {
    vi.spyOn(Date, "now").mockReturnValue(hostNow);
    state.rows = [[
      { runId, status: "queued", expiresAt, claimedAt: null, createdAt: new Date(databaseNow) },
      { runId: `cap_${"b".repeat(32)}`, status: "claimed", expiresAt: new Date(databaseNow - 1),
        claimedAt: new Date(databaseNow - 1000), createdAt: new Date(databaseNow - 2000) },
    ], []];
    const response = await GET(new Request("https://gateway.test/api/test-captures"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((run: { status: string }) => run.status)).toEqual(["queued", "expired"]);
  });

  it.each([true, false])("uses the locked database expiry decision for cleanup (active=%s)", async active => {
    vi.spyOn(Date, "now").mockReturnValue(active ? databaseNow + 3_600_000 : databaseNow - 3_600_000);
    state.rows = [[{ id: runId, status: "queued", expiresAt, active }], []];
    const response = await DELETE(new Request("https://gateway.test/api/test-captures", {
      method: "DELETE", body: JSON.stringify({ scope: "one", runId, confirm: true }),
    }));
    expect(response.status).toBe(active ? 409 : 200);
    if (active) expect(await response.json()).toEqual({ code: "CAPTURE_ACTIVE" });
    expect(state.delete).not.toHaveBeenCalled();
  });
});
