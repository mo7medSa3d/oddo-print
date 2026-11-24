import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// Retired license-only control plane removed fetchGatewayFleet and the fleet bridge.
const hasFleetBridge = readFileSync("src/desktop/lib/ipc.ts", "utf8").includes("fetchGatewayFleet");
const describeFleet = hasFleetBridge ? describe : describe.skip;

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

describeFleet("desktop complete fleet traversal", () => {
  it("keeps browser fetch deadlines active while fleet bodies are still streaming", async () => {
    // fetch() resolves at response headers; a stream can hang afterwards.
    // A deadline cleared immediately on the fetch() resolution cannot abort
    // response.text() and leaves the Desktop waiting indefinitely.
    vi.resetModules();
    vi.stubGlobal("window", {});
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing request signal");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode("["));
          signal.addEventListener("abort", () => controller.error(new Error("body deadline enforced")), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "x-has-more": "false" } });
    });
    vi.stubGlobal("fetch", fakeFetch);
    let safety: ReturnType<typeof setTimeout> | undefined;
    try {
      const browser = await import("../src/desktop/lib/ipc");
      const pending = browser.fetchGatewayAgents("https://gateway.example");
      // The timeout must remain bound to the body even after fetch() has
      // returned headers, not just to the connection establishment phase.
      const verdict = Promise.race([
        pending.then(() => "resolved", error => error instanceof Error ? error.message : "unknown rejection"),
        new Promise<string>(resolve => {
          safety = setTimeout(() => {
            try { streamController?.error(new Error("test safety cutoff")); } catch { /* already closed */ }
            resolve("stalled after headers");
          }, 120);
        }),
      ]);
      await Promise.resolve();
      deadline.abort();
      expect(await verdict).toBe("body deadline enforced");
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      if (safety) clearTimeout(safety);
      timeout.mockRestore();
      vi.unstubAllGlobals();
      vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    }
  });

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

  it.each([
    "x-next-before-created-at",
    "x-next-before-id",
    "x-next-before-id-encoded",
    "x-next-cursor",
  ])("rejects stray fleet continuation %s when has-more metadata is missing", async (header) => {
    // Legacy unpaged responses are allowed only when no continuation
    // metadata is present; a lost flag must not hide later Agent pages.
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "a1" }], { [header]: "stray" }));
    await expect(ipc.fetchGatewayAgents("https://gateway.example"))
      .rejects.toThrow("Invalid Gateway fleet pagination metadata");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects a final fleet page carrying a cursor for another pagination protocol", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "p1" }], {
      "x-has-more": "false",
      "x-next-cursor": "extra-token",
    }));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example"))
      .rejects.toThrow("Invalid Gateway fleet cursor");
  });

  it("rejects repeated printer identities within a page, even if duplicate payloads match", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "printer-x", name: "First queue" }, { id: "printer-x", name: "Another queue" }]));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example")).rejects.toThrow("Duplicate Gateway fleet identity");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "printer-x" }, { id: "printer-x" }]));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example")).rejects.toThrow("Duplicate Gateway fleet identity");
  });

  it("rejects a repeated Agent/printer ID from a later page before returning partial inventory", async () => {
    for (const kind of ["agent", "printer"] as const) {
      mocks.invoke.mockReset();
      mocks.invoke.mockResolvedValueOnce(envelope([{ id: "reused-identity", name: "First" }], next("reused-identity")))
        .mockResolvedValueOnce(envelope([{ id: "reused-identity", name: "Other owner" }], { "x-has-more": "false" }));
      const read = kind === "agent" ? ipc.fetchGatewayAgents : ipc.fetchGatewayPrinters;
      await expect(read("https://gateway.example")).rejects.toThrow("Duplicate Gateway fleet identity");
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    mocks.invoke.mockResolvedValue(envelope([], next("same")));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example")).rejects.toThrow("cursor did not advance");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("bounds advancing empty pages instead of polling a broken Gateway forever", async () => {
    let page = 0;
    mocks.invoke.mockImplementation(async () => {
      // Stop the intentionally broken baseline before its unbounded microtask
      // chain can exhaust this test runner; production must stop first.
      if (page === 1001) throw new Error("test safety stop: unbounded pagination");
      return envelope([], next(`hidden-${page++}`));
    });
    await expect(ipc.fetchGatewayPrinters("https://gateway.example")).rejects.toThrow("Gateway fleet pagination limit exceeded");
    expect(mocks.invoke).toHaveBeenCalledTimes(1000);
  });

  it("rejects an oversized fleet without returning partial inventory", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope(Array.from({ length: 100001 }, (_, id) => ({ id: `a-${id}` }))));
    await expect(ipc.fetchGatewayAgents("https://gateway.example")).rejects.toThrow("Gateway fleet inventory limit exceeded");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("never presents a truncated fleet after a later page fails", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "a1", name: "Agent" }], next("a1")))
      .mockResolvedValueOnce(envelope({ code: "INTERNAL_ERROR" }, undefined, 503));
    await expect(ipc.fetchGatewayAgents("https://gateway.example")).rejects.toMatchObject({ status: 503 });
  });

  it.each(["TRUE", "1", "maybe"])("rejects malformed has-more metadata (%s) rather than truncating the fleet", async (flag) => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "p1" }], { "x-has-more": flag }));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example"))
      .rejects.toThrow("Invalid Gateway fleet pagination metadata");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects a completed fleet page carrying a conflicting keyset cursor", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: "a1" }], {
      "x-has-more": "false",
      "x-next-before-created-at": "2026-10-13T00:00:00.000Z",
      "x-next-before-id": "a1",
    }));
    await expect(ipc.fetchGatewayAgents("https://gateway.example"))
      .rejects.toThrow("Invalid Gateway fleet cursor");
  });

  it("rejects a malformed fleet row and a missing continuation", async () => {
    mocks.invoke.mockResolvedValueOnce(envelope([{ id: null }]));
    await expect(ipc.fetchGatewayAgents("https://gateway.example")).rejects.toThrow("Invalid Gateway fleet response");
    mocks.invoke.mockResolvedValueOnce(envelope([], { "x-has-more": "true" }));
    await expect(ipc.fetchGatewayPrinters("https://gateway.example")).rejects.toThrow("Invalid Gateway fleet cursor");
  });
});
