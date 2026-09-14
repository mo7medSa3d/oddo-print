import { db } from "../src/db";
import { plans } from "../src/db/schema";

/* Provision the public plan catalog from operator-supplied Stripe Price IDs and entitlements. */
async function main() {
  const raw = process.env.STRIPE_PLAN_CATALOG;
  if (!raw) throw new Error("STRIPE_PLAN_CATALOG is required");
  const parsed = JSON.parse(raw) as Array<{ id: string; name: string; priceId: string; currency?: string; interval?: string; entitlements: Record<string, number | boolean | string> }>;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("STRIPE_PLAN_CATALOG must be a non-empty JSON array");
  for (const plan of parsed) {
    if (!plan?.id || !plan.name || !plan.priceId || !plan.entitlements || typeof plan.entitlements !== "object") throw new Error("Each plan requires id, name, priceId and entitlements");
    await db.insert(plans).values({ id: plan.id, name: plan.name, stripePriceId: plan.priceId, currency: plan.currency ?? "usd", interval: plan.interval ?? "month", entitlements: plan.entitlements })
      .onConflictDoUpdate({ target: plans.id, set: { name: plan.name, stripePriceId: plan.priceId, currency: plan.currency ?? "usd", interval: plan.interval ?? "month", entitlements: plan.entitlements, updatedAt: new Date() } });
  }
  console.log(`Provisioned ${parsed.length} Stripe-backed plan(s).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
