import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passwordScreeningFailure, screenNewPassword } from "../src/lib/password-screening";
import commonPasswordHashes from "../src/lib/common-password-hashes.json";

const password = "synthetic-secret-雪-2026-+!";
const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
const safeCorpus = `${"A".repeat(35)}:9\r\n${digest.slice(5)}:0\r\n`;

describe("privacy-preserving compromised password screening", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response(safeCorpus))));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("blocks a reproducible set of 3000 common policy-length passwords without provider access", async () => {
    expect(commonPasswordHashes).toHaveLength(3000);
    expect(new Set(commonPasswordHashes).size).toBe(3000);
    expect(commonPasswordHashes.every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(await screenNewPassword("123456789012")).toBe("compromised");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["YaseirCloudPrinting2026!", "Odoo-Print-Gateway-2026", "يسير-2026-2026!"])("rejects easy product-name combinations (%s) without altering how passwords are stored", async (candidate) => {
    expect(await screenNewPassword(candidate)).toBe("compromised");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("transmits only the SHA1 prefix via fixed HTTPS GET with padding and no identity, full hash or password", async () => {
    expect(await screenNewPassword(password)).toBe("acceptable");
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { "Add-Padding": "true" } });
    expect(options?.body).toBeUndefined();
    const wire = JSON.stringify([url, options]);
    expect(wire).not.toContain(password);
    expect(wire).not.toContain(digest);
    expect(wire).not.toContain(digest.slice(5));
  });

  it("compares returned suffixes locally and rejects positive counts case-insensitively", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(`${digest.slice(5).toLowerCase()}:12\r\n`));
    expect(await screenNewPassword(password)).toBe("compromised");
  });

  it.each(["", "not-a-range", "A".repeat(35) + ":-1", "A".repeat(35) + ":0", "A".repeat(34) + ":1", "A".repeat(35) + ":1\ntruncated"])('fails closed for malformed or empty data (%s)', async (body) => {
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    expect(await screenNewPassword(password)).toBe("unavailable");
  });

  it.each([301, 403, 429, 500, 503])("fails closed for provider status %s", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(safeCorpus, { status }));
    expect(await screenNewPassword(password)).toBe("unavailable");
  });

  it("bounds streaming response bytes even without a Content-Length header", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(128 * 1024)); },
      cancel() { cancelled = true; },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    expect(await screenNewPassword(password)).toBe("unavailable");
    expect(cancelled).toBe(true);
  });

  it("enforces one deadline across response-body streaming and releases its admission slot", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); },
    })));
    const pending = screenNewPassword(password);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toBe("unavailable");
    vi.mocked(fetch).mockResolvedValue(new Response(safeCorpus));
    expect(await screenNewPassword(password)).toBe("acceptable");
  });

  it("limits concurrent provider requests without retaining a queue of candidate passwords", async () => {
    const resolve: Array<(r: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>((done) => resolve.push(done)));
    const active = Array.from({ length: 8 }, () => screenNewPassword(password));
    expect(await screenNewPassword(password)).toBe("unavailable");
    expect(fetch).toHaveBeenCalledTimes(8);
    for (const done of resolve) done(new Response(safeCorpus));
    expect(await Promise.all(active)).toEqual(Array(8).fill("acceptable"));
    vi.mocked(fetch).mockResolvedValue(new Response(safeCorpus));
    expect(await screenNewPassword(password)).toBe("acceptable");
  });

  it("never returns sensitive provider errors to the caller", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`credentials ${password} ${digest}`));
    const result = await screenNewPassword(password);
    expect(result).toBe("unavailable");
    expect(passwordScreeningFailure(result)).toMatchObject({ status: 503, body: { code: "PASSWORD_SCREENING_UNAVAILABLE" } });
    expect(passwordScreeningFailure("compromised")).toMatchObject({ status: 400 });
    expect(passwordScreeningFailure("acceptable")).toBeNull();
  });
});
