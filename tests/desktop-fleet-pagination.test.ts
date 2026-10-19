import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

let ipc: typeof import("../src/desktop/lib/ipc");
const envelope = (rows: unknown, headers?: Record<string, string>, status = 200) =>
  JSON.stringify({ status, body: JSON.stringify(rows), headers });
const next = (id: string) => ({
  "x-has-more": "true",
  "x-next-before-created-at": "2026-10-13T00:00:00.000Z",
  "x-next-before-id-encoded": Buffer.from(id).toString("base64url"),
});

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  ipc = await import("../src/desktop/lib/ipc");
});
beforeEach(() => mocks.invoke.mockReset());
afterAll(() => vi.unstubAllGlobals());

describe("desktop complete fleet traversal", () => {
  it("traverses pagination from direct-browser response headers", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "a1", name: "Agent 1" }]), { headers: next("a1") }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "a2", name: "Agent 2" }]), { headers: { "x-has-more": "false" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      const browser = await import("../src/desktop/lib/ipc");
      expect((await browser.fetchGatewayAgents("https://gateway.example")).map((row) => row.id)).toEqual(["a1", "a2"]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0][1].headers).toEqual({});
      expect(fetch.mock.calls[0][1].credentials).toBe("omit");
      expect(new URL(fetch.mock.calls[1][0]).searchParams.get("beforeIdEncoded")).toBe(Buffer.from("a1").toString("base64url"));
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    }
  });

  it("continues past an empty hidden-printer page and preserves Unicode keyset IDs", async () => {
    mocks.invoke
      .mockResolvedValueOnce(envelope([{ id: "p1", lifecycle: "active" }], next("p1")))
      .mockResolvedValueOnce(envelope([], next("طابعة مخفية")))
      .mockResolvedValueOnce(envelope([{ id: "p3", lifecycle: "active", config: { ip: "192.168.1.3", port: 9100 } }], { "x-has-more": "false" }));
    const rows = await ipc.fetchGatewayPrinters("https://gateway.example");
    expect(rows.map((row) => row.id)).toEqual(["p1", "p3"]);
    expect(rows[1].network_address).toBe("192.168.1.3");
    const path = mocks.invoke.mock.calls[2][1].args.path;
    const query = new URL(path, "https://gateway.example").searchParams;
    expect(query.get("beforeIdEncoded")).toBe(Buffer.from("طابعة مخفية").toString("base64url"));
    expect(query.get("beforeCreatedAt")).toBe("2026-10-13T00:00:00.000Z");
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("collects multiple agent pages without treating a page limit as a fleet limit", async () => {
    for (let page = 0; page < 3; page++) {
      const rows = Array.from({ length: 100 }, (_, index) => ({ id: `a-${page * 100 + index}`, name: "Agent" }));
      mocks.invoke.mockResolvedValueOnce(envelope(rows, page < 2 ? next(rows[99].id) : { "x-has-more": "false" }));
    }
    const rows = await ipc.fetchGatewayAgents("https://gateway.example");
    expect(rows).toHaveLength(300);
    expect(rows[299].id).toBe("a-299");
    expect(mocks.invoke.mock.calls.every(([, request]) => request.args.path.startsWith("/api/agents?"))).toBe(true);
  });

  it("retains backward compatibility for complete unpaged CLI envelopes", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "a1", name: "Legacy agent" }]));
    expect(await ipc.fetchGatewayAgents("https://gateway.example")).toEqual([{ id: "a1", name: "Legacy agent" }]);
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    mocks.invoke.mockResolvedValue(envelope([], next("same")));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example")).rejects.toThrow("cursor did not advance");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("never presents a truncated fleet after a later page fails", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "a1", name: "Agent" }], next("a1")))
      .mockResolvedValueOnce(envelope({ code: "INTERNAL_ERROR" }, undefined, 503));
    await expect(ipc.fetchGatewayAgents("https://gateway.example")).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a malformed fleet row and a missing continuation", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: null }]));
    await expect(ipc.fetchGatewayAgents("https://gateway.example")).rejects.toThrow("Invalid Gateway fleet response");
    mocks.invoke.mockResolvedValueOnce(envelope([], { "x-has-more": "true" }));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example")).rejects.toThrow("Invalid Gateway fleet cursor");
  });
});
