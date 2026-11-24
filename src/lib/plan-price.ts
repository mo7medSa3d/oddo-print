import { intlLocale, type Locale } from "../i18n/config";

export type PlanCurrency = "USD" | "SAR";
export type BillingTerm = "monthly" | "yearly";

/** Annual billing applies a consistent 20% discount across UI and API payloads. */
export const ANNUAL_DISCOUNT_PERCENT = 20;

export type ComputedTermPricing = {
  term: BillingTerm;
  currency: PlanCurrency;
  monthlyMinorUnits: number;
  effectiveMonthlyMinorUnits: number;
  billedAmountMinorUnits: number;
  yearlyUndiscountedMinorUnits: number;
  yearlySavingsMinorUnits: number;
  discountPercent: number;
};

export type UnifiedPlanRecord = {
  id: string;
  name: string;
  description: string | null;
  priceMinorUnits: number | null;
  priceCurrency: string | null;
  entitlements: Record<string, unknown>;
  isFallback?: boolean;
};

/**
 * Default 3-tier reference catalog inferred from `manual-plans.ts` defaults
 * (`maxAgents: 5`, `maxPrinters: 15`, `monthlyQuota: 1_000_000` unmetered in
 * License-Only mode). Used only when the database catalog has no published plans.
 */
export const DEFAULT_THREE_PLANS: readonly UnifiedPlanRecord[] = [
  {
    id: "starter",
    name: "Starter",
    description: "Single-branch direct Odoo printing with local Agent licensing.",
    priceMinorUnits: 2900,
    priceCurrency: "USD",
    entitlements: {
      max_agents: 2,
      max_printers: 5,
      max_prints_per_period: 1_000_000,
    },
    isFallback: true,
  },
  {
    id: "business",
    name: "Business",
    description: "Multi-branch operations matching standard Gateway capacity defaults.",
    priceMinorUnits: 7900,
    priceCurrency: "USD",
    entitlements: {
      max_agents: 5,
      max_printers: 15,
      max_prints_per_period: 1_000_000,
    },
    isFallback: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    description: "Custom multi-site licensing, unlimited Agents, and dedicated SLA.",
    priceMinorUnits: null,
    priceCurrency: null,
    entitlements: {
      max_agents: "unlimited",
      max_printers: "unlimited",
      max_prints_per_period: 1_000_000,
    },
    isFallback: true,
  },
];

/**
 * Normalizes the plan catalog to up to 3 tiers for the unified pricing/billing
 * view. When the database returns published plans, displays up to the first 3
 * ordered tiers; when empty, falls back to `DEFAULT_THREE_PLANS`.
 */
export function resolveThreePlanCatalog(
  rows: readonly UnifiedPlanRecord[],
): { plans: UnifiedPlanRecord[]; usingFallback: boolean } {
  if (rows.length > 0) {
    return { plans: rows.slice(0, 3).map(row => ({ ...row, isFallback: false })), usingFallback: false };
  }
  return { plans: DEFAULT_THREE_PLANS.map(plan => ({ ...plan })), usingFallback: true };
}

/** Shared catalog input contract for the Platform Owner form and backend.
 * No floating-point rounding, exponential notation or silent truncation. */
