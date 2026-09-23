import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  __setClockSkewForTests,
  clockSkewMs,
  gatewayNow,
  gatewayNowMs,
  isClockCalibrated,
} from "../src/lib/database-clock";
import {
  TenantEntitlementError,
  TenantPrintQuotaExceededError,
  entitlementLimitSignal,
  isBillingAccessStatus,
  isSubscriptionPeriodLive,
} from "../src/lib/entitlements";
import { isLimitSignalResult } from "../src/lib/limit-signal";
import { getAgentAvailability, getEffectivePrinterStatus } from "../src/lib/agent-availability";

const read = (path: string) => readFileSync(path, "utf8");

afterEach(() => {
  __setClockSkewForTests(null);
});

describe("gateway clock calibration", () => {
  it("exposes host time until calibrated, then the database-offset time", () => {
    expect(isClockCalibrated()).toBe(false);
    expect(clockSkewMs()).toBe(0);
    expect(Math.abs(gatewayNowMs() - Date.now())).toBeLessThan(50);

    __setClockSkewForTests(45_000);
    expect(isClockCalibrated()).toBe(true);
    expect(clockSkewMs()).toBe(45_000);
    const delta = gatewayNowMs() - Date.now();
    expect(delta).toBeGreaterThan(44_000);
    expect(delta).toBeLessThan(46_000);
    expect(Math.abs(gatewayNow().getTime() - gatewayNowMs())).toBeLessThan(50);

    __setClockSkewForTests(null);
    expect(isClockCalibrated()).toBe(false);
  });

  it("uses the calibrated clock for agent presence, so a heartbeat is never read as future-dated", () => {
    // Presence rows are written with PostgreSQL now(). A host clock running
    // behind the database makes a fresh heartbeat look future-dated, which the
    // availability gate treats as stale and hides every Agent/printer.
    const lastSeenAt = new Date(Date.now() + 30_000);
    const agent = { lifecycle: "active", status: "online", lastSeenAt };

    __setClockSkewForTests(30_000);
    expect(getAgentAvailability(agent).reason).toBe("active-online-fresh");
    expect(getEffectivePrinterStatus({ lifecycle: "active", status: "online" }, agent)).toBe("online");

    __setClockSkewForTests(null);
    expect(getAgentAvailability(agent).reason).toBe("stale");
    expect(getEffectivePrinterStatus({ lifecycle: "active", status: "online" }, agent)).toBe("offline");
  });

  it("expires a heartbeat that is older than the threshold on the database clock", () => {
    __setClockSkewForTests(120_000);
    const agent = { lifecycle: "active", status: "online", lastSeenAt: new Date() };
    expect(getAgentAvailability(agent).reason).toBe("stale");
  });
});

describe("subscription period gate", () => {
  it("treats only trialing/active/past_due as access-granting statuses", () => {
    expect(isBillingAccessStatus("active")).toBe(true);
    expect(isBillingAccessStatus("trialing")).toBe(true);
    expect(isBillingAccessStatus("past_due")).toBe(true);
    for (const status of ["cancelled", "unpaid", "paused", "incomplete", "", null, undefined]) {
      expect(isBillingAccessStatus(status)).toBe(false);
    }
  });

  it("compares a Stripe period end against the calibrated clock", () => {
    expect(isSubscriptionPeriodLive(null)).toBe(true);
    expect(isSubscriptionPeriodLive(undefined)).toBe(true);
    expect(isSubscriptionPeriodLive(new Date(Date.now() + 60_000))).toBe(true);
    expect(isSubscriptionPeriodLive(new Date(Date.now() - 60_000))).toBe(false);
    expect(isSubscriptionPeriodLive("not-a-timestamp")).toBe(false);

    // Naive PostgreSQL timestamps are UTC, not host-local.
    const naiveUtc = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19).replace("T", " ");
    expect(isSubscriptionPeriodLive(naiveUtc)).toBe(true);

    // A period end 10s from now on the host clock. When the host runs 30s
    // behind the database the period has already ended on the authoritative
    // clock, so access must be revoked; the host clock alone would keep it live.
    const periodEnd = new Date(Date.now() + 10_000);
    __setClockSkewForTests(30_000);
    expect(isSubscriptionPeriodLive(periodEnd)).toBe(false);
    // Host ahead of the database: the same period is still live.
    __setClockSkewForTests(-60_000);
    expect(isSubscriptionPeriodLive(periodEnd)).toBe(true);
  });
});

