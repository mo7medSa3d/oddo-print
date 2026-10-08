/** A physical printer's usable horizontal dot budget, never browser CSS DPI. */
type Caps = Record<string, unknown> | null | undefined;
const widthRange = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 288 && n <= 576 ? n : null;
};
function dotsForPaper(mm: number, dpi: number | null): number | null {
  if (mm < 40 || mm > 82) return null;
  // Printer manufacturers use different printable margins, even on paper
  // with the same nominal roll width. Never assume 576 dots at 180dpi.
  if (mm <= 58) return dpi === 180 ? 360 : 384;
  if (mm >= 78) return dpi === 180 ? 512 : dpi === 203 ? 576 : 512;
  return null; // Ambiguous intermediate widths need explicit dot dimensions
}

/**
 * Prefer operator/device reported printable dots. Use nominal roll size
 * only for familiar 58/80mm media. Returning null is intentional: Odoo's
 * tested 512px base layout is the safe fallback, not a guessed hardware
 * width. The Agent independently bounds output by the configured backend.
 */
export function receiptRasterWidthDots(capabilities: Caps): number | null {
  if (!capabilities || typeof capabilities !== "object") return null;
  const explicit = widthRange(capabilities.max_paper_width);
  if (explicit !== null) return explicit;
  const dpi = Number(capabilities.print_dpi ?? capabilities.dpi);
  const knownDPI = dpi === 180 || dpi === 203 ? dpi : null;
  const declaredMM = Number(capabilities.paper_width_mm);
  if (Number.isFinite(declaredMM)) {
    const w = dotsForPaper(declaredMM, knownDPI);
    if (w !== null) return w;
  }
  const widths = capabilities.paper_widths;
  if (Array.isArray(widths) && widths.length) {
    const values = widths.map(v => Number(v)).filter(Number.isFinite);
    if (values.length !== widths.length) return null;
    const candidates = values.map(v => dotsForPaper(v, knownDPI));
    // Multiple possible rolls: lay out for the *narrowest* usable width.
    if (candidates.every((v): v is number => v !== null)) {
      return Math.min(...candidates);
    }
  }
  return null;
}
