import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("Odoo billing control-plane contracts", () => {
  it("keeps Gateway activation entitlement and mutation inside one transaction", () => {
    const source = read("src/app/api/odoo/configuration/route.ts");
    expect(source).toContain("await db.transaction(async (tx) => {");
    expect(source).toContain("await requireTenantBillingAccess(tx, apiKey.tenantId);");
    expect(source).not.toContain("db.query.tenantSubscriptions.findFirst");
    expect(source).not.toContain("isBillingAccessStatus(");
    expect(source).not.toContain("isSubscriptionPeriodLive(");
  });

  it("keeps new Odoo API-key creation entitlement and insertion inside one transaction", () => {
    const source = read("src/app/api/odoo/keys/route.ts");
    expect(source).toContain("await db.transaction(async (tx) => {");
    expect(source).toContain("await requireTenantBillingAccess(tx, manager.tenantId);");
    expect(source).not.toContain("db.query.tenantSubscriptions.findFirst");
    expect(source).not.toContain("isBillingAccessStatus(");
    expect(source).not.toContain("isSubscriptionPeriodLive(");
  });

  it("makes Odoo agent discovery use the canonical database-authoritative billing predicate", () => {
    const source = read("src/app/api/odoo/agents/route.ts");
    expect(source).toContain("await requireTenantBillingAccess(db, apiKey.tenantId);");
    expect(source).not.toContain("db.query.tenantSubscriptions.findFirst");
    expect(source).not.toContain("isBillingAccessStatus(");
    expect(source).not.toContain("isSubscriptionPeriodLive(");
  });

  it("requires active billing access before exposing Odoo printer inventory", () => {
    const source = read("src/app/api/odoo/printers/route.ts");
    expect(source).toContain("await requireTenantBillingAccess(db, apiKey.tenantId);");
  });
});
