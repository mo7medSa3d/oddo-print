import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("authenticated homepage tenant and session read boundary", () => {
  const source = readFileSync("src/app/page.tsx", "utf8");

  it("holds live authority through workspace, subscription, and owner-only plan reads", () => {
    const start = source.indexOf("await db.transaction(async tx => {");
    const tenant = source.indexOf("await requireActiveTenantInTransaction(tx, claims.tenantId);");
    const actor = source.indexOf('await requireManagerActorInTransaction(tx, claims, "tenant.read");');
    const subscription = source.indexOf("tx.query.tenantSubscriptions.findFirst");
    const plan = source.indexOf("tx.query.plans.findFirst");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(tenant);
    expect(tenant).toBeLessThan(actor);
    expect(actor).toBeLessThan(subscription);
    expect(subscription).toBeLessThan(plan);
    expect(source).not.toContain("db.query.tenantSubscriptions.findFirst");
    expect(source).not.toContain("db.query.plans.findFirst");
  });

  it("builds authenticated JSX after asynchronous entitlement errors are caught", () => {
    const view = source.indexOf("const view = await (async () => {");
    const afterRead = source.indexOf("})();", view);
    const jsx = source.indexOf("<AuthenticatedHome", view);
    const fallback = source.indexOf("return <PublicHome", jsx);
    expect(view).toBeGreaterThan(0);
    expect(afterRead).toBeGreaterThan(view);
    expect(jsx).toBeGreaterThan(afterRead);
    expect(fallback).toBeGreaterThan(jsx);
    expect(source.slice(view, afterRead)).not.toContain("<AuthenticatedHome");
    expect(source.slice(view, afterRead)).not.toContain("<PublicHome");
  });

  it("falls back to the public home on a suspended workspace or revoked owner session", () => {
    expect(source).toContain("error instanceof TenantSuspendedError");
    expect(source).toContain("error instanceof TenantDeletedError");
    expect(source).toContain("error instanceof ManagerMutationAuthorityChangedError");
    expect(source).toContain("<PublicHome t={t} locale={locale} />");
    expect(source).toContain("periodEnd={canBilling ? subscription?.currentPeriodEnd ?? null : null}");
  });
});
