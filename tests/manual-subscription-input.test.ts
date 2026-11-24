import { describe, expect, it } from "vitest";
import { endOfCalendarTermUTC, parseManualSubscriptionInput } from "../src/lib/manual-subscriptions";

const valid = {
  action: "save", expectedRevision: 0, planId: "manual", subscriptionType: "paid",
  monthlyQuota: 100, term: "monthly", status: "active", reason: "Verified invoice",
  startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-11-01T00:00:00.000Z",
};

describe("manual subscription input boundary", () => {
  it.each(["action", "subscriptionType", "term", "status"])("rejects an array masquerading as %s", field => {
    expect(() => parseManualSubscriptionInput({ ...valid, [field]: [valid[field as keyof typeof valid]] }))
      .toThrow("SUBSCRIPTION_INVALID");
  });

  it.each([
    "2026-02-30T00:00:00.000Z",
    "2026-10-01T00:00:00",
    "10/01/2026",
    "2026-10-01T24:00:00.000Z",
  ])("rejects ambiguous or nonexistent start dates: %s", startDate => {
    expect(() => parseManualSubscriptionInput({ ...valid, startDate }))
      .toThrow("SUBSCRIPTION_DATES_INVALID");
  });

  it("validates extension dates with the same calendar and timezone contract", () => {
    expect(() => parseManualSubscriptionInput({ action: "extend", expectedRevision: 2,
      reason: "Renewal confirmed", endDate: "2026-11-31T00:00:00.000Z" }))
      .toThrow("SUBSCRIPTION_DATES_INVALID");
  });

  it("accepts leap days and exact, timezone-qualified instants", () => {
    expect(parseManualSubscriptionInput({ ...valid,
      startDate: "2028-02-29T00:00:00.000Z", endDate: "2028-03-29T00:00:00.000Z",
    })).toMatchObject({ startDate: "2028-02-29T00:00:00.000Z", endDate: "2028-03-29T00:00:00.000Z" });
    expect(parseManualSubscriptionInput({ ...valid,
      startDate: "2026-10-01T03:00:00+03:00", endDate: "2026-11-01T03:00:00+03:00",
    })).toMatchObject({ startDate: "2026-10-01T03:00:00+03:00" });
  });
  it.each([
    ["2027-01-31T14:25:36.123Z", "monthly", "2027-02-28T14:25:36.123Z"],
    ["2028-01-31T14:25:36.123Z", "monthly", "2028-02-29T14:25:36.123Z"],
    ["2028-02-29T14:25:36.123Z", "yearly", "2029-02-28T14:25:36.123Z"],
    ["2026-10-29T14:25:36.123Z", "monthly", "2026-11-29T14:25:36.123Z"],
  ] as const)("calculates %s + %s using a UTC calendar term and preserves the approval clock", (start, term, end) => {
    expect(endOfCalendarTermUTC(new Date(start), term).toISOString()).toBe(end);
  });
    it("requires an explicit linked request for adjusted approvals",()=>{
    expect(() => parseManualSubscriptionInput({...valid,allowRequestChanges:true})).toThrow("SUBSCRIPTION_INVALID");
    expect(() => parseManualSubscriptionInput({...valid,requestId:"req_example",allowRequestChanges:"yes"})).toThrow("SUBSCRIPTION_INVALID");
    expect(parseManualSubscriptionInput({...valid,requestId:"req_example",allowRequestChanges:true})).toMatchObject({
      requestId:"req_example",allowRequestChanges:true,
    });
  });

});
