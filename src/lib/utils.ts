import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A leading `<prefix>_` namespace, e.g. `printer_`, `agt_`, `job_`, `usr_`.
 */
const ID_PREFIX = /^[a-z]+_/i;

/**
 * Shorten a prefixed identifier for display in dense tables.
 *
 * Identifiers in this system are `<prefix>_<nanoid>` (`printer_9xK2mQ1a`,
 * `agt_4bTz…`, `job_…`). Slicing the raw identifier to 8 characters therefore
 * renders only the *constant* prefix — literally `printer_` for every row —
 * which identifies nothing and is what users saw cut off in the UI. Strip the
 * prefix first so the displayed fragment is the part that actually
 * distinguishes one row from another.
 *
 * Returns an em dash for missing identifiers so table cells stay aligned
 * instead of collapsing to empty space.
 */
export function shortId(id: string | null | undefined, size: number = 8): string {
  if (!id) return "—";
  const body = ID_PREFIX.test(id) ? id.slice(id.indexOf("_") + 1) : id;
  return body ? body.slice(0, size) : "—";
}
