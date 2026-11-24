import { describe, expect, it } from "vitest";
import { hasManagerPermission } from "../src/lib/authorization";
import type { ManagerClaims, ManagerRole } from "../src/lib/manager-auth";
const claims = (role: ManagerRole) => ({
  sub: "manager", tenantId: "tenant_test", role, jti: "0123456789abcdef", iat: 1, exp: 2,
} as ManagerClaims);
const roles: ManagerRole[] = ["owner", "admin", "operator", "viewer", "integration_admin", "billing_admin"];
describe("full operational job payload authorization with commercial isolation", () => {
  it.each(roles)("grants full printing and job payload access to %s", role => {
    expect(hasManagerPermission(claims(role), "jobs.read")).toBe(true);
    expect(hasManagerPermission(claims(role), "jobs.payload.read")).toBe(true);
  });
  it.each(roles)("denies commercial and team mutation permission to %s", role => {
    expect(hasManagerPermission(claims(role), "billing.read")).toBe(role === "owner");
    expect(hasManagerPermission(claims(role), "billing.manage")).toBe(false);
    expect(hasManagerPermission(claims(role), "users.manage")).toBe(false);
  });
});
