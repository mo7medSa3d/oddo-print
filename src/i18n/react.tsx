"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_KEY,
  LOCALE_STORAGE_KEY,
  dirFor,
  resolveLocale,
  type Locale,
} from "./config";
import { translate, translateCount, type MessageKey, type MessageVars } from "./translate";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatRelativeTime,
  formatTime,
} from "./format";

export type I18nValue = {
  locale: Locale;
  dir: "ltr" | "rtl";
  setLocale: (locale: Locale) => void;
  /** Translate one key. */
  t: (key: MessageKey, vars?: MessageVars) => string;
  /** Translate a count-aware key (`key.one` / `key.few` / `key.other` …). */
  tc: (baseKey: string, count: number, vars?: MessageVars) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDate: (value: Date | string | number | null | undefined) => string;
  formatDateTime: (value: Date | string | number | null | undefined) => string;
  formatTime: (value: Date | string | number | null | undefined) => string;
  formatRelativeTime: (value: Date | string | number | null | undefined, now?: number) => string;
  formatDurationMs: (value: number | null | undefined) => string;
  formatBytes: (value: number | null | undefined) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

/* --------------------------------------------------------------------------
 * Stored-preference store.
 *
 * The active locale lives in localStorage, which is an external system React
 * cannot read during the server render. `useSyncExternalStore` is the
 * supported way to subscribe to one: the server snapshot is null, so hydration
 * renders the server's locale, and React adopts the stored value in the same
 * post-hydration pass instead of waiting for an effect.
 *
 * This replaces reading storage inside an effect and calling setState there,
 * which forced an extra render on every mount (and was rejected by
 * `react-hooks/set-state-in-effect`). It also makes a preference change in one
 * tab propagate to the others.
 * ------------------------------------------------------------------------ */
const listeners = new Set<() => void>();

/**
 * Cache keyed on the raw stored value. `getSnapshot` must return a stable
 * result between calls or React re-renders forever, so the read is memoised
 * rather than hitting storage on every render.
 */
let cachedRaw: string | null | undefined;
let cachedLocale: Locale | null = null;
/** Fallback for when storage is unavailable (private mode, blocked cookies). */
let sessionLocale: Locale | null = null;

function readStoredLocale(): Locale {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    /* storage unavailable — fall through to the session fallback */
  }
  if (raw === null && sessionLocale) return sessionLocale;
  if (raw === cachedRaw && cachedLocale) return cachedLocale;
  cachedRaw = raw;
  cachedLocale = resolveLocale(raw);
  return cachedLocale;
}

function emitLocaleChange() {
  cachedRaw = undefined;
  cachedLocale = null;
  for (const listener of listeners) listener();
}

function subscribeToLocale(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    // Another tab changed the preference; a null key means the store was cleared.
    if (event.key === null || event.key === LOCALE_STORAGE_KEY) emitLocaleChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Server snapshot: no stored preference is readable yet. */
const noStoredLocale = () => null;

/**
 * Locale provider.
 *
 * Starts on the default locale so the server and the first client render agree
 * (the pre-paint script in `src/app/layout.tsx` has already corrected `lang`
 * and `dir` from storage before paint, exactly like the theme), then adopts the
 * stored preference after mount. Changing the language updates the document
 * element, so CSS logical properties, `dir="rtl"` selectors and the browser's
 * own form controls all follow in one place.
 */
export function I18nProvider({ children, initialLocale = DEFAULT_LOCALE }: { children: ReactNode; initialLocale?: Locale }) {
  // `null` during the hydration pass only; the stored preference afterwards.
  // Server and client both start from `initialLocale`, so hydration matches
  // even when the two disagree with storage, and React adopts the stored value
  // in the same pass instead of via a follow-up effect.
  const storedLocale = useSyncExternalStore(subscribeToLocale, readStoredLocale, noStoredLocale);
  const locale = storedLocale ?? initialLocale;
  // False until the stored preference has been read. The pre-paint script in
  // the document head has already set `lang`/`dir` from the same storage key,
  // so nothing may write to the document element before this flips — doing so
  // would undo the script and show one left-to-right frame to an Arabic user.
  const resolved = storedLocale !== null;

  useEffect(() => {
    if (!resolved) return;
    const root = document.documentElement;
    root.lang = locale;
    root.dir = dirFor(locale);
  }, [locale, resolved]);

  const setLocale = useCallback((next: Locale) => {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      // One year, Lax: the server can read it on the next navigation without
      // ever sending it cross-site.
      document.cookie = `${LOCALE_COOKIE_KEY}=${next}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      // Storage unavailable — remember it for this session so the choice still
      // applies instead of snapping back on the next read.
      sessionLocale = next;
    }
    emitLocaleChange();
  }, []);

  const value = useMemo<I18nValue>(() => {
    const t = (key: MessageKey, vars?: MessageVars) => translate(locale, key, vars);
    return {
      locale,
      dir: dirFor(locale),
      setLocale,
      t,
      tc: (baseKey: string, count: number, vars?: MessageVars) => translateCount(locale, baseKey, count, vars),
      formatNumber: (v, options) => formatNumber(v, locale, options),
      formatDate: (v) => formatDate(v, locale),
      formatDateTime: (v) => formatDateTime(v, locale),
      formatTime: (v) => formatTime(v, locale),
      formatRelativeTime: (v, now) => formatRelativeTime(v, locale, now),
      formatDurationMs: (v) => formatDurationMs(v, locale),
      formatBytes: (v) => formatBytes(v, locale),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Stable no-op for callers that render outside a provider. */
const noopSetLocale = () => undefined;

/**
 * Access the active locale.
 *
 * Falls back to a fully functional English value instead of throwing: pages
 * that have not been migrated yet (or that render outside the provider in the
 * desktop bundle) keep working instead of blanking out.
 */
export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  const locale = context?.locale ?? DEFAULT_LOCALE;
  const setLocale = context?.setLocale ?? noopSetLocale;

  return useMemo<I18nValue>(() => {
    const t = (key: MessageKey, vars?: MessageVars) => translate(locale, key, vars);
    return {
      locale,
      dir: dirFor(locale),
      setLocale,
      t,
      tc: (baseKey: string, count: number, vars?: MessageVars) => translateCount(locale, baseKey, count, vars),
      formatNumber: (v, options) => formatNumber(v, locale, options),
      formatDate: (v) => formatDate(v, locale),
      formatDateTime: (v) => formatDateTime(v, locale),
      formatTime: (v) => formatTime(v, locale),
      formatRelativeTime: (v, now) => formatRelativeTime(v, locale, now),
      formatDurationMs: (v) => formatDurationMs(v, locale),
      formatBytes: (v) => formatBytes(v, locale),
    };
  }, [context, locale, setLocale]);
}

/** Convenience hook for components that only need `t`. */
export function useT() {
  return useI18n().t;
}
