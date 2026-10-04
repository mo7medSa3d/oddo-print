import { afterEach, describe, expect, it, vi } from "vitest";
import { logError } from "../src/lib/log";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { readFileSync } from "node:fs";

// Native Node policy module: execute its actual pure evaluator rather than a
// source-text imitation of the security gate.
// @ts-expect-error JavaScript module has no declaration file.
import { evaluateAudit } from "../scripts/audit-gate.mjs";

afterEach(() => vi.restoreAllMocks());

describe("production audit regressions", () => {
  it("redacts nested secrets, arrays and enumerable Error details", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("request failed"), { token: "private-token", details: { password: "private-password" } });
    const circular: Record<string, unknown> = { api_key: "private-api-key" };
    circular.self = circular;
    logError("audit.fixture", { nested: { authorization: "private-auth", rows: [{ payload: "private-document", value: 42n }] }, error, circular });
    const line = String(spy.mock.calls[0][0]);
    for (const secret of ["private-token", "private-password", "private-api-key", "private-auth", "private-document"]) expect(line).not.toContain(secret);
    expect(JSON.parse(line)).toMatchObject({ nested: { rows: [{ value: "42", payload: "[redacted]" }] }, error: { name: "Error", message: "request failed", token: "[redacted]" } });
    expect(line).toContain("[Circular]");
  });

  it("validates Argon2 version and password bounds", async () => {
    const hash = await hashPassword("correct-password-123");
    expect(await verifyPassword("correct-password-123", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
    expect(await verifyPassword("correct-password-123", hash.replace("v=19", "v=16"))).toBe(false);
    expect(await verifyPassword("x".repeat(4097), hash)).toBe(false);
  });

  it("allows only matching dev-only advisory nodes and fails closed", () => {
    const allowed = [{ id: "GHSA-example", package: "braces" }];
    const report = { vulnerabilities: { braces: { name: "braces", nodes: ["node_modules/braces"], via: [{ url: "https://github.com/advisories/GHSA-example", severity: "high" }] } }, metadata: { vulnerabilities: { high: 1, critical: 0 } } };
    const lock = { packages: { "node_modules/braces": { dev: true } } };
    expect(evaluateAudit(report, 1, lock, {}, allowed)).toEqual([]);
    expect(evaluateAudit(report, 1, { packages: { "node_modules/braces": {} } }, {}, allowed).join()).toContain("dev-only");
    expect(evaluateAudit(report, 1, lock, { dependencies: { braces: "3" } }, allowed).join()).toContain("dev-only");
    expect(evaluateAudit({ error: { code: "E503" } }, 1, lock, {}, allowed).join()).toContain("Incomplete");
    expect(evaluateAudit(report, 2, lock, {}, allowed).join()).toContain("failed");
    expect(evaluateAudit(report, 1, lock, {}, [{ id: "GHSA-example", package: "other" }]).join()).toContain("Unlisted");
    const moderate = { vulnerabilities: { other: { name: "other", via: [{ url: "https://github.com/advisories/moderate", severity: "moderate" }] } }, metadata: { vulnerabilities: { high: 0, critical: 0 } } };
    expect(evaluateAudit(moderate, 0, lock, {}, [])).toEqual([]);
    expect(evaluateAudit(moderate, 0, lock, {}, allowed).join()).toContain("Stale");
  });

  it("locks the subscription row scoped by the canonical tenant row predicate", () => {
    const route = readFileSync("src/app/api/agent/register/route.ts", "utf8");
    expect(route).toContain("WHERE ${liveTenantSubscriptionWhere(sql`${agent.tenantId}`)}");
    expect(route).not.toContain("liveTenantSubscriptionPredicate");
  });
});
