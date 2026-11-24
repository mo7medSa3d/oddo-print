import { normalizePlanEntitlements } from "./entitlements";
import { parsePlanPriceAmount } from "./plan-price";
import { ManualSubscriptionError } from "./manual-subscriptions";

function parseOptionalLimit(val: unknown, fallback: number | "unlimited", maxVal: number): number | "unlimited" {
  if (val === undefined || val === null || val === "") return fallback;
  if (val === "unlimited") return "unlimited";
  if (typeof val === "number" && Number.isSafeInteger(val) && val >= 1 && val <= maxVal) return val;
  throw new ManualSubscriptionError("PLAN_INVALID");
}

export function parseManualPlan(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ManualSubscriptionError("PLAN_INVALID");
  const b = input as Record<string, unknown>;
  if (
    typeof b.id !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(b.id) ||
    typeof b.name !== "string" ||
    !b.name.trim() ||
    b.name.length > 120 ||
    typeof b.description !== "string" ||
    b.description.length > 500
  ) {
    throw new ManualSubscriptionError("PLAN_INVALID");
  }
  if ((b.isActive !== undefined && typeof b.isActive !== "boolean") || (b.isPublic !== undefined && typeof b.isPublic !== "boolean")) {
    throw new ManualSubscriptionError("PLAN_INVALID");
  }
  // monthlyQuota is informational in License-Only mode; default to unmetered (1_000_000) when omitted.
  const quota = b.monthlyQuota === undefined ? 1000000 : b.monthlyQuota;
  if (typeof quota !== "number" || !Number.isSafeInteger(quota) || quota < 1 || quota > 2147483647) {
    throw new ManualSubscriptionError("PLAN_INVALID");
  }
  const maxAgents = parseOptionalLimit(b.maxAgents, 5, 1000);
  const maxPrinters = parseOptionalLimit(b.maxPrinters, 15, 10000);
  const displayOrder = b.displayOrder === undefined ? 0 : b.displayOrder;
  if (typeof displayOrder !== "number" || !Number.isSafeInteger(displayOrder) || displayOrder < 0 || displayOrder > 1000000) {
    throw new ManualSubscriptionError("PLAN_INVALID");
  }
  let priceMinorUnits: number | null = null;
  let priceCurrency: "USD" | "SAR" | null = null;
  const amount = b.priceAmount ?? null;
  const currency = b.priceCurrency ?? null;
  if (amount !== null || currency !== null) {
    if (typeof amount !== "string" || (currency !== "USD" && currency !== "SAR")) throw new ManualSubscriptionError("PLAN_INVALID");
    const minorUnits = parsePlanPriceAmount(amount);
    if (minorUnits === null) throw new ManualSubscriptionError("PLAN_INVALID");
    priceMinorUnits = minorUnits;
    priceCurrency = currency;
  }
  return {
    id: b.id,
    name: b.name.trim(),
    description: b.description,
    priceMinorUnits,
    priceCurrency,
    displayOrder,
    isActive: b.isActive !== false,
    isPublic: b.isPublic !== false,
    entitlements: normalizePlanEntitlements({
      max_agents: maxAgents,
      max_printers: maxPrinters,
      max_prints_per_period: quota,
      max_jobs_per_minute: 120,
      max_concurrent_jobs: 100,
    }),
  };
}
