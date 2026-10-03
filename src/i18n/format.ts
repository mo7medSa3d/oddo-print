import { intlLocale, type Locale } from "./config";
import { en, type MessageKey } from "./messages/en";
import { translate, translateCount } from "./translate";

/**
 * Locale-aware formatting.
 *
 * Two rules govern this module:
 *
 * 1. Human values (dates, counts, durations) follow the reader's locale.
 * 2. Technical values (printer ids, job ids, IP addresses, ports, API keys,
 *    URLs, checksums) are never transformed. They are identifiers, not prose:
 *    reordering or re-shaping them makes them unrecognisable and impossible to
 *    search for in logs.
 */

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const text = value.trim();
  if (!text) return null;
  // node-postgres emits naive "YYYY-MM-DD HH:MM:SS" in UTC; `new Date(str)`
  // would read those as host-local time.
  let iso = text.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(intlLocale(locale), options).format(value);
  } catch {
    return String(value);
  }
}

export function formatDate(value: Date | string | number | null | undefined, locale: Locale): string {
  const date = toDate(value);
  if (!date) return translate(locale, "common.notAvailable");
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium" }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatDateTime(value: Date | string | number | null | undefined, locale: Locale): string {
  const date = toDate(value);
  if (!date) return translate(locale, "common.notAvailable");
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatTime(value: Date | string | number | null | undefined, locale: Locale): string {
  const date = toDate(value);
  if (!date) return translate(locale, "common.notAvailable");
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), { timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Compact relative time ("3m ago" / "قبل ٣ دقائق").
 *
 * Built on `Intl.RelativeTimeFormat` so the unit words and their order are the
 * locale's own, with a fallback for runtimes without full ICU data.
 */
export function formatRelativeTime(
  value: Date | string | number | null | undefined,
  locale: Locale,
  now: number = Date.now(),
): string {
  const date = toDate(value);
  if (!date) return translate(locale, "common.never");

  const diffSec = Math.floor((now - date.getTime()) / 1000);
  if (diffSec < 0) return translate(locale, "time.justNow");
  if (diffSec < 45) return translate(locale, "time.justNow");

  // `key` is a plural BASE key (e.g. "time.minutesAgo"), not a leaf
    // MessageKey: translateCount appends the plural category itself, so
    // the base is deliberately a plain string.
    const rel = (amount: number, unit: Intl.RelativeTimeFormatUnit, key: string) => {
    try {
      return new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" }).format(-amount, unit);
    } catch {
      return translateCount(locale, key, amount);
    }
  };

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return rel(diffMin, "minute", "time.minutesAgo");
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return rel(diffHours, "hour", "time.hoursAgo");
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return rel(diffDays, "day", "time.daysAgo");
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return rel(diffMonths, "month", "time.monthsAgo");
  return formatDate(date, locale);
}

/**
 * Duration in the shortest form that is still honest ("4s", "2m 10s", "3h").
 * Used for print latency, so precision matters more than prose.
 */
export function formatDurationMs(ms: number | null | undefined, locale: Locale): string {
  if (ms == null || !Number.isFinite(ms)) return translate(locale, "common.notAvailable");
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return translateCount(locale, "time.secondsShort", totalSec);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) {
    return seconds === 0
      ? translateCount(locale, "time.minutesShort", minutes)
      : translate(locale, "time.minutesSecondsShort", { minutes: formatNumber(minutes, locale), seconds: formatNumber(seconds, locale) });
  }
  const hours = Math.floor(minutes / 60);
  return translateCount(locale, "time.hoursShort", hours);
}

/** Byte sizes for payload inspection. */
export function formatBytes(bytes: number | null | undefined, locale: Locale): string {
  if (bytes == null || !Number.isFinite(bytes)) return translate(locale, "common.notAvailable");
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

/** Every key currently available (used by the catalog parity test). */
export function allKeys(): MessageKey[] {
  return Object.keys(en) as MessageKey[];
}
