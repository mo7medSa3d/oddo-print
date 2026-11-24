import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReportRoute from "../src/app/api/security/csp-report/route";

const endpoint = "https://gateway.test/api/security/csp-report";
const valid = () => ({ "csp-report": {
  "effective-directive": "script-src-elem", disposition: "enforce", "status-code": 200,
} });
const request = (body: unknown = valid(), headers: Record<string, string> = {}) => new Request(endpoint, {
  method: "POST", headers: { "content-type": "application/csp-report", ...headers },
  body: JSON.stringify(body),
});
const streamed = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST", body, duplex: "half",
    headers: { "content-type": "application/csp-report", ...headers },
  };
  return new Request(endpoint, init);
};
let POST: typeof ReportRoute.POST;
let messages: string[];

describe("actual unauthenticated CSP report handler", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    messages = [];
    vi.spyOn(console, "info").mockImplementation((message: string) => { messages.push(message); });
    ({ POST } = await import("../src/app/api/security/csp-report/route"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("accepts the standard report envelope and emits only fixed, allowlisted fields", async () => {
    const result = await POST(request());
    expect(result.status).toBe(204);
    expect(await result.text()).toBe("");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0])).toEqual({
      ts: expect.any(String), event: "security.csp_violation",
      directive: "script-src-elem", disposition: "enforce", status: 200,
    });
  });

  it("discards document/source/referrer URLs, samples, policy nonces and caller correlation", async () => {
    const secret = "private-query-token-and-nonce";
    const report = { "csp-report": { ...valid()["csp-report"],
      "document-uri": `https://gateway.test/reset-password?token=${secret}`,
      "blocked-uri": `https://asset.test/${secret}`, "source-file": `https://gateway.test/${secret}`,
      referrer: `https://gateway.test/${secret}`, "script-sample": `alert('${secret}')\nforged-log`,
      "original-policy": `script-src 'nonce-${secret}'`, unexpected: { value: secret },
    } };
    const { runWithCorrelation } = await import("../src/server/correlation");
    const result = await runWithCorrelation({ requestId: secret, tenantId: secret, agentId: secret }, () =>
      POST(request(report, { cookie: `mgr_session=${secret}`, authorization: `Bearer ${secret}`,
        "x-request-id": secret, "x-forwarded-for": "198.51.100.18", referer: `https://gateway.test/${secret}` })),
    );
    expect(result.status).toBe(204);
    expect(JSON.stringify(messages)).not.toContain(secret);
    expect(JSON.stringify(messages)).not.toContain("198.51.100.18");
    expect(Object.keys(JSON.parse(messages[0])).sort()).toEqual(["directive", "disposition", "event", "status", "ts"]);
    expect(await result.text()).toBe("");
  });

  it.each([
    null, [], {}, { "csp-report": [] }, { "csp-report": {} },
    { "csp-report": { ...valid()["csp-report"], "effective-directive": "script-src\nforged-log" } },
    { "csp-report": { ...valid()["csp-report"], disposition: "anything" } },
    { "csp-report": { ...valid()["csp-report"], "status-code": "200" } },
    { "csp-report": { ...valid()["csp-report"], "status-code": 600 } },
    { "csp-report": { ...valid()["csp-report"], "status-code": 200.5 } },
  ])("refuses invalid envelopes and unsafe field values without logging: %j", async (body) => {
    const result = await POST(request(body));
    expect(result.status).toBe(400);
    expect(await result.text()).toBe("");
    expect(messages).toEqual([]);
  });

  it("rejects malformed JSON and invalid UTF-8 without exposing parser or stream errors", async () => {
    const malformed = new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/csp-report" }, body: "private-malformed-json" });
    expect((await POST(malformed)).status).toBe(400);
    const invalidUtf8 = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xff])); c.close(); } });
    expect((await POST(streamed(invalidUtf8))).status).toBe(400);
    const failed = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("private-stream-error")); } });
    const result = await POST(streamed(failed));
    expect(result.status).toBe(400);
    expect(await result.text()).toBe("");
    expect(messages).toEqual([]);
  });

  it("accepts report disposition and unknown network status without widening the schema", async () => {
    const body = valid();
    body["csp-report"].disposition = "report";
    body["csp-report"]["status-code"] = 0;
    expect((await POST(request(body, { "content-type": "Application/CSP-Report; charset=utf-8" }))).status).toBe(204);
    expect(JSON.parse(messages[0])).toMatchObject({ disposition: "report", status: 0 });
  });

  it.each<Record<string, string>>([
    { "content-type": "application/json" }, { "content-type": "text/plain" },
    { "content-encoding": "gzip" }, { "content-encoding": "br" },
  ])("rejects unexpected media or compressed bodies: %j", async (headers) => {
    expect((await POST(request(valid(), headers))).status).toBe(415);
    expect(messages).toEqual([]);
  });

  it("refuses an oversized declared body before reading it and cancels the upload", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    expect((await POST(streamed(body, { "content-length": "16385" }))).status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(messages).toEqual([]);
  });

  it.each(["-1", "1e3", "12,12", "9007199254740992"])("refuses malformed declared length %s", async (length) => {
    expect((await POST(request(valid(), { "content-length": length }))).status).toBe(400);
    expect(messages).toEqual([]);
  });

  it("caps actual streamed bytes even if a declared length lies", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(8192)); c.enqueue(new Uint8Array(8193)); },
      cancel: cancelled,
    });
    expect((await POST(streamed(body, { "content-length": "100" }))).status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(messages).toEqual([]);
  });

  it("accepts exactly16KiB of valid input without recording ignored padding", async () => {
    const body = { ...valid(), padding: "" };
    body.padding = "x".repeat(16384 - Buffer.byteLength(JSON.stringify(body)));
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(16384);
    expect((await POST(request(body))).status).toBe(204);
    expect(messages[0]).not.toContain("padding");
  });

  it("enforces a total stream deadline and never awaits hostile cancellation", async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const pending = POST(streamed(body));
    await vi.advanceTimersByTimeAsync(2_001);
    const result = await pending;
    expect(result.status).toBe(408);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(messages).toEqual([]);
    expect((await POST(request())).status).toBe(204);
  });

  it("limits concurrent stalled readers and releases every slot after the deadline", async () => {
    const pending = Array.from({ length: 8 }, () => POST(streamed(new ReadableStream<Uint8Array>())));
    const refused = await POST(request());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(8).fill(408));
    expect((await POST(request())).status).toBe(204);
  });

  it("bounds total attempts including invalid reports, independently of spoofed caller keys", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await POST(request(null, { "x-forwarded-for": `192.0.2.${i}`, "x-request-id": `fake-${i}` }))).status).toBe(400);
    }
    expect((await POST(request())).status).toBe(429);
    expect(messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await POST(request())).status).toBe(204);
  });
});
