import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { validateStripePriceBinding } from "../src/lib/stripe";

const keys = ["YASEIR_HTTP_TEST_MODE", "STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY_FILE", "STRIPE_PLAN_CATALOG"] as const;
const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]])) as Record<typeof keys[number], string | undefined>;
const originalFetch = globalThis.fetch;

function configureTestPriceCatalog() {
  process.env.YASEIR_HTTP_TEST_MODE = "1";
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY_FILE;
  process.env.STRIPE_PLAN_CATALOG = JSON.stringify([
    { id: "http-test", priceId: "price_http_test_yasser", currency: "usd", interval: "month" },
    { id: "go", priceId: "price_go_yasser", currency: "usd", interval: "month" },
  ]);
}

afterEach(() => {
  for (const key of keys) {
    const value = prior[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("staging-only catalogued fake Stripe Price admission", () => {
  it("accepts the explicitly catalogued Go price without a network request", async () => {
    configureTestPriceCatalog();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Stripe must not be called in fake mode"));
    await expect(validateStripePriceBinding({
      priceId: "price_go_yasser", currency: "usd", interval: "month", requireActive: true,
    })).resolves.toMatchObject({ id: "price_go_yasser", active: true, productId: null });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects invented prices even when they look syntactically valid", async () => {
    configureTestPriceCatalog();
    await expect(validateStripePriceBinding({
      priceId: "price_unapproved_yasser", currency: "usd", interval: "month",
    })).rejects.toMatchObject({ code: "TEST_PRICE_NOT_IN_CATALOG", status: 400 });
  });

  it("rejects a catalogued price with an incompatible interval/currency", async () => {
    configureTestPriceCatalog();
    await expect(validateStripePriceBinding({
      priceId: "price_go_yasser", currency: "eur", interval: "month",
    })).rejects.toMatchObject({ code: "TEST_PRICE_NOT_IN_CATALOG", status: 400 });
    await expect(validateStripePriceBinding({
      priceId: "price_go_yasser", currency: "usd", interval: "year",
    })).rejects.toMatchObject({ code: "TEST_PRICE_NOT_IN_CATALOG", status: 400 });
  });

  it("does not accept fake price catalog entries when test mode is disabled", async () => {
    configureTestPriceCatalog();
    delete process.env.YASEIR_HTTP_TEST_MODE;
    await expect(validateStripePriceBinding({
      priceId: "price_go_yasser", currency: "usd", interval: "month",
    })).rejects.toMatchObject({ code: "STRIPE_NOT_CONFIGURED", status: 503 });
  });

  it("documents two stock prices and upgrades only the stock one-price staging catalog", () => {
    const setup = readFileSync("deploy/domain-test/setup-domain-test.sh", "utf8");
    const example = readFileSync("deploy/domain-test/.env.domain-test.example", "utf8");
    expect(setup).toContain("LEGACY_STAGING_PRICE_CATALOG=");
    expect(setup).toContain("DEFAULT_STAGING_PRICE_CATALOG=");
    expect(setup).toContain('if [[ "$(get_env_value STRIPE_PLAN_CATALOG "$ENV_FILE")" == "$LEGACY_STAGING_PRICE_CATALOG" ]]');
    expect(setup).toContain("upsert_env STRIPE_PLAN_CATALOG");
    for (const price of ["price_http_test_yasser", "price_go_yasser"]) {
      expect(setup).toContain(price);
      expect(example).toContain(price);
    }
  });
});
