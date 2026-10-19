/**
 * Locale configuration — the single place that knows which languages the
 * product ships and how they are written.
 *
 * Deliberately dependency-free: the product must not pull an i18n framework
 * for two locales and a direction flag, and the same module has to work in the
 * Next.js console, the Vite desktop bundle and plain Node scripts.
 */

export const LOCALES = ["en", "ar"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Browser storage key — mirrors the theme key convention (`yaseir:theme`). */
export const LOCALE_STORAGE_KEY = "yaseir:locale";

/** Server-readable cookie so a future SSR pass can render the right `dir`. */
export const LOCALE_COOKIE_KEY = "yaseir_locale";

/**
 * Language names are always written in their own language: an Arabic speaker
 * scanning a language picker looks for "العربية", never "Arabic".
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Writing direction per locale. `ar` is RTL. */
export function dirFor(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * BCP-47 tag handed to `Intl`.
 *
 * `ar` is Modern Standard Arabic, which is what business software uses across
 * regions. Numbers stay on Latin digits (`latn`) because every identifier in
 * this product — printer ids, job ids, IP addresses, ports — is Latin, and
 * switching the numeral system mid-table makes those values hard to scan and
 * to copy.
 */
export function intlLocale(locale: Locale): string {
  return locale === "ar" ? "ar-u-nu-latn" : "en";
}

/** Normalizes anything (cookie, header, stored value) into a supported locale. */
export function resolveLocale(value: unknown): Locale {
  if (isLocale(value)) return value;
  if (typeof value === "string") {
    const base = value.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
