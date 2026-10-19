import { describe, expect, it } from "vitest";
import { hasManagerPermission } from "../src/lib/authorization";
import type { ManagerClaims, ManagerRole } from "../src/lib/manager-auth";

function claims(role: ManagerRole): ManagerClaims {
  return {
    sub: "manager",
    tenantId: "tenant_test",
    role,
    jti: "0123456789abcdef",
    iat: 1,
    exp: 2,
  } as ManagerClaims;
}

describe("job payload authorization", () => {
  it("separates document payload access from ordinary job metadata access", () => {
    for (const role of ["owner", "admin", "operator"] as const) {
      expect(hasManagerPermission(claims(role), "jobs.read")).toBe(true);
      expect(hasManagerPermission(claims(role), "jobs.payload.read")).toBe(true);
    }

    for (const role of ["viewer", "integration_admin"] as const) {
      expect(hasManagerPermission(claims(role), "jobs.read")).toBe(true);
      expect(hasManagerPermission(claims(role), "jobs.payload.read")).toBe(false);
    }
  });

  it("keeps billing-only users away from both job metadata and payload content", () => {
    expect(hasManagerPermission(claims("billing_admin"), "jobs.read")).toBe(false);
    expect(hasManagerPermission(claims("billing_admin"), "jobs.payload.read")).toBe(false);
  });
});
