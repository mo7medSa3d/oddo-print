import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db";
import { tenants, users, tenantInvitations, tenantUsers, plans, tenantSubscriptions, agents, discoverySessions } from "../src/db/schema";
import { eq, and } from "drizzle-orm";
import { hashToken } from "../src/lib/password";
import { nanoid } from "../src/lib/nanoid";
import { transitionTenantLifecycle, TenantLifecycleError } from "../src/lib/tenant-lifecycle";
import { POST as acceptInvitation } from "../src/app/api/team/invitations/accept/route";
import { POST as onboarding } from "../src/app/api/onboarding/route";
import { POST as checkout } from "../src/app/api/billing/checkout/route";
import { POST as startDiscovery } from "../src/app/api/agents/[id]/discovery/route";
import { validateManager } from "../src/lib/manager-auth";
import { requireManagerPermission } from "../src/lib/authorization";
import { stripeRequest } from "../src/lib/stripe";
import { applyMigrations, closePool, hasTestDatabase, truncateAll } from "./helpers/pg";

vi.mock("../src/lib/manager-auth", () => ({
  validateManager: vi.fn(),
}));
vi.mock("../src/lib/authorization", () => ({
  requireManagerPermission: vi.fn(),
  hasManagerPermission: vi.fn(() => true),
}));
vi.mock("../src/lib/stripe", () => ({
  stripeRequest: vi.fn(),
}));

const suite = describe.skipIf(!hasTestDatabase);

