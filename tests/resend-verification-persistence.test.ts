import type * as NextServerModule from "next/server";
import type * as AuthRateLimitModule from "../src/lib/auth-rate-limit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  lookup: vi.fn(), transaction: vi.fn(), email: vi.fn(), log: vi.fn(), invitation: vi.fn(),
  callbacks: [] as Array<() => Promise<void>>,
}));
vi.mock("next/server", async importActual => ({
  ...await importActual<typeof NextServerModule>(),
  after: (callback: () => Promise<void>) => { state.callbacks.push(callback); },
}));
vi.mock("../src/db", () => ({ db: { query: { users: { findFirst: state.lookup } }, transaction: state.transaction } }));
vi.mock("../src/lib/auth-rate-limit", async importActual => ({
  ...await importActual<typeof AuthRateLimitModule>(),
  clientIpFrom: () => "198.51.100.11",
  reserveAuthAttempt: async () => ({ allowed: true, limit: 5, remaining: 4, resetAtEpochSec: 1_900_000_000 }),
  // v1/v3: resend-verification reserves the scoped bucket; the real scoped
  // function must not run against this test's mocked db.transaction.
  reserveScopedAuthAttempt: async () => ({ allowed: true, limit: 5, remaining: 4, resetAtEpochSec: 1_900_000_000 }),
}));
vi.mock("../src/lib/email", () => ({ appBaseUrl: () => "https://gateway.test", sendTransactionalEmail: state.email }));
vi.mock("../src/lib/log", () => ({ logError: state.log }));
vi.mock("../src/lib/invitation-join", () => ({ findActiveInvitation: state.invitation }));
vi.mock("../src/i18n/server", () => ({ getServerLocale: async () => "en", makeT: () => (key: string) => key }));
import { POST } from "../src/app/api/auth/resend-verification/route";

const generic = { ok: true, message: "If the account exists and is unverified, a new verification link has been sent." };
const request = (extra: Record<string, unknown> = {}) => new Request("https://gateway.test/api/auth/resend-verification", {
  method: "POST", body: JSON.stringify({ email: "person@example.test", ...extra }),
});

