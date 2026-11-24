import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("server-rendered billing page owner privacy", () => {
  it("loads subscription, owner requests and quota behind a single current-session fence", () => {
    const page = readFileSync("src/app/billing/page.tsx", "utf8");
    const snapshot = readFileSync("src/lib/billing-page-snapshot.ts", "utf8");
    expect(page).toContain("loadOwnerBillingPageSnapshot(claims)");
    expect(page).not.toContain("db.query.tenantSubscriptions.findFirst");
    expect(page).not.toContain("db.query.subscriptionRequests.findMany");
    expect(page).not.toContain("db.execute(sql");
    const tenant = snapshot.indexOf("await requireActiveTenantInTransaction(tx, claims.tenantId);");
    const actor = snapshot.indexOf('await requireManagerActorInTransaction(tx, claims, "billing.read");');
    const subscription = snapshot.indexOf("tx.query.tenantSubscriptions.findFirst");
    const requests = snapshot.indexOf("tx.query.subscriptionRequests.findMany");
    const quota = snapshot.indexOf("await tx.execute(sql");
    expect(snapshot).toContain("return db.transaction(async tx => {");
    expect(tenant).toBeGreaterThan(0);
    expect(tenant).toBeLessThan(actor);
    expect(actor).toBeLessThan(subscription);
    expect(subscription).toBeLessThan(requests);
    expect(requests).toBeLessThan(quota);
  });

  it("does not render owner data after a revoked or suspended owner is detected", () => {
    const page = readFileSync("src/app/billing/page.tsx", "utf8");
    expect(page).toContain("error instanceof ManagerMutationAuthorityChangedError");
    expect(page).toContain("error instanceof TenantSuspendedError");
    expect(page).toContain("error instanceof TenantDeletedError");
    expect(page).toContain("<BillingActions");
  });
});