describe("entitlement limit signal (upgrade dialog contract)", () => {
  it("carries the machine-readable fields the dialog needs for a billing-period quota", () => {
    const periodStart = new Date("2026-09-01T00:00:00.000Z");
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    const error = new TenantPrintQuotaExceededError(500, 500, periodStart, periodEnd);
    const signal = entitlementLimitSignal(error);
    expect(signal).toMatchObject({
      code: "PRINT_QUOTA_EXCEEDED",
      entitlement: "max_prints_per_period",
      limit: 500,
      used: 500,
      remaining: 0,
      upgradeRequired: true,
      retryable: false,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    });
    // Retry-After must be a positive duration derived from the Gateway clock.
    expect(signal?.retryAfterSeconds ?? 0).toBeGreaterThan(0);
  });

  it("distinguishes upgrade-only capacity from a resettable allowance", () => {
    const agents = entitlementLimitSignal(new TenantEntitlementError("max_agents", 3, 3));
    expect(agents).toMatchObject({ entitlement: "max_agents", retryable: false, retryAfterSeconds: null, upgradeRequired: true });

    const rate = entitlementLimitSignal(new TenantEntitlementError("max_jobs_per_minute", 20, 20));
    expect(rate).toMatchObject({ entitlement: "max_jobs_per_minute", retryable: true, retryAfterSeconds: 60 });

    const concurrency = entitlementLimitSignal(new TenantEntitlementError("max_concurrent_jobs", 5, 5));
    expect(concurrency).toMatchObject({ entitlement: "max_concurrent_jobs", retryable: true });
  });

  it("returns null for anything that is not a limit trip", () => {
    expect(entitlementLimitSignal(new Error("boom"))).toBeNull();
    expect(entitlementLimitSignal(undefined)).toBeNull();
  });

  it("recognizes only a returnable signal, never an arbitrary object", () => {
    expect(isLimitSignalResult({ ok: false, limit: { entitlement: "max_prints_per_period", upgradeRequired: true } })).toBe(true);
    expect(isLimitSignalResult({ ok: true, id: "job_1" })).toBe(false);
    expect(isLimitSignalResult({ ok: false, limit: { entitlement: "max_agents" } })).toBe(false);
    expect(isLimitSignalResult(null)).toBe(false);
    expect(isLimitSignalResult({ ok: false, limit: "max_agents" })).toBe(false);
  });
});

