import { intlLocale, type Locale } from '../i18n/config';
import { parseDbTimeMs } from './database-timestamp';
/** Contract dates use UTC calendar days; quota reset instants are displayed separately with time. */
export function formatManualCalendarDate(value: Date | string | number | null | undefined, locale: Locale): string | null {
  // Native <input type="date"> values have no timezone. Treat their exact
  // YYYY-MM-DD calendar day as midnight UTC, never host-local time.
  let normalized = value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const iso = value + 'T00:00:00.000Z';
    const parsed = new Date(iso);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) return null;
    normalized = iso;
  }
  const ms = typeof normalized === 'number' ? normalized : parseDbTimeMs(normalized);
  if (ms == null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(intlLocale(locale), {dateStyle:'medium',timeZone:'UTC'}).format(date).replaceAll("\u200f", "");
}
