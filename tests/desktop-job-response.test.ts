import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

let ipc: typeof import("../src/desktop/lib/ipc");
beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  ipc = await import("../src/desktop/lib/ipc");
});
beforeEach(() => boundary.invoke.mockReset());
afterAll(() => vi.unstubAllGlobals());

describe("desktop job history response boundary", () => {
  it.each([null, {}, { jobs: [] }, [null], [[]], [{ id: "" }], [{ id: "   " }], [{ id: 42 }]])(
    "rejects malformed history before it reaches React: %j", async (body) => {
      boundary.invoke.mockResolvedValueOnce(JSON.stringify({ status: 200, body: JSON.stringify(body) }));
      await expect(ipc.fetchGatewayJobs("https://gateway.example")).rejects.toThrow("Invalid Gateway jobs response");
    },
  );
  it("rejects duplicate job identities instead of rendering ambiguous timeline entries", async () => {
    boundary.invoke.mockResolvedValueOnce(JSON.stringify({ status: 200, body: JSON.stringify([{ id: "job-1", status: "queued" }, { id: "job-1", status: "printed" }]) }));
    await expect(ipc.fetchGatewayJobs("https://gateway.example")).rejects.toThrow("Invalid Gateway jobs response");
  });
  it("preserves real job rows and empty history", async () => {
    const row = { id: "job-1", status: "unknown", evidence: { attempt: "attempt-1" } };
    for (const rows of [[], [row]]) {
      boundary.invoke.mockResolvedValueOnce(JSON.stringify({ status: 200, body: JSON.stringify(rows) }));
      expect(await ipc.fetchGatewayJobs("https://gateway.example")).toEqual(rows);
    }
  });
});
