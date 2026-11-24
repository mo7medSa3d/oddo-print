import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/manager-auth", () => ({
  validateWorkspaceManager: async () => ({ userId: "user-A", tenantId: "workspace-A", role: "admin" }),
}));
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasManagerPermission, managerPermissions, type ManagerPermission } from "../src/lib/authorization";
import type { ManagerClaims, ManagerRole } from "../src/lib/manager-auth";

const roles: ManagerRole[] = ["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"];
const claims = (role: ManagerRole) => ({
  role, tenantId: "workspace-A", userId: "user-A",
  sub: "manager", jti: "test-access-control-jti", iat: 10, exp: 300,
} as ManagerClaims);
const allowed: ManagerPermission[] = [
  "tenant.read", "tenant.update", "users.read",
  "agents.read", "agents.pair", "agents.disable", "agents.retire",
  "printers.read", "printers.manage", "printers.test",
  "jobs.read", "jobs.payload.read", "jobs.create", "jobs.retry", "jobs.cancel",
  "bindings.read", "bindings.manage", "integrations.read", "integrations.manage",
];
const forbidden: ManagerPermission[] = ["users.manage", "billing.manage"];

describe("one operational Full Access for every workspace membership", () => {
  it.each(roles)("grants all printing/Agent/integration capabilities to %s", role => {
    for (const permission of allowed) expect(hasManagerPermission(claims(role), permission)).toBe(true);
    expect(new Set(managerPermissions(claims(role)))).toEqual(new Set(role === "owner" ? [...allowed, "billing.read"] : allowed));
  });
  it.each(roles)("%s has no team or commercial activation authority", role => {
    for (const permission of forbidden) expect(hasManagerPermission(claims(role), permission)).toBe(false);
    expect(hasManagerPermission(claims(role), "billing.read")).toBe(role === "owner");
  });
  it("unknown role never acquires authority", () => {
    const unknown = claims("unknown" as ManagerRole);
    expect(managerPermissions(unknown)).toEqual([]);
    for (const permission of allowed) expect(hasManagerPermission(unknown, permission)).toBe(false);
  });
  it("workspace mutation routes deny direct HTTP bypass for all logged-in members", async () => {
    vi.stubEnv("APP_BASE_URL", "https://gateway.example.test");
    const { PATCH: changeRole, DELETE: removeMember } = await import("../src/app/api/team/members/route");
    const { POST: transfer } = await import("../src/app/api/team/ownership/route");
    const { POST: subscribe, GET: billingRequests } = await import("../src/app/api/subscription-requests/route");
    const request = new Request("https://gateway.example.test/api/team/invitations", { method: "POST", headers: { Origin: "https://gateway.example.test" } });
    expect((await changeRole(request)).status).toBe(403);
    expect((await removeMember(request)).status).toBe(403);
    expect((await transfer(request)).status).toBe(403);
    expect((await subscribe(request)).status).toBe(403);
    expect((await billingRequests(request)).status).toBe(403);
    vi.unstubAllEnvs();
  });
  it("removes legacy roles while granting invitations only to verified owner sessions", () => {
    const page = readFileSync(join(process.cwd(), "src/app/team/page.tsx"), "utf8");
    const platform = readFileSync(join(process.cwd(), "src/app/api/platform/tenants/[id]/invitations/route.ts"), "utf8");
    const sql = readFileSync(join(process.cwd(), "drizzle/0000_initial_schema.sql"), "utf8");
    expect(page).not.toMatch(/ROLE_VALUES|roleOptions\(|updateRole\(|<Select/);
    expect(page).toContain("/api/team/invitations?limit=");
    expect(page).not.toContain("verifyPlatformOwnerPassword");
    expect(page).toContain('fetchWithSessionRetry("/api/team/invitations"');
    expect(page).not.toContain('type="password"');
    expect(page).toContain('t("team.role.owner")');
    expect(page).toContain('icon={<Crown className="h-3.5 w-3.5 text-warn" aria-hidden />}');
    expect(platform).toContain("status: 410");
    expect(platform).not.toContain("sendTransactionalEmail");
    expect(readFileSync(join(process.cwd(), "src/app/api/team/invitations/route.ts"), "utf8")).toContain('role: "admin"');
    expect(sql).toContain(`CONSTRAINT "tenant_users_role_check" CHECK ("tenant_users"."role" in ('owner','admin'))`);
    expect(sql).toContain(`CONSTRAINT "tenant_invitations_role_check" CHECK ("tenant_invitations"."role" = 'admin')`);
  });
});
