import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { deriveOutcome, parseSharedTimeMs } from "../src/shared/job-vocabulary";
import { clampListLimit } from "../src/lib/request-limits";
import { clearAccessCookieHeader, clearRefreshCookieHeader } from "../src/lib/session-tokens";

function read(path: string): string {
  return fs.readFileSync(path, "utf8");
}

describe("clean-room audit regression contracts (2026-09-29)", () => {
  it("client physical outcome matches the server vocabulary (no unproven state)", () => {
    // Server derivePhysicalOutcome returns not_printed for claimed/printing;
    // the client must not invent a fourth state the server never emits.
    expect(deriveOutcome("claimed", null)).toBe("not_printed");
    expect(deriveOutcome("printing", null)).toBe("not_printed");
    expect(deriveOutcome("success", null)).toBe("unknown");
    expect(deriveOutcome("failed", "AGENT_EXECUTION_TIMEOUT: x")).toBe("unknown");
    expect(deriveOutcome("failed", "ECONNREFUSED")).toBe("not_printed");
  });

  it("shared timestamp parser treats naive DB strings as UTC", () => {
    // node-postgres raw rows emit naive "YYYY-MM-DD HH:MM:SS" in UTC;
    // new Date(str) would parse host-local. TZ-independent by construction.
    expect(parseSharedTimeMs("2026-09-24 00:00:00")).toBe(Date.parse("2026-09-24T00:00:00Z"));
    expect(parseSharedTimeMs("2026-09-24T00:00:00Z")).toBe(Date.parse("2026-09-24T00:00:00Z"));
    const d = new Date("2026-09-24T00:00:00.000Z");
    expect(parseSharedTimeMs(d)).toBe(d.getTime());
    expect(parseSharedTimeMs(null)).toBeNull();
    expect(parseSharedTimeMs("")).toBeNull();
    expect(parseSharedTimeMs("not-a-date")).toBeNull();
  });

  it("list-limit clamp honors ?limit= with floor and ceiling", () => {
    expect(clampListLimit("50", 1000, 1000)).toBe(50);
    expect(clampListLimit("-5", 1000, 1000)).toBe(1);
    expect(clampListLimit("0", 1000, 1000)).toBe(1);
    expect(clampListLimit("5000", 1000, 1000)).toBe(1000);
    expect(clampListLimit(null, 1000, 1000)).toBe(1000);
    expect(clampListLimit("garbage", 200, 1000)).toBe(200);
  });

  it("clear-cookie headers mirror the Secure attribute", () => {
    const prev = process.env.COOKIE_SECURE;
    process.env.COOKIE_SECURE = "1";
    try {
      expect(clearAccessCookieHeader("manager")).toContain("; Secure");
      expect(clearRefreshCookieHeader("manager")).toContain("; Secure");
    } finally {
      if (prev === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = prev;
    }
  });

  it("heartbeat capability allowlist covers the canonical protocol vocabulary", () => {
    const heartbeat = read("src/app/api/agent/heartbeat/route.ts");
    expect(heartbeat).toContain('"windows_spooler"');
    expect(heartbeat).toContain('"unknown"');
  });

  it("agent status transition never fabricates delivery evidence", () => {
    const route = read("src/app/api/agent/jobs/route.ts");
    // deliveredAt stamps only entering printing/success (or printing->failed
    // where delivery already happened); claimed->failed pre-execution and
    // claimed->queued rejection must not gain delivery proof.
    expect(route).toContain('requestedStatus === "printing"');
    expect(route).toContain('requestedStatus === "success"');
    expect(route).toContain('currentStatus === "printing"');
    expect(route).toContain("// deliveredAt is delivery EVIDENCE");
  });

  it("claim lease follows the shared staleness threshold, not a hardcoded 90s", () => {
    const maintenance = read("src/lib/job-maintenance.ts");
    expect(maintenance).toContain("agentStaleThresholdSeconds()");
    const route = read("src/app/api/agent/jobs/route.ts");
    expect(route).toContain("agentStaleThresholdSeconds()");
  });

  it("certification builds transport-valid deterministic payloads with bounded bodies", () => {
    const certify = read("src/app/api/printers/[id]/certify/route.ts");
    expect(certify).toContain("buildDeterministicCertificationPdf");
    expect(certify).toContain("hasBodyOverLimit");
    expect(certify).toContain("Malformed JSON body");
    expect(certify).toContain("isDocumentTransport");
  });

  it("desktop login does not require renderer-visible bearer tokens", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    // The Rust proxy stores tokens Rust-side and strips them from the
    // renderer body; requiring data.accessToken broke Tauri login entirely.
    expect(ipc).not.toContain("!data.accessToken");
  });

  it("desktop only destroys sessions on 401, never on 403", () => {
    const ipc = read("src/desktop/lib/ipc.ts");
    // A 403 means the session is valid but lacks permission; only 401 may
    // trigger refresh-then-clear or session destruction.
    expect(ipc).not.toContain("|| status === 403) await clearManagerSession");
    expect(ipc).not.toContain("response.status === 401 || response.status === 403");
  });

  it("agent HTTP client never races response bodies and never leaks credentials on redirect", () => {
    const agent = read("agent/internal/agent/agent.go");
    const pairing = read("agent/internal/agent/pairing.go");
    // The old doAuthorizedRequest drained+closed resp.Body in a goroutine
    // while callers were still reading it. Callers own the body now.
    expect(agent).not.toContain("Drain and close the response body");
    expect(agent).not.toContain("io.Copy(io.Discard, io.LimitReader(resp.Body");
    // Both the pairing client and the shared credential-bearing client must
    // refuse redirects (else Authorization: Bearer id:secret follows the 3xx).
    expect((agent.match(/CheckRedirect/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect((pairing.match(/CheckRedirect/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("CORS allowlist covers the headers the app actually uses", () => {
    const cors = read("src/server/cors.ts");
    expect(cors).toContain("X-Api-Key");
    expect(cors).toContain("Idempotency-Key");
  });
});
