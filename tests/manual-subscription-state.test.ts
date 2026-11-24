import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { customerSubscriptionState, manualReactivationDeadlineLive } from "../src/lib/manual-subscriptions";

const now = Date.parse("2026-10-26T12:00:00Z");
const active = { status: "active", currentPeriodStart: new Date(now - 1000), currentPeriodEnd: new Date(now + 1000) };

describe("manual subscription availability agrees with runtime admission", () => {
  it("keeps explicitly activated manual contracts live within their term", () => {
    expect(customerSubscriptionState(active, "active", now)).toBe("active");
  });
  it("fails closed for invalid Date objects instead of comparing NaN", () => {
    expect(customerSubscriptionState({ ...active, currentPeriodStart: new Date(NaN) }, "active", now)).not.toBe("active");
    expect(customerSubscriptionState({ ...active, currentPeriodEnd: new Date(NaN) }, "active", now)).not.toBe("active");
  });
  it("refuses open-ended manual contracts and respects suspension and boundaries", () => {
    expect(customerSubscriptionState({ ...active, currentPeriodEnd: null }, "active", now)).toBe("expired");
    expect(customerSubscriptionState(active, "suspended", now)).toBe("suspended");
    expect(customerSubscriptionState({ ...active, currentPeriodEnd: new Date(now) }, "active", now)).toBe("expired");
    expect(customerSubscriptionState({ ...active, currentPeriodStart: new Date(now + 1) }, "active", now)).toBe("awaiting_activation");
  });
});


describe("platform subscription list uses the runtime admission gate", () => {
  it("cannot report an active manual contract without finite expiry", () => {
    const route = readFileSync("src/app/api/platform/subscriptions/route.ts", "utf8");
    const projection = readFileSync("src/lib/effective-subscription-status.ts", "utf8");
    expect(route).toContain("effectiveSubscriptionStatusSql(");
    expect(projection).toContain("liveTenantSubscriptionPredicate(fields.tenantId)");
    expect(projection).not.toContain("current_period_end IS NULL OR");
  });
});


describe("manual reactivation uses the authoritative UTC database timestamp", () => {
  it("refuses missing, invalid and expired contract end dates", () => {
    const expiry = new Date("2026-10-26T12:00:00Z");
    expect(manualReactivationDeadlineLive(expiry, "2026-10-26 12:00:00")).toBe(false);
    expect(manualReactivationDeadlineLive(null, "2026-10-26 11:59:59")).toBe(false);
    expect(manualReactivationDeadlineLive(new Date(NaN), "2026-10-26 11:59:59")).toBe(false);
    expect(manualReactivationDeadlineLive(expiry, "not-a-timestamp")).toBe(false);
  });
  it("parses a raw PostgreSQL subscription deadline with the same UTC authority", () => {
    expect(manualReactivationDeadlineLive("2026-10-26 12:00:01", "2026-10-26 12:00:00")).toBe(true);
    expect(manualReactivationDeadlineLive("2026-10-26 12:00:00", "2026-10-26 12:00:00")).toBe(false);
    expect(manualReactivationDeadlineLive("invalid date", "2026-10-26 12:00:00")).toBe(false);
  });
  it("parses a zone-less PostgreSQL clock as UTC rather than local time", () => {
    const expiry = new Date("2026-10-26T12:00:01Z");
    expect(manualReactivationDeadlineLive(expiry, "2026-10-26 12:00:00")).toBe(true);
    expect(manualReactivationDeadlineLive(expiry, "2026-10-26T12:00:02+00:00")).toBe(false);
  });
});
