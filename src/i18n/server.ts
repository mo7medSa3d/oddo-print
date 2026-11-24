/**
 * Server-side locale resolution.
 *
 * The console has pages that render on the server (they read cookies and query
 * the database directly). Those cannot call `useI18n()` — it is a client hook —
 * but they still have to render translated text and locale-aware dates.
 *
 * The provider writes the chosen language to a cookie, so a server render picks
 * it up on the next navigation. Server-only locale helpers must not be exported from browser-safe i18n modules;
 * importing `next/headers` from shared desktop code would break Vite.
 */
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE_KEY, resolveLocale, type Locale } from "./config";
import { translate, type MessageVars } from "./translate";
import type { MessageKey } from "./messages/en";

export async function getServerLocale(): Promise<Locale> {
  try {
    const store = await cookies();
    return resolveLocale(store.get(LOCALE_COOKIE_KEY)?.value);
  } catch {
    // Outside a request scope (build-time prerender, scripts) fall back to
    // English rather than failing the render.
    return DEFAULT_LOCALE;
  }
}

/** Bound translator for server components: `const t = makeT(locale)`. */
export function makeT(locale: Locale) {
  return (key: MessageKey, vars?: MessageVars): string => translate(locale, key, vars);
}