describe("verification resend persistence and enumeration boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.callbacks.length = 0;
    state.lookup.mockResolvedValue({ id: "user-1", emailVerifiedAt: null });
    state.transaction.mockResolvedValue(true);
    state.email.mockResolvedValue(undefined);
    state.invitation.mockResolvedValue(null);
  });

  it.each([undefined, { id: "user-1", emailVerifiedAt: new Date() }])("returns generic acceptance without issuing or sending proof for an ineligible account", async account => {
    state.lookup.mockResolvedValueOnce(account);
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(generic);
    expect(state.transaction.mock.calls).toHaveLength(0);
    expect(state.email.mock.calls).toHaveLength(0);
    expect(state.callbacks).toHaveLength(0);
  });

  it("does not send or schedule a proof when the locked account is no longer eligible", async () => {
    state.transaction.mockResolvedValueOnce(false);
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(generic);
    expect(state.email.mock.calls).toHaveLength(0);
    expect(state.callbacks).toHaveLength(0);
  });

  it("keeps persistence failure generic and never schedules an uncommitted proof", async () => {
    state.transaction.mockRejectedValueOnce(new Error("Synthetic database unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(generic);
    expect(state.email.mock.calls).toHaveLength(0);
    expect(state.callbacks).toHaveLength(0);
    expect(state.log).toHaveBeenCalledWith("auth.resend_verification.persistence_failed", { error: "Synthetic database unavailable" });
  });

  it("preserves identical rate-limit headers for an eligible write failure and an absent account", async () => {
    state.transaction.mockRejectedValueOnce(new Error("Synthetic token write unavailable"));
    const eligible = await POST(request());
    state.lookup.mockResolvedValueOnce(undefined);
    const absent = await POST(request());
    expect(eligible.status).toBe(202);
    expect(absent.status).toBe(202);
    expect(await eligible.json()).toEqual(await absent.json());
    for (const header of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"]) {
      expect(absent.headers.get(header)).not.toBeNull();
      expect(eligible.headers.get(header)).toBe(absent.headers.get(header));
    }
    expect(state.transaction.mock.calls).toHaveLength(1);
    expect(state.callbacks).toHaveLength(0);
    expect(state.email.mock.calls).toHaveLength(0);
  });

  it("returns the same accepted response while known-account provider delivery remains unresolved", async () => {
    let releaseProvider!: () => void;
    state.email.mockReturnValueOnce(new Promise<void>(resolve => { releaseProvider = resolve; }));
    let response: Response | undefined;
    const pending = POST(request()).then(value => { response = value; return value; });
    let delivery: Promise<unknown> | undefined;
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(response, "HTTP response must not wait for the account-dependent provider call").toBeDefined();
      expect(response!.status).toBe(202);
      expect(response!.headers.get("set-cookie")).toBeNull();
      expect(state.transaction.mock.calls).toHaveLength(1);
      delivery = Promise.all(state.callbacks.map(callback => callback()));
      await Promise.resolve();
      expect(state.email.mock.calls).toHaveLength(1);
      state.lookup.mockResolvedValueOnce(undefined);
      const absent = await POST(request());
      expect(absent.status).toBe(response!.status);
      expect(await absent.json()).toEqual(await response!.json());
      expect(state.email.mock.calls).toHaveLength(1);
    } finally {
      releaseProvider();
      await pending;
      await delivery;
    }
  });

  it("waits for proof persistence before acceptance or scheduling delivery", async () => {
    let commit!: () => void;
    state.transaction.mockImplementationOnce(() => new Promise<boolean>(resolve => { commit = () => resolve(true); }));
    let response: Response | undefined;
    const pending = POST(request()).then(value => { response = value; return value; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(response).toBeUndefined();
      expect(state.callbacks).toHaveLength(0);
      expect(state.email.mock.calls).toHaveLength(0);
    } finally {
      commit();
      await pending;
    }
    expect(response!.status).toBe(202);
    expect(state.callbacks).toHaveLength(1);
    await state.callbacks[0]();
    expect(state.email.mock.calls).toHaveLength(1);
  });

  it("logs a post-response delivery failure without changing generic acceptance", async () => {
    state.email.mockRejectedValueOnce(new Error("Synthetic provider unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(state.email.mock.calls).toHaveLength(0);
    expect(state.callbacks).toHaveLength(1);
    await expect(state.callbacks[0]()).resolves.toBeUndefined();
    expect(await response.json()).toEqual(generic);
    expect(state.log).toHaveBeenCalledWith("auth.resend_verification.email_failed", { error: "Synthetic provider unavailable" });
  });

  it("does not reveal account state through an invalid invitation response", async () => {
    const known = await POST(request({ inviteToken: "invalid-invitation" }));
    state.lookup.mockResolvedValueOnce(undefined);
    const absent = await POST(request({ inviteToken: "invalid-invitation" }));
    expect(known.status).toBe(409);
    expect(absent.status).toBe(known.status);
    expect(await absent.json()).toEqual(await known.json());
    expect(state.transaction.mock.calls).toHaveLength(0);
    expect(state.email.mock.calls).toHaveLength(0);
  });

  it("preserves valid invitation and plan continuation in the delivered proof", async () => {
    state.invitation.mockResolvedValueOnce({ id: "invite-1", email: "person@example.test" });
    const response = await POST(request({ inviteToken: "invitation-continuation", planId: "selected-plan" }));
    expect(response.status).toBe(202);
    expect(state.email.mock.calls).toHaveLength(0);
    expect(state.callbacks).toHaveLength(1);
    await state.callbacks[0]();
    const message = state.email.mock.calls[0][0];
    expect(message.to).toBe("person@example.test");
    const link = new URL(/href="([^"]+)"/.exec(message.html)![1]);
    expect(link.pathname).toBe("/verify-email");
    expect(link.searchParams.get("plan")).toBe("selected-plan");
    expect(link.searchParams.get("invite")).toBe("invitation-continuation");
    expect(Boolean(link.searchParams.get("token"))).toBe(true);
  });
});
