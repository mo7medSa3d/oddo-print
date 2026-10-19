import type { MessageKey } from "../i18n/messages/en";

/** Only stable codes (not English server error strings) decide translated UI feedback. */
export function platformPlanMutationErrorKey(status: number, payload: unknown): MessageKey {
  const code = payload && typeof payload === "object" && !Array.isArray(payload)
    && typeof (payload as { code?: unknown }).code === "string"
    ? (payload as { code: string }).code
    : "";

  if (status === 400) {
    if (code === "TEST_PRICE_NOT_IN_CATALOG") return "platform.plans.error.testPriceNotCatalogued";
    if (code === "STRIPE_PRICE_INVALID") return "platform.plans.error.invalidStripePrice";
    return "platform.plans.error.invalidFields";
  }
  if (status === 409) {
    if (code === "PLAN_EXISTS") return "platform.plans.error.exists";
    if (code === "PLAN_CHANGED_RETRY") return "platform.plans.error.changed";
    return "platform.plans.error.conflict";
  }
  if (status === 401 || status === 403) return "platform.plans.error.unauthorized";
  if (status === 503 && code === "STRIPE_NOT_CONFIGURED") return "platform.plans.error.stripeNotConfigured";
  if ((status === 502 || status === 503) && code === "STRIPE_UNAVAILABLE") return "platform.plans.error.stripeUnavailable";
  // 500/network failure has an unknown commit outcome; the old fallback
  // intentionally asks the operator to refresh before retrying.
  return "platform.plans.saveFailed";
}
