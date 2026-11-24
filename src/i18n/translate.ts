import { DEFAULT_LOCALE, type Locale } from "./config";
import { en, type MessageKey } from "./messages/en";
import { ar } from "./messages/ar";

export type { MessageKey };

export const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ar };

/** Variables interpolated into `{name}` placeholders inside a message. */
export type MessageVars = Record<string, string | number>;

/**
 * A bound translator.
 *
 * Module-scope helpers cannot call `useI18n()`, and calling `t()` from module
 * scope would freeze the first locale forever. Those helpers take one of these
 * instead, so the caller decides the language.
 */
export type Translator = (key: MessageKey, vars?: MessageVars) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Resolve one key.
 *
 * Arabic never falls back to an English sentence or an internal message key.
 * Catalog completeness is a release gate; the localized unavailable label is
 * a defensive runtime boundary for unexpected or missing keys.
 */
export function translate(locale: Locale, key: MessageKey, vars?: MessageVars): string {
  const catalog = Object.prototype.hasOwnProperty.call(catalogs, locale) ? catalogs[locale] : en;
  const candidate = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
  // Unknown dynamic keys are a catalog-contract failure, not user copy.
  // Never surface an internal dotted key in English or Arabic.
  const template = typeof candidate === "string" && candidate.trim()
    ? candidate
    : locale === "ar" ? "النص غير متاح" : "Text unavailable";
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Count-aware translation.
 *
 * Arabic has six plural categories, so a single `{count}` string cannot carry
 * both languages. Callers store one message per category
 * (`job.attempts.one`, `job.attempts.few`, `job.attempts.many`, …) and this
 * picks the right one with `Intl.PluralRules`, falling back to `other`, then to
 * the bare key.
 */
export function translateCount(locale: Locale, baseKey: string, count: number, vars?: MessageVars): string {
  const merged: MessageVars = { count, ...(vars ?? {}) };
  let category = "other";
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    category = count === 1 ? "one" : "other";
  }
  // `zero`/`two`/`few`/`many` are locale-specific; `other` always exists.
  for (const candidate of [`${baseKey}.${category}`, `${baseKey}.other`, baseKey]) {
    if (Object.prototype.hasOwnProperty.call(en, candidate)) return translate(locale, candidate as MessageKey, merged);
  }
  return translate(locale, baseKey as MessageKey, merged);
}


export { DEFAULT_LOCALE };
