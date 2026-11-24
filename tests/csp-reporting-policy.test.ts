import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestContentSecurityPolicy } from "../src/server/content-security-policy";

describe("CSP violation reporting policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds one fixed same-origin collector while preserving enforcing nonce policy", () => {
    vi.stubEnv("NODE_ENV", "production");
    const first = createRequestContentSecurityPolicy();
    const second = createRequestContentSecurityPolicy();
    expect(first.policy).toContain("report-uri /api/security/csp-report;");
    expect(first.policy.match(/report-uri/g)).toHaveLength(1);
    expect(first.policy).toContain(`script-src 'self' 'nonce-${first.nonce}' 'strict-dynamic';`);
    expect(first.policy).toContain("object-src 'none';");
    expect(first.policy).toContain("frame-ancestors 'none';");
    expect(first.policy).not.toContain("'unsafe-eval'");
    expect(first.policy).not.toContain("report-sample");
    expect(first.nonce).not.toBe(second.nonce);
  });
});
