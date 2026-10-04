import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { plans } from "../src/db/schema";
import { normalizePlanEntitlements } from "../src/lib/entitlements";
import { validateStripePriceBinding, lockStripePlanCatalog } from "../src/lib/stripe";

/* Provision the public plan catalog from operator-supplied Stripe Price IDs and canonical entitlement limits. */
async function main() {
  const raw = process.env.STRIPE_PLAN_CATALOG;
  if (!raw) throw new Error("STRIPE_PLAN_CATALOG is required");
  const parsed = JSON.parse(raw) as Array<{ id: string; name: string; priceId: string; currency?: string; interval?: string; entitlements: Record<string, unknown> }>;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("STRIPE_PLAN_CATALOG must be a non-empty JSON array");
  const httpTestMode = process.env.YASEIR_HTTP_TEST_MODE === "1";
  for (const plan of parsed) {
    if (!plan?.id || !plan.name || !plan.priceId || !plan.entitlements || typeof plan.entitlements !== "object" || Array.isArray(plan.entitlements)) throw new Error("Each plan requires id, name, priceId and entitlements");
    const entitlements = normalizePlanEntitlements(plan.entitlements);
    const currency = plan.currency ?? "usd";
    const interval = plan.interval ?? "month";
    const stripePrice = httpTestMode
      ? null
      : await validateStripePriceBinding({
          priceId: plan.priceId,
          currency,
          interval,
          requireActive: true,
        });
    await db.transaction(async tx => {
    await lockStripePlanCatalog(tx, plan.id, plan.priceId);
    const current = await tx.query.plans.findFirst({ where: eq(plans.id, plan.id), columns: { stripePriceHistory: true, stripePriceId: true } });
    const priceHistory = [...new Set([...(current?.stripePriceHistory ?? []), current?.stripePriceId, plan.priceId].filter((value): value is string => typeof value === "string" && !!value))];
    await tx.insert(plans).values({
      id: plan.id,
      name: plan.name,
      stripePriceId: plan.priceId,
      stripePriceHistory: priceHistory,
      currency,
      interval,
      entitlements,
      description: "",
      isActive: true,
      isPublic: true,
      displayOrder: 0,
      stripeProductId: stripePrice?.productId ?? null,
    })
      .onConflictDoUpdate({ target: plans.id, set: { name: plan.name, stripePriceId: plan.priceId, stripePriceHistory: priceHistory, currency: plan.currency ?? "usd", interval: plan.interval ?? "month", entitlements, updatedAt: sql`clock_timestamp()` } });
    });
  }
  console.log(`Provisioned ${parsed.length} Stripe-backed plan(s).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
