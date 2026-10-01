import { DEFAULT_LOCALE, type Locale } from "./config";
import { en, type MessageKey } from "./messages/en";
import { ar } from "./messages/ar";

export type { MessageKey };

export const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ar };

/** Variables interpolated into `{name}` placeholders inside a message. */
export type MessageVars = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Resolve one key.
 *
 * Fallback order is locale → English → the key itself. A missing Arabic string
 * must never render a raw `printer.status.offline` in front of a customer, and
 * it must never throw: the console keeps working while a translation lands.
 */
export function translate(locale: Locale, key: MessageKey, vars?: MessageVars): string {
  const template = catalogs[locale]?.[key] ?? en[key] ?? key;
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
    if (candidate in en) return translate(locale, candidate as MessageKey, merged);
  }
  return translate(locale, baseKey as MessageKey, merged);
}

/** Escape hatch for strings that live outside the catalog (server error text). */
export function isKnownKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export { DEFAULT_LOCALE };
