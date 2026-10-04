/**
 * Normalize a database timestamp (Date from typed drizzle rows, or the naive
 * UTC string produced by node-postgres identity parsers on raw `db.execute()`
 * rows) to epoch milliseconds without host-TZ dependence. Returns null for
 * absent/unparseable input. Single shared implementation — do not copy.
 */
export function parseDbTimeMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const text = value.trim();
  if (!text) return null;
  let iso = text.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso += /[+-]\d{2}$/.test(iso) ? ":00" : "Z";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

