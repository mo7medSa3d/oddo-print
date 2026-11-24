import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalLicensePayloadBytes } from "../src/lib/license-signer";

describe("License-only control plane: canonicalization contract", () => {
  it("removes legacy print-job-service and canonicalizes license claims deterministically", () => {
    expect(existsSync("src/lib/print-job-service.ts")).toBe(false);
    const claimsA = {
      version: 2 as const,
      license_id: "lic_1",
      tenant_id: "tenant_1",
      odoo_db_uuid: "db_1",
      plan: "pro",
      status: "active" as const,
      rev: 1,
      key_id: "k1",
      max_agents: 5,
      max_printers: 20,
      features: ["pos", "reports"],
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
      grace_until: "2027-01-08T00:00:00.000Z",
    };
    const claimsB = { ...claimsA, features: ["pos", "reports"] };
    expect(canonicalLicensePayloadBytes(claimsA).equals(canonicalLicensePayloadBytes(claimsB))).toBe(true);
  });

  it("keeps license verify and refresh endpoints present", () => {
    expect(existsSync("src/app/api/license/verify/route.ts")).toBe(true);
    expect(existsSync("src/app/api/license/refresh/route.ts")).toBe(true);
    expect(readFileSync("src/db/schema.ts", "utf8")).not.toMatch(/pgTable\("print_jobs"/);
  });
});
