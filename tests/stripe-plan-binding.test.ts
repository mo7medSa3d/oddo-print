import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripePriceBindingError, validateStripePriceBinding } from "../src/lib/stripe";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.STRIPE_SECRET_KEY;

describe("Stripe plan binding contract", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_billing_contract";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecret;
    vi.restoreAllMocks();
  });

  it("accepts an active recurring Price whose billing identity matches the Yasser plan", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "price_business_monthly",
        object: "price",
        active: true,
        type: "recurring",
        currency: "usd",
        product: "prod_business",
        recurring: { interval: "month", interval_count: 1 },
      }), { status: 200 }),
    );

    await expect(validateStripePriceBinding({
      priceId: "price_business_monthly",
      currency: "usd",
      interval: "month",
      productId: "prod_business",
    })).resolves.toMatchObject({
      id: "price_business_monthly",
      active: true,
      type: "recurring",
      currency: "usd",
      interval: "month",
      productId: "prod_business",
    });
  });

  it("rejects a one-time Price from a recurring subscription plan", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "price_once",
        object: "price",
        active: true,
        type: "one_time",
        currency: "usd",
        product: "prod_business",
      }), { status: 200 }),
    );

    await expect(validateStripePriceBinding({
      priceId: "price_once",
      currency: "usd",
      interval: "month",
    })).rejects.toMatchObject({
      code: "STRIPE_PRICE_INVALID",
      status: 400,
    });
  });

  it("rejects inactive Prices when the Yasser plan is active", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: "price_inactive",
        object: "price",
        active: false,
        type: "recurring",
        currency: "usd",
        product: "prod_business",
        recurring: { interval: "month" },
      }), { status: 200 }),
    );

    await expect(validateStripePriceBinding({
      priceId: "price_inactive",
      currency: "usd",
      interval: "month",
      requireActive: true,
    })).rejects.toMatchObject({
      code: "STRIPE_PRICE_INVALID",
      status: 400,
    });
  });

  it("returns a service-level error when Stripe cannot be reached", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(validateStripePriceBinding({
      priceId: "price_network",
      currency: "usd",
      interval: "month",
    })).rejects.toBeInstanceOf(StripePriceBindingError);

    await expect(validateStripePriceBinding({
      priceId: "price_network_again",
      currency: "usd",
      interval: "month",
    })).rejects.toMatchObject({
      code: "STRIPE_UNAVAILABLE",
      status: 502,
    });
  });
});
