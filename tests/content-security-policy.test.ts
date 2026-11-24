import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestContentSecurityPolicy, shouldApplyPageContentSecurityPolicy } from "../src/server/content-security-policy";

afterEach(() => vi.unstubAllEnvs());

describe("request content security policy", () => {
  it("uses 256 random bits for each nonce and shares it between script and style directives", () => {
    const first = createRequestContentSecurityPolicy();
    const second = createRequestContentSecurityPolicy();
    expect(Buffer.from(first.nonce, "base64")).toHaveLength(32);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.policy).toContain(`script-src 'self' 'nonce-${first.nonce}' 'strict-dynamic'`);
    expect(first.policy).toContain(`style-src 'self' 'nonce-${first.nonce}'`);
    expect(first.policy).not.toContain(second.nonce);
  });

  it("rejects base elements so injected markup cannot retarget relative URLs", () => {
    expect(createRequestContentSecurityPolicy().policy).toContain("base-uri 'none';");
  });

  it("keeps production script execution nonce-bound and refuses embedding", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { policy } = createRequestContentSecurityPolicy();
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy.match(/script-src[^;]+/)?.[0]).not.toContain("'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'none';");
    expect(policy).toContain("object-src 'none';");
    expect(policy).toContain("form-action 'self';");
    expect(policy).toContain("upgrade-insecure-requests;");
  });

  it("allows the development evaluator only in the explicit development environment", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(createRequestContentSecurityPolicy().policy).toContain("'unsafe-eval'");
    vi.stubEnv("NODE_ENV", "test");
    expect(createRequestContentSecurityPolicy().policy).not.toContain("'unsafe-eval'");
  });

  it("attaches the page policy to document routes while leaving API and static assets separate", () => {
    for (const route of [undefined, "/", "/dashboard", "/platform/login?next=%2Fplatform"]) {
      expect(shouldApplyPageContentSecurityPolicy(route)).toBe(true);
    }
    for (const route of ["/api/health", "/_next/static/file.js", "/favicon.ico"]) {
      expect(shouldApplyPageContentSecurityPolicy(route)).toBe(false);
    }
  });
});
