import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { activationWhatsAppUrl } from "../src/lib/activation-contact";
import { hasManagerPermission, managerPermissions } from "../src/lib/authorization";
import type { ManagerClaims } from "../src/lib/manager-auth";

const state = vi.hoisted(() => ({ role: "owner", lifecycle: "active", plan: true, statements: [] as string[], names: [] as string[], pending: [] as string[], audit: 0, actorValid: true }));
const dialect = new PgDialect();
const tx = {
  execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    state.statements.push(dialect.sqlToQuery(query).sql);
    return { rows: [{ id: "tenant", lifecycle: state.lifecycle }] };
  },
  query: { plans: { findFirst: async () => state.plan ? { id: "public-plan" } : null } },
  update: () => ({ set: (value: { name: string }) => ({ where: async () => { state.names.push(value.name); } }) }),
};
vi.mock("../src/db", () => ({ db: { transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } }));
vi.mock("../src/lib/manager-auth", () => ({ validateWorkspaceManager: async () => ({ userId: "owner-user", tenantId: "tenant", role: state.role }) }));
vi.mock("../src/lib/manager-mutation-authorization", () => {
  class ManagerMutationAuthorityChangedError extends Error { response() { return Response.json({}, { status: 403 }); } }
  return { ManagerMutationAuthorityChangedError, requireManagerActorInTransaction: async () => { if (!state.actorValid) throw new ManagerMutationAuthorityChangedError(); } };
});
vi.mock("../src/lib/manual-subscriptions", () => ({ ensurePendingManualSubscription: async (_tx: unknown, tenant: string, plan: string) => { state.pending.push(`${tenant}:${plan}`); } }));
vi.mock("../src/lib/audit", () => ({ writeAuditEvent: async () => { state.audit++; } }));
import { POST } from "../src/app/api/onboarding/route";
const request = (body: unknown) => new Request("http://local/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const validBody = { workspaceName: "Company", planId: "public-plan" };

describe("workspace onboarding and commercial actions are Platform Owner-only", () => {
  beforeEach(() => { state.role = "owner"; state.lifecycle = "active"; state.plan = true;
    state.statements = []; state.names = []; state.pending = []; state.audit = 0; state.actorValid = true; });
  it.each(["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"])(
    "does not permit %s to submit a workspace name, plan or activation request", async role => {
      state.role = role;
      const response = await POST(request(validBody));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "PLATFORM_OWNER_REQUIRED" });
      expect(state.statements).toEqual([]);
      expect(state.pending).toEqual([]);
      expect(state.names).toEqual([]);
      expect(state.audit).toBe(0);
    });
  it.each([true, false])("retired trial payload (%s) cannot bypass Platform Owner scope", async trial => {
    expect((await POST(request({ ...validBody, trial }))).status).toBe(403);
    expect(state.names).toEqual([]);
    expect(state.pending).toEqual([]);
  });
});
describe("operational Full Access is independent of commercial authority", () => {
  const principal = (role: ManagerClaims["role"]) => ({ role } as ManagerClaims);
  it.each(["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"] as const)(
    "%s has printer and workspace configuration access but not billing/team management", role => {
      for (const permission of ["tenant.update", "agents.pair", "printers.manage", "jobs.create", "integrations.manage"] as const)
        expect(hasManagerPermission(principal(role), permission)).toBe(true);
      for (const permission of ["users.manage", "billing.manage"] as const)
        expect(hasManagerPermission(principal(role), permission)).toBe(false);
      expect(hasManagerPermission(principal(role), "billing.read")).toBe(role === "owner");
      expect(managerPermissions(principal(role)).includes("billing.read")).toBe(role === "owner");
    });
});

describe("safe activation contact", () => {
  const original = process.env.YASEIR_ACTIVATION_WHATSAPP;
  afterEach(() => { if (original === undefined) delete process.env.YASEIR_ACTIVATION_WHATSAPP; else process.env.YASEIR_ACTIVATION_WHATSAPP = original; });
  it("uses the configured public number and opaque reference only", () => {
    process.env.YASEIR_ACTIVATION_WHATSAPP = "+966500000000";
    const url = new URL(activationWhatsAppUrl("req_safe123")!);
    expect(url.origin).toBe("https://wa.me"); expect(url.pathname).toBe("/966500000000");
    expect(url.searchParams.get("text")).toContain("req_safe123");
    expect(url.searchParams.get("text")).not.toContain("@");
  });
  it.each(["", "https://attacker.test", "123?text=secret", "00000000"])("rejects invalid public contact configuration (%s)", number => {
    process.env.YASEIR_ACTIVATION_WHATSAPP = number;
    expect(activationWhatsAppUrl("req_safe123")).toBeNull();
  });
  it("rejects references containing private text or URL injection", () => {
    process.env.YASEIR_ACTIVATION_WHATSAPP = "966500000000";
    for (const value of ["user@example.com", "req_safe&email=secret", "req_\nsecret", "req_" + "a".repeat(97)]) expect(activationWhatsAppUrl(value)).toBeNull();
  });
});
