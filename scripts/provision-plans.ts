import { db } from "../src/db";
import { plans } from "../src/db/schema";

/* Provision the public plan catalog from operator-supplied Stripe Price IDs and canonical entitlement limits. */
const CANONICAL_ENTITLEMENTS = ["max_agents", "max_printers", "max_jobs_per_minute", "max_concurrent_jobs"] as const;
type EntitlementValue = number | "unlimited";

function normalizeEntitlements(input: Record<string, unknown>): Record<string, EntitlementValue> {
  const aliases: Record<string, string> = { maxAgents: "max_agents", maxPrinters: "max_printers", maxJobsPerMinute: "max_jobs_per_minute", maxConcurrentJobs: "max_concurrent_jobs" };
  const normalized: Record<string, EntitlementValue> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = aliases[rawKey] ?? rawKey;
    if (!CANONICAL_ENTITLEMENTS.includes(key as typeof CANONICAL_ENTITLEMENTS[number])) continue;
    if (rawValue === "unlimited") { normalized[key] = rawValue; continue; }
    if (typeof rawValue !== "number" || !Number.isSafeInteger(rawValue) || rawValue <= 0) throw new Error(`Entitlement ${key} must be a positive integer or "unlimited"`);
    normalized[key] = rawValue;
  }
  for (const key of CANONICAL_ENTITLEMENTS) {
    if (!(key in normalized)) throw new Error(`Each plan must define entitlement ${key} as a positive integer or "unlimited"`);
  }
  return normalized;
}

async function main() {
  const raw = process.env.STRIPE_PLAN_CATALOG;
  if (!raw) throw new Error("STRIPE_PLAN_CATALOG is required");
  const parsed = JSON.parse(raw) as Array<{ id: string; name: string; priceId: string; currency?: string; interval?: string; entitlements: Record<string, unknown> }>;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("STRIPE_PLAN_CATALOG must be a non-empty JSON array");
  for (const plan of parsed) {
    if (!plan?.id || !plan.name || !plan.priceId || !plan.entitlements || typeof plan.entitlements !== "object" || Array.isArray(plan.entitlements)) throw new Error("Each plan requires id, name, priceId and entitlements");
    const entitlements = normalizeEntitlements(plan.entitlements);
    await db.insert(plans).values({ id: plan.id, name: plan.name, stripePriceId: plan.priceId, currency: plan.currency ?? "usd", interval: plan.interval ?? "month", entitlements })
      .onConflictDoUpdate({ target: plans.id, set: { name: plan.name, stripePriceId: plan.priceId, currency: plan.currency ?? "usd", interval: plan.interval ?? "month", entitlements, updatedAt: new Date() } });
  }
  console.log(`Provisioned ${parsed.length} Stripe-backed plan(s).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
