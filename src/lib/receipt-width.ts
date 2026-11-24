import { printerGeometryFromCapabilities } from "./printer-geometry";

/** A physical printer's usable horizontal dot budget, never browser CSS DPI. */
type Caps = Record<string, unknown> | null | undefined;

/** A selected roll, or one unambiguous advertised size; dots do not prove media size. */
export function receiptPaperWidthMM(capabilities: Caps): number | null {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  const asRoll = (value: unknown): number | null => {
    const n = typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 40 || n > 120) return null;
    return n;
  };
  const geometry = printerGeometryFromCapabilities(capabilities);
  if (geometry?.paper_width_mm !== undefined) return asRoll(geometry.paper_width_mm);
  const selected = capabilities.paper_width_mm;
  if (selected != null && !(typeof selected === "string" && selected.trim() === "")) return asRoll(selected);
  const widths = capabilities.paper_widths;
  return Array.isArray(widths) && widths.length === 1 ? asRoll(widths[0]) : null;
}

/**
 * Geometry provenance is mandatory. A nominal roll width, legacy width
 * label or familiar DPI does not prove the printer's printable dot budget.
 * Unknown stays null so callers can request a validated profile instead of
 * silently printing a guessed size. The Agent owns any deliberate legacy
 * profile migration and publishes its result through geometry v1.
 */
export function receiptRasterWidthDots(capabilities: Caps): number | null {
  return printerGeometryFromCapabilities(capabilities)?.printable_width_dots ?? null;
}
