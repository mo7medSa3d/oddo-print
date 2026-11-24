import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(path, "utf8");
const retired = ["stripe_price_id", "stripe_price_history", "stripe_product_id", "stripe_customer_id", "stripe_subscription_id", "checkout_session_id", "checkout_status", "billing_operation_id", "billing_mode"];
describe("forward-only manual billing schema", () => {
  it("no longer exposes a provider checkout column in runtime schema or owner API", () => {
    const schema = read("src/db/schema.ts");
    const plans = read("src/app/api/platform/plans/route.ts");
    const explorer = read("src/lib/platform-data-explorer.ts");
    for (const name of retired) expect(schema).not.toContain(`"${name}"`);
    expect(plans).not.toContain("stripe");
    expect(explorer).toContain("RETIRED_COLUMNS");
  });
  it("establishes a clean single-migration manual-only billing baseline", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.length).toBeGreaterThanOrEqual(1);
    expect(journal.entries[0]?.tag).toBe("0000_initial_schema");
    const migration = read("drizzle/0000_initial_schema.sql");
    expect(migration).toContain("approved_term");
    expect(migration).toContain("approval_modified");
    expect(migration).toContain("tenant_subscriptions_status_check");
    // Printing retired with this baseline; manual billing now lives in these tables.
    expect(migration).toContain('CREATE TABLE "tenant_subscriptions"');
    expect(migration).toContain('CREATE TABLE "subscription_changes"');
    expect(migration).toContain('CREATE TABLE "plans"');
    expect(migration).not.toContain("print_monthly_usage");
    for (const column of retired) expect(migration).not.toContain(`"${column}"`);
    const migrateScript = read("scripts/db-migrate.ts");
    expect(migrateScript).toContain("export const AUDIT_REPAIRS: readonly string[] = [];");
    expect(migrateScript).not.toContain("retiredRepair");
  });
  it("all former billing POST routes fail closed without an active provider integration", () => {
    for (const route of ["checkout", "webhook", "cancel", "resume", "portal"]) {
      const source = read(`src/app/api/billing/${route}/route.ts`);
      expect(source).toContain("MANUAL_BILLING_REQUIRED");
      expect(source).toMatch(/status:\s*410/);
    }
  });
});
