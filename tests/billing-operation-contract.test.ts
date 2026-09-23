import { describe, expect, it } from "vitest";
import { stripeBillingMutation, type BillingOperation } from "../src/lib/billing-operation";

describe("billing operation Stripe mutation contract", () => {
  const base: BillingOperation = {
    type: "resume",
    missingSubscriptionError: "No Stripe subscription",
    stripeParams: new URLSearchParams({ cancel_at_period_end: "false" }),
    cancelAtPeriodEnd: false,
    logLabel: "resume",
  };

  it("uses Stripe's resume endpoint for paused subscriptions", () => {
    const mutation = stripeBillingMutation(base, "paused", "sub_paused_123");
    expect(mutation.path).toBe("subscriptions/sub_paused_123/resume");
    expect(mutation.params.toString()).toBe("");
  });

  it("uses the normal subscription update for cancellation reactivation", () => {
    const mutation = stripeBillingMutation(base, "active", "sub_active_123");
    expect(mutation.path).toBe("subscriptions/sub_active_123");
    expect(mutation.params.toString()).toBe("cancel_at_period_end=false");
  });
});