describe("clock authority is enforced in the source", () => {
  it("writes agent presence on the database clock", () => {
    const heartbeat = read("src/app/api/agent/heartbeat/route.ts");
    expect(heartbeat).not.toContain("lastSeenAt: new Date()");
    expect(heartbeat).toContain("lastSeenAt: sql`now()`");
  });

  it("writes legacy job lease refreshes on the database clock", () => {
    const heartbeat = read("src/app/api/agent/heartbeat/route.ts");
    expect(heartbeat).not.toContain("updatedAt: new Date()");
    expect(heartbeat).toContain("updatedAt: sql`now()`");
  });

  it("keeps API-key rotation state on PostgreSQL time", () => {
    const auth = read("src/lib/odoo-auth.ts");
    const keys = read("src/app/api/odoo/keys/route.ts");
    expect(auth).toContain("clock_timestamp()");
    expect(auth).not.toContain("gatewayNow()");
    expect(auth).not.toContain("Date.now()");
    expect(keys).toContain("rotationState: sql<");
    expect(keys).toContain("clock_timestamp()");
    expect(keys).not.toContain("const now = Date.now()");
  });

  it("keeps manager JWT/session validity and creation off the host wall clock", () => {
    const auth = read("src/lib/manager-auth.ts");
    const tx = read("src/lib/manager-session-tx.ts");
    expect(auth).toContain("clock_timestamp()");
    expect(auth).toContain("EXTRACT(EPOCH FROM clock_timestamp())");
    expect(auth).toContain("databaseNowMs");
    expect(auth).not.toContain("claims.exp * 1000 <= Date.now()");
    expect(auth).not.toContain("claims.iat * 1000 > Date.now()");
    expect(auth).not.toContain("row.expiresAt.getTime() <= Date.now()");
    expect(tx).toContain("clock_timestamp()");
    expect(tx).not.toContain("Math.floor(Date.now() / 1000)");
  });

  it("writes auth consumption and lifecycle metadata on PostgreSQL time", () => {
    const selection = read("src/app/api/auth/select-tenant/route.ts");
    const actions = read("src/app/actions.ts");
    const manager = read("src/lib/manager-auth.ts");

    expect(selection).toContain("windowStartedAt: sql`now()`");
    expect(selection).toContain("updatedAt: sql`now()`");
    expect(actions).toContain("updatedAt: sql`now()`");
    expect(manager).toContain("updatedAt: sql`now()`");
  });

  it("keeps authentication token TTLs on PostgreSQL time", () => {
    const platform = read("src/lib/platform-auth.ts");
    const selection = read("src/lib/customer-auth.ts");
    const verifyEmail = read("src/app/api/auth/verify-email/route.ts");
    const resend = read("src/app/api/auth/resend-verification/route.ts");
    const forgot = read("src/app/api/auth/forgot-password/route.ts");
    const reset = read("src/app/api/auth/reset-password/route.ts");

    expect(platform).toContain("EXTRACT(EPOCH FROM clock_timestamp())");
    expect(platform).toContain("clock_timestamp()");
    expect(platform).not.toContain("claims.exp * 1000 <= Date.now()");
    expect(platform).not.toContain("session.expiresAt.getTime() <= Date.now()");

    expect(selection).toContain("EXTRACT(EPOCH FROM clock_timestamp())");
    expect(selection).not.toContain("Math.floor(Date.now() / 1000)");

    expect(verifyEmail).toContain("gt(emailVerificationTokens.expiresAt, sql`clock_timestamp()`)");
    expect(verifyEmail).toContain("consumedAt: sql`now()`");
    expect(resend).toContain("clock_timestamp() + interval '30 minutes'");
    expect(resend).toContain("consumedAt: sql`now()`");
    expect(forgot).toContain("clock_timestamp() + interval '20 minutes'");
    expect(forgot).toContain("consumedAt: sql`now()`");
    expect(reset).toContain("gt(passwordResetTokens.expiresAt, sql`clock_timestamp()`)");
    expect(reset).toContain("consumedAt: sql`now()`");
    expect(reset).toContain("updatedAt: sql`now()`");
    expect(reset).not.toContain("new Date()");
  });

  it("keeps every JS availability default on the calibrated clock", () => {
    for (const path of ["src/lib/agent-availability.ts", "src/lib/agent-health.ts", "src/lib/routing.ts"]) {
      const source = read(path);
      expect(source).not.toMatch(/now = new Date\(\)/);
      expect(source).toContain("gatewayNow");
    }
  });

  it("stamps job lifetime timestamps from the single database clock read", () => {
    const service = read("src/lib/print-job-service.ts");
    const clockRead = service.indexOf("SELECT clock_timestamp() AS now");
    const insert = service.indexOf("await tx.insert(printJobs).values({");
    expect(clockRead).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(clockRead);
    expect(service.slice(insert)).toContain("createdAt: dbNow");
    expect(service.slice(insert)).toContain("updatedAt: dbNow");
    expect(read("src/db/schema.ts")).toContain('timestamp("created_at").default(sql`clock_timestamp()`)');
    expect(read("drizzle/0067_print_job_wall_clock.sql")).toContain('ALTER COLUMN "created_at" SET DEFAULT clock_timestamp()');
  });

  it("verifies Stripe signatures and Checkout expiry on the calibrated clock", () => {
    const stripe = read("src/lib/stripe.ts");
    const signature = stripe.slice(stripe.indexOf("export function verifyStripeSignature"));
    expect(signature.slice(0, 1200)).toContain("gatewayNowMs()");
    expect(signature.slice(0, 1200)).not.toContain("Date.now()");

    const checkout = read("src/app/api/billing/checkout/route.ts");
    const expiry = checkout.slice(checkout.indexOf("function checkoutIntentExpired"), checkout.indexOf("export async function POST"));
    expect(expiry).toContain("gatewayNowMs()");
    expect(expiry).not.toContain("Date.now()");
  });

  it("routes the subscription gate through one helper instead of per-route host-clock comparisons", () => {
    for (const path of [
      "src/app/api/billing/status/route.ts",
      "src/app/api/odoo/agents/route.ts",
      "src/app/api/odoo/configuration/route.ts",
      "src/app/api/odoo/keys/route.ts",
    ]) {
      const source = read(path);
      expect(source).toContain("isBillingAccessStatus");
      expect(source).toContain("isSubscriptionPeriodLive");
      expect(source).not.toContain("currentPeriodEnd) > new Date()");
    }
  });

  it("returns the quota signal from server actions instead of throwing it away", () => {
    const actions = read("src/app/actions.ts");
    // Thrown server-action errors are sanitized in a production build, so a
    // thrown ActionError can never carry `details` to the dialog.
    expect(actions).toContain("return { ok: false as const, limit } satisfies LimitSignalResult");
    expect(actions).not.toMatch(/throw new ActionError\(error\.message, 429, error\.code, \{\s*\n\s*entitlement:/);

    const dashboard = read("src/app/dashboard/dashboard-client.tsx");
    expect(dashboard).toContain("isLimitSignalResult(result)");
    expect(dashboard).toContain("setUpgradeLimit(limit)");
    expect(dashboard).toContain('case "max_prints_per_period": return "prints"');
  });
});