export function parsePlanPriceAmount(amount: string): number | null {
  if (typeof amount !== "string") return null;
  const matched = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,2}))?$/.exec(amount);
  if (!matched) return null;
  const minorUnits = Number(matched[1]) * 100 + Number((matched[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minorUnits) && minorUnits <= 2_147_483_647 ? minorUnits : null;
}

/**
 * Computes consistent monthly/yearly pricing in minor units using integer-scaled
 * math to avoid binary floating-point drift on the 20% annual discount.
 */
export function computePlanTermPricing(
  monthlyMinorUnits: number | null | undefined,
  currency: string | null | undefined,
  term: BillingTerm,
): ComputedTermPricing | null {
  if (monthlyMinorUnits == null || !Number.isSafeInteger(monthlyMinorUnits) || monthlyMinorUnits < 0) return null;
  if (currency !== "USD" && currency !== "SAR") return null;
  if (term !== "monthly" && term !== "yearly") return null;

  const yearlyUndiscountedMinorUnits = monthlyMinorUnits * 12;
  if (!Number.isSafeInteger(yearlyUndiscountedMinorUnits)) return null;

  if (monthlyMinorUnits === 0) {
    return {
      term,
      currency,
      monthlyMinorUnits: 0,
      effectiveMonthlyMinorUnits: 0,
      billedAmountMinorUnits: 0,
      yearlyUndiscountedMinorUnits: 0,
      yearlySavingsMinorUnits: 0,
      discountPercent: 0,
    };
  }

  const keepPercent = 100 - ANNUAL_DISCOUNT_PERCENT;
  const yearlyTotalMinorUnits = Math.round((yearlyUndiscountedMinorUnits * keepPercent) / 100);
  const effectiveMonthlyMinorUnits = term === "yearly"
    ? Math.round((monthlyMinorUnits * keepPercent) / 100)
    : monthlyMinorUnits;

  return {
    term,
    currency,
    monthlyMinorUnits,
    effectiveMonthlyMinorUnits,
    billedAmountMinorUnits: term === "yearly" ? yearlyTotalMinorUnits : monthlyMinorUnits,
    yearlyUndiscountedMinorUnits,
    yearlySavingsMinorUnits: yearlyUndiscountedMinorUnits - yearlyTotalMinorUnits,
    discountPercent: term === "yearly" ? ANNUAL_DISCOUNT_PERCENT : 0,
  };
}

/** A configured catalog price is descriptive, not proof of a paid invoice. */
export function formatPlanPrice(
  minorUnits: number | null | undefined,
  currency: string | null | undefined,
  locale: Locale,
): string | null {
  if (minorUnits == null || !Number.isSafeInteger(minorUnits) || minorUnits < 0) return null;
  if (currency !== "USD" && currency !== "SAR") return null;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(minorUnits / 100);
}

/**
 * Pricing cards keep the amount and ISO currency code on separate visual tiers.
 * The LTR amount + code pair is stable in Arabic while decimal separators stay
 * locale-aware. Do not append a monthly term: plan prices are not billing cycles.
 */
export function formatPlanPriceDisplay(
  minorUnits: number | null | undefined,
  currency: string | null | undefined,
  locale: Locale,
): { amount: string; currency: PlanCurrency } | null {
  if (minorUnits == null || !Number.isSafeInteger(minorUnits) || minorUnits < 0) return null;
  if (currency !== "USD" && currency !== "SAR") return null;
  return {
    amount: new Intl.NumberFormat(intlLocale(locale), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(minorUnits / 100),
    currency,
  };
}

/** Formats effective monthly, billed total, and annual savings for a given term. */
export function formatPlanTermPriceDisplay(
  monthlyMinorUnits: number | null | undefined,
  currency: string | null | undefined,
  term: BillingTerm,
  locale: Locale,
): {
  effectiveMonthly: { amount: string; currency: PlanCurrency };
  billedTotal: { amount: string; currency: PlanCurrency };
  yearlySavings: { amount: string; currency: PlanCurrency } | null;
  discountPercent: number;
  computed: ComputedTermPricing;
} | null {
  const computed = computePlanTermPricing(monthlyMinorUnits, currency, term);
  if (!computed) return null;
  const effectiveMonthly = formatPlanPriceDisplay(computed.effectiveMonthlyMinorUnits, computed.currency, locale);
  const billedTotal = formatPlanPriceDisplay(computed.billedAmountMinorUnits, computed.currency, locale);
  if (!effectiveMonthly || !billedTotal) return null;
  const yearlySavings = computed.yearlySavingsMinorUnits > 0
    ? formatPlanPriceDisplay(computed.yearlySavingsMinorUnits, computed.currency, locale)
    : null;
  return {
    effectiveMonthly,
    billedTotal,
    yearlySavings,
    discountPercent: computed.discountPercent,
    computed,
  };
}

export type WorkspaceSubscriptionLifecycleStatus =
  | "awaiting_activation"
  | "active"
  | "expired"
  | "suspended";

export type PlanEligibilityReason =
  | "ok"
  | "already_active"
  | "already_on_yearly"
  | "pending_same_request"
  | "pending_other_request";

export type PlanEligibilityAction =
  | "subscribe"
  | "switch_plan"
  | "upgrade_to_yearly"
  | "renew"
  | "blocked";

export type PlanEligibility = {
  allowed: boolean;
  action: PlanEligibilityAction;
  reason: PlanEligibilityReason;
  isCurrentPlan: boolean;
};

/**
 * Single source of truth for workspace plan/term subscription eligibility,
 * shared between the unified Billing UI cards, manual request form, and
 * POST /api/subscription-requests.
 */
export function evaluatePlanChangeEligibility(input: {
  status: WorkspaceSubscriptionLifecycleStatus;
  currentPlanId?: string | null;
  currentTerm?: string | null;
  targetPlanId: string;
  targetTerm: BillingTerm;
  expiringSoon?: boolean;
  pendingRequest?: { planId: string; term: string } | null;
}): PlanEligibility {
  const isCurrentPlan = Boolean(input.currentPlanId && input.currentPlanId === input.targetPlanId);

  if (input.pendingRequest) {
    const isSamePending =
      input.pendingRequest.planId === input.targetPlanId &&
      input.pendingRequest.term === input.targetTerm;
    return {
      allowed: false,
      action: "blocked",
      reason: isSamePending ? "pending_same_request" : "pending_other_request",
      isCurrentPlan,
    };
  }

  if (input.status === "active" && isCurrentPlan) {
    if (input.currentTerm === "monthly" && input.targetTerm === "yearly") {
      return {
        allowed: true,
        action: "upgrade_to_yearly",
        reason: "ok",
        isCurrentPlan: true,
      };
    }
    if (input.currentTerm === "yearly" && input.targetTerm === "monthly") {
      return {
        allowed: false,
        action: "blocked",
        reason: "already_on_yearly",
        isCurrentPlan: true,
      };
    }
    if (input.expiringSoon) {
      return {
        allowed: true,
        action: "renew",
        reason: "ok",
        isCurrentPlan: true,
      };
    }
    return {
      allowed: false,
      action: "blocked",
      reason: "already_active",
      isCurrentPlan: true,
    };
  }

  if (input.status === "active") {
    return {
      allowed: true,
      action: "switch_plan",
      reason: "ok",
      isCurrentPlan: false,
    };
  }

  return {
    allowed: true,
    action: "subscribe",
    reason: "ok",
    isCurrentPlan,
  };
}
