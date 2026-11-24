import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { translate } from "../i18n/translate";

/** Localize known product document types; preserve user-defined document names. */
export function documentTypeLabel(value: unknown, locale: Locale = DEFAULT_LOCALE): string {
  if (typeof value !== "string" || !value.trim()) return translate(locale, "desktop.job.document");
  const normalized = value.trim().toLowerCase().replace(/[_ -]+/g, " ");
  const keys = {
    receipt: "v4.experience.document.receipt",
    "kitchen ticket": "v4.experience.document.kitchen",
    invoice: "v4.experience.document.invoice",
    "invoice a4": "v4.experience.document.invoiceA4",
    label: "v4.experience.document.label",
    "label 4x6": "v4.experience.document.label4x6",
  } as const;
  const key = Object.prototype.hasOwnProperty.call(keys, normalized)
    ? keys[normalized as keyof typeof keys] : undefined;
  return key ? translate(locale, key) : value;
}
