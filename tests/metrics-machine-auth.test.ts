import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  afterStat: undefined as (() => void) | undefined,
  denyOpen: false,
  opened: new Set<number>(),
  largestRead: 0,
  bytesRead: 0,
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    openSync: (path: string, flags: number) => {
      if (io.denyOpen) throw Object.assign(new Error("synthetic EACCES boundary"), { code: "EACCES" });
      const fd = actual.openSync(path, flags); io.opened.add(fd); return fd;
    },
    fstatSync: (fd: number) => { const stat = actual.fstatSync(fd); io.afterStat?.(); return stat; },
    readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
      io.largestRead = Math.max(io.largestRead, length);
      const count = actual.readSync(fd, buffer, offset, length, position); io.bytesRead += count; return count;
    },
    closeSync: (fd: number) => { actual.closeSync(fd); io.opened.delete(fd); },
  };
});

import { assertMetricsMachineConfiguration, isMetricsMachineRequest, MetricsMachineConfigurationError } from "../src/lib/metrics-machine-auth";
import { __clearSecretCacheForTests } from "../src/lib/runtime-secret";

let directory: string;
let file: string;
let token: string;
function request(path = "/api/metrics", method = "GET", authorization = `Bearer ${token}`) {
  return new Request(`https://gateway.example.test${path}`, { method, headers: { authorization } });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "yaseir-metrics-file-"));
  file = join(directory, "token"); token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  vi.stubEnv("METRICS_SCRAPE_TOKEN_FILE", file);
  for (const name of ["GATEWAY_JWT_SECRET", "TRUST_PROXY_SECRET"]) {
    vi.stubEnv(name, randomBytes(32).toString("hex")); vi.stubEnv(`${name}_FILE`, "");
  }
  __clearSecretCacheForTests();
  io.afterStat = undefined; io.denyOpen = false; io.largestRead = 0; io.bytesRead = 0;
});
afterEach(() => {
  expect(io.opened.size).toBe(0);
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); __clearSecretCacheForTests();
});

describe("strict metrics credential custody and scope", () => {
  it("has no default authority or inline environment fallback", () => {
    vi.stubEnv("METRICS_SCRAPE_TOKEN_FILE", ""); vi.stubEnv("METRICS_SCRAPE_TOKEN", token);
    expect(assertMetricsMachineConfiguration).not.toThrow();
    expect(isMetricsMachineRequest(request())).toBe(false);
    expect(io.bytesRead).toBe(0);
  });

  it.each(["", "\n", "\r\n"])("accepts exactly64hex with a permitted terminal newline %j", suffix => {
    writeFileSync(file, token + suffix);
    expect(assertMetricsMachineConfiguration).not.toThrow();
    expect(isMetricsMachineRequest(request())).toBe(true);
    expect(isMetricsMachineRequest(request("/api/metrics", "GET", `Bearer ${token.toUpperCase()}`))).toBe(true);
  });

  it.each(["empty", "truncated", "nonhex", "space", "two-newlines", "bare-cr", "extra-line", "nonascii"])("refuses malformed %s content with a fixed diagnostic", form => {
    const values: Record<string, string | Uint8Array> = {
      empty: "", truncated: token.slice(1), nonhex: "z".repeat(64), space: ` ${token}`,
      "two-newlines": `${token}\n\n`, "bare-cr": `${token}\r`, "extra-line": `${token}\nsecret-value`,
      nonascii: Buffer.from(token, "ascii").map(byte => byte | 0x80),
    };
    writeFileSync(file, values[form]);
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
    try { assertMetricsMachineConfiguration(); } catch (error) {
      expect(String(error)).not.toContain(file); expect(String(error)).not.toContain(token); expect(String(error)).not.toContain("secret-value");
    }
  });

  it("refuses a configured missing file even if an inline value is supplied", () => {
    vi.stubEnv("METRICS_SCRAPE_TOKEN_FILE", join(directory, "missing")); vi.stubEnv("METRICS_SCRAPE_TOKEN", token);
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
  });

  it("fails closed on an open permission error without preserving cached authority", () => {
    expect(isMetricsMachineRequest(request())).toBe(true);
    io.denyOpen = true; // Deterministic OS error boundary even when tests run as root.
    expect(() => isMetricsMachineRequest(request())).toThrow(MetricsMachineConfigurationError);
  });

  it("rejects oversized content before reading it", () => {
    writeFileSync(file, "x".repeat(1024 * 1024));
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
    expect(io.bytesRead).toBe(0);
  });

  it("bounds reads to257bytes when a regular file grows after fstat", () => {
    io.afterStat = () => { io.afterStat = undefined; writeFileSync(file, token + "x".repeat(1024 * 1024)); };
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
    expect(io.bytesRead).toBe(257);
    expect(io.largestRead).toBeLessThanOrEqual(257);
  });

  it("rejects a directory as a credential file", () => {
    vi.stubEnv("METRICS_SCRAPE_TOKEN_FILE", directory);
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
  });

  it.skipIf(process.platform === "win32")("rejects symlinks without following their secret target", () => {
    const link = join(directory, "linked-token"); symlinkSync(file, link);
    vi.stubEnv("METRICS_SCRAPE_TOKEN_FILE", link);
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
    expect(io.bytesRead).toBe(0);
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without blocking on an absent writer", () => {
    const fifo = join(directory, "pipe-token"); execFileSync("mkfifo", [fifo]);
    vi.stubEnv("METRICS_SCRAPE_TOKEN_FILE", fifo);
    const started = performance.now();
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(io.bytesRead).toBe(0);
  });

  it.each(["GATEWAY_JWT_SECRET", "TRUST_PROXY_SECRET"])("rejects normalized opposite-case reuse of file-backed %s", name => {
    const known = join(directory, `${name}-fixture`);
    writeFileSync(known, ` ${token.toUpperCase()}\n`, { mode: 0o600 });
    vi.stubEnv(`${name}_FILE`, known);
    expect(assertMetricsMachineConfiguration).toThrow(MetricsMachineConfigurationError);
  });

  it.each([
    ["POST", "/api/metrics"], ["HEAD", "/api/metrics"], ["GET", "/api/metrics/"],
    ["GET", "/api/health"], ["GET", "/api/metrics?collector=1"], ["GET", "/api/platform/auth/me"],
  ])("provides no authority to %s %s", (method, path) => {
    expect(isMetricsMachineRequest(request(path, method))).toBe(false);
  });

  it("requires one exact Bearer field and performs no cookie/query fallback", () => {
    for (const value of ["", "Bearer", "Basic invalid", `bearer ${token}`, `Bearer  ${token}`, `Bearer ${token} extra`, `Bearer ${token}, Bearer ${token}`, `Bearer ${token.slice(1)}`]) {
      expect(isMetricsMachineRequest(request("/api/metrics", "GET", value))).toBe(false);
    }
    const headers = new Headers({ cookie: `METRICS_SCRAPE_TOKEN=${token}` });
    headers.append("authorization", `Bearer ${token}`); headers.append("authorization", `Bearer ${token}`);
    expect(isMetricsMachineRequest(new Request("https://gateway.example.test/api/metrics", { headers }))).toBe(false);
    expect(isMetricsMachineRequest(new Request(`https://gateway.example.test/api/metrics?token=${token}`))).toBe(false);
  });
});
