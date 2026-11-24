import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookies: {} as Record<string, string>, platformActive: true }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => state.cookies[key] ? { value: state.cookies[key] } : undefined }) }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (path: string) => { throw new Error("REDIRECT:" + path); },
}));
vi.mock("../src/lib/manager-auth", () => ({
  getManagerCookieName: () => "mgr_session",
  verifyWorkspaceTokenFromCookieValues: async (customer: string, manager: string) => customer || manager ? { role: "owner" } : null,
}));
vi.mock("../src/lib/platform-auth", () => ({
  verifyPlatformTokenSignature: (token: string) => token === "platform-token" ? { kind: "platform" } : null,
  validatePlatformClaims: async (claims: unknown, touch: boolean) => state.platformActive && touch ? claims : null,
}));
vi.mock("../src/lib/authorization", () => ({ hasManagerPermission: () => true }));
vi.mock("../src/i18n/server", () => ({ getServerLocale: async () => "ar", makeT: () => (key: string) => key }));
vi.mock("../src/components/ui", () => ({ PageContainer: "div", PageHeader: "header" }));
vi.mock("../src/app/platform/release-readiness/release-readiness-client", () => ({ default: "internal-release-report" }));

import ReleaseReadinessPage from "../src/app/platform/release-readiness/page";

describe("internal release report access", () => {
  beforeEach(() => { state.cookies = {}; state.platformActive = true; });
  it.each(["cust_session", "mgr_session"])("does not expose test-only UI through a %s workspace session", async cookie => {
    state.cookies[cookie] = "workspace-owner-token";
    await expect(ReleaseReadinessPage()).rejects.toThrow("NOT_FOUND");
  });
  it("rejects anonymous and forged platform sessions", async () => {
    await expect(ReleaseReadinessPage()).rejects.toThrow("NOT_FOUND");
    state.cookies.plt_session = "forged-token";
    await expect(ReleaseReadinessPage()).rejects.toThrow("NOT_FOUND");
  });
  it("allows the internal report only for an active Platform Owner session", async () => {
    state.cookies.plt_session = "platform-token";
    await expect(ReleaseReadinessPage()).resolves.toBeTruthy();
    state.platformActive = false;
    await expect(ReleaseReadinessPage()).rejects.toThrow("NOT_FOUND");
  });
});
