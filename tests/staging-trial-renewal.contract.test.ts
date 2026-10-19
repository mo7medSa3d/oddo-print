import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("deploy/domain-test/renew-expired-trial.sql", "utf8");
const readme = readFileSync("deploy/domain-test/README.md", "utf8");
const setup = readFileSync("deploy/domain-test/setup-domain-test.sh", "utf8");

describe("operator-only staging trial renewal", () => {
  it("requires explicit tenant and optimistic old period end instead of renewing everyone", () => {
    expect(sql).toContain(":'tenant_id'");
    expect(sql).toContain(":'expected_period_end'");
    expect(sql).toContain("WHERE ts.tenant_id = target_id");
    expect(sql).toContain("date_trunc('milliseconds', subscription.current_period_end) <> expected_end");
    expect(sql).toContain("FOR UPDATE OF ts");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });

  it("cannot alter production, paid, blocked, canceled or live subscriptions", () => {
    for (const guard of [
      "current_database() <> 'yasser_http_test'",
      "subscription.plan_id <> 'http-test'",
      "subscription.status <> 'trialing'",
      "subscription.stripe_customer_id IS NOT NULL",
      "subscription.stripe_subscription_id IS NOT NULL",
      "subscription.entitlement_blocked IS TRUE",
      "subscription.cancel_at_period_end IS TRUE",
      "subscription.checkout_status <> 'none'",
      "subscription.current_period_end >= now_utc",
    ]) expect(sql).toContain(guard);
  });

  it("preserves history, uses a new 30-day period and audits explicit renewal", () => {
    expect(sql).toContain("current_period_start = now_utc");
    expect(sql).toContain("new_end := now_utc + interval '30 days'");
    expect(sql).not.toMatch(/DELETE\s+FROM\s+print_usage_periods/i);
    expect(sql).not.toContain("SET status = 'active'");
    expect(sql).toContain("'billing.staging_trial_renewed'");
  });

  it("is not run as an automatic part of staging deployment or migrations", () => {
    expect(setup).not.toContain("renew-expired-trial.sql");
    expect(readme).toContain("renew-expired-trial.sql");
    expect(readme).toContain("TENANT_ID=ten_REPLACE_WITH_VERIFIED_TENANT_ID");
    expect(readme).toContain("ON_ERROR_STOP=1");
  });
});
