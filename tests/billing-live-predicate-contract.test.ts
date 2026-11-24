import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { liveTenantSubscriptionPredicate, liveTenantSubscriptionWhere } from "../src/lib/entitlements";

const normal = (s: string) => s.replace(/\s+/g, " ").trim();

describe("one authoritative manual-contract admission rule", () => {
  it.each([true, false])("uses identical SQL for row and correlated predicate (requireUnblocked=%s)", requireUnblocked => {
    const dialect = new PgDialect();
    const row = dialect.sqlToQuery(sql`SELECT 1 FROM tenant_subscriptions ts WHERE ${liveTenantSubscriptionWhere(sql`t.id`, requireUnblocked)}`);
    const correlated = dialect.sqlToQuery(sql`SELECT 1 FROM tenants t WHERE ${liveTenantSubscriptionPredicate(sql`t.id`, requireUnblocked)}`);
    const rowSql = normal(row.sql);
    const correlatedSql = normal(correlated.sql);
    expect(correlatedSql).toContain(`EXISTS ( ${rowSql} )`);
    expect(correlated.params).toEqual(row.params);
    expect(rowSql).toContain("ts.status = 'active'");
    expect(rowSql).toContain("ts.current_period_start <= clock_timestamp()");
    expect(rowSql).toContain("ts.current_period_end > clock_timestamp()");
    expect(rowSql.includes("COALESCE(ts.entitlement_blocked, false) = false")).toBe(requireUnblocked);
  });

  it("delegates predicate construction to the live row filter rather than maintaining a second mutable policy", () => {
    const source = readFileSync("src/lib/entitlements.ts", "utf8");
    const predicate = source.slice(source.indexOf("export function liveTenantSubscriptionPredicate("),
      source.indexOf("async function lockTenantSubscription("));
    expect(predicate).toContain("liveTenantSubscriptionWhere(tenantId, requireUnblocked)");
    expect(predicate).not.toContain("ts.status = 'active'");
  });
});