suite("control-plane concurrency invariants", () => {
  beforeAll(async () => { await applyMigrations(); });
  beforeEach(async () => {
    await truncateAll();
    vi.mocked(validateManager).mockResolvedValue({
      jti: "test-manager-jti-1234567890",
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: "manager",
      tenantId: "tenant_control_plane",
      userId: "user_control_plane",
      role: "owner",
    });
    vi.mocked(requireManagerPermission).mockReturnValue(undefined);
    vi.mocked(stripeRequest).mockImplementation(async (path: string, _form: URLSearchParams, idempotencyKey?: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (path === "customers") return { id: "cus_control_plane" };
      if (path === "checkout/sessions") return { url: `https://checkout.example/${idempotencyKey}` };
      throw new Error(`unexpected Stripe path: ${path}`);
    });
    await db.insert(tenants).values({ id: "tenant_control_plane", name: "Control Plane Tenant" });
  });
  afterAll(async () => { await closePool(); });

  it("rejects invitation acceptance when the tenant is suspended or deleted", async () => {
    for (const lifecycle of ["suspended", "deleted"] as const) {
      await truncateAll();
      const tenantId = `tenant_invite_${lifecycle}_${nanoid(6)}`;
      const userId = `usr_invite_${nanoid(8)}`;
      const invitationId = `inv_${nanoid(8)}`;
      const token = `token_${nanoid(24)}`;
      const email = `${nanoid(8).toLowerCase()}@example.test`;
      await db.insert(tenants).values({ id: tenantId, name: "Invite Tenant" });
      await db.insert(users).values({ id: userId, email, passwordHash: "unused" });
      await db.insert(tenantInvitations).values({
        id: invitationId, tenantId, inviterUserId: userId, email, role: "viewer",
        tokenHash: await hashToken(token), expiresAt: new Date(Date.now() + 3600_000),
      });
      await transitionTenantLifecycle(tenantId, lifecycle, "test lifecycle", { type: "platform", id: "test-platform" });

      const response = await acceptInvitation(new Request("http://localhost/invite", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, email }),
      }));
      expect(response.status).toBe(409);

      const invitation = await db.query.tenantInvitations.findFirst({ where: eq(tenantInvitations.id, invitationId) });
      expect(invitation?.acceptedAt).toBeNull();
      const membership = await db.query.tenantUsers.findFirst({
        where: and(eq(tenantUsers.userId, userId), eq(tenantUsers.tenantId, tenantId)),
      });
      expect(membership).toBeUndefined();
    }
  });

  it("protects the configured platform tenant from lifecycle suspension and deletion", async () => {
    vi.stubEnv("PLATFORM_TENANT_ID", "tenant_control_plane");
    await expect(transitionTenantLifecycle("tenant_control_plane", "suspended", "test", { type: "platform", id: "admin" }))
      .rejects.toMatchObject({ code: "PLATFORM_TENANT_PROTECTED", status: 409 } as Partial<TenantLifecycleError>);
    await expect(transitionTenantLifecycle("tenant_control_plane", "deleted", "test", { type: "platform", id: "admin" }))
      .rejects.toMatchObject({ code: "PLATFORM_TENANT_PROTECTED", status: 409 } as Partial<TenantLifecycleError>);
    const row = await db.query.tenants.findFirst({ where: eq(tenants.id, "tenant_control_plane") });
    expect(row?.lifecycle).toBe("active");
    vi.unstubAllEnvs();
  });

  it("enforces at most one owner membership per tenant at the database boundary", async () => {
    const firstUserId = `owner_a_${nanoid(8)}`;
    const secondUserId = `owner_b_${nanoid(8)}`;
    await db.insert(users).values([
      { id: firstUserId, email: `${firstUserId}@example.test`, passwordHash: "unused" },
      { id: secondUserId, email: `${secondUserId}@example.test`, passwordHash: "unused" },
    ]);
    await db.insert(tenantUsers).values({
      userId: firstUserId, tenantId: "tenant_control_plane", role: "owner",
    });
    await expect(
      db.insert(tenantUsers).values({
        userId: secondUserId, tenantId: "tenant_control_plane", role: "owner",
      }),
    ).rejects.toThrow(/tenant_users_single_owner_idx|duplicate key/i);
  });

  it("allows only one concurrent onboarding trial for a tenant", async () => {
    const planId = `plan_trial_${nanoid(8)}`;
    await db.insert(plans).values({
      id: planId, name: `Trial ${nanoid(6)}`, stripePriceId: `price_${nanoid(8)}`,
      entitlements: { maxPrinters: 5 }, currency: "usd", interval: "month",
    });
    const request = () => onboarding(new Request("http://localhost/api/onboarding", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "Control Plane Tenant", planId, trial: true }),
    }));
    const [a, b] = await Promise.all([request(), request()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const subscription = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_control_plane") });
    expect(subscription?.status).toBe("trialing");
    expect(subscription?.trialStartedAt).toBeInstanceOf(Date);
  });

  it("serializes concurrent checkout requests and creates one Stripe customer/session per tenant+plan", async () => {
    const planId = `plan_checkout_${nanoid(8)}`;
    await db.insert(plans).values({
      id: planId, name: `Checkout ${nanoid(6)}`, stripePriceId: `price_${nanoid(8)}`,
      entitlements: {}, currency: "usd", interval: "month",
    });
    const request = () => checkout(new Request("http://localhost/api/billing/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId }),
    }));
    const [a, b] = await Promise.all([request(), request()]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    const stripeCalls = vi.mocked(stripeRequest).mock.calls;
    const customerCalls = stripeCalls.filter(([path]) => path === "customers");
    const checkoutCalls = stripeCalls.filter(([path]) => path === "checkout/sessions");
    expect(customerCalls).toHaveLength(1);
    expect(checkoutCalls).toHaveLength(2);
    expect(checkoutCalls[0]?.[2]).toBe(`checkout-${"tenant_control_plane"}-${planId}`);
    expect(checkoutCalls[1]?.[2]).toBe(checkoutCalls[0]?.[2]);
    const subscription = await db.query.tenantSubscriptions.findFirst({ where: eq(tenantSubscriptions.tenantId, "tenant_control_plane") });
    expect(subscription?.stripeCustomerId).toBe("cus_control_plane");
    expect(subscription?.stripeSubscriptionId).toBeNull();
  });

  it("allows at most one running discovery session per agent", async () => {
    const agentId = `agent_discovery_${nanoid(8)}`;
    await db.insert(agents).values({
      id: agentId, tenantId: "tenant_control_plane", name: "Discovery Agent", lifecycle: "active", status: "online",
    });
    const request = () => startDiscovery(
      new Request(`http://localhost/api/agents/${agentId}/discovery`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: agentId }) },
    );
    const [a, b] = await Promise.all([request(), request()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const running = await db.query.discoverySessions.findMany({
      where: and(eq(discoverySessions.tenantId, "tenant_control_plane"), eq(discoverySessions.agentId, agentId), eq(discoverySessions.status, "running")),
    });
    expect(running).toHaveLength(1);
  });
});
