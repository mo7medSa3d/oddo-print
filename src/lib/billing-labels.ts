import type { Translator } from "../i18n/translate";

/** Localized manual subscription term for customer & platform views. */
export function billingTermLabel(value: string | null | undefined, t: Translator): string {
  const key = (value ?? "").trim().toLowerCase();
  if (key === "yearly") return t("v4.onboarding.yearly");
  if (key === "custom") return t("v4.subscription.custom");
  if (key === "monthly") return t("v4.onboarding.monthly");
  return t("v4.subscription.notSet");
}
