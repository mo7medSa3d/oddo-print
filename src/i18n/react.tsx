"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
  formatRelativeTime: (value: Date | string | number | null | undefined, now?: number) => string;
  formatDurationMs: (value: number | null | undefined) => string;
  formatBytes: (value: number | null | undefined) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

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
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      /* storage unavailable — stay on the default locale */
    }
    const resolved = resolveLocale(stored);
    if (resolved !== initialLocale) setLocaleState(resolved);
  }, [initialLocale]);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = dirFor(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
      // One year, Lax: the server can read it on the next navigation without
      // ever sending it cross-site.
      document.cookie = `${LOCALE_COOKIE_KEY}=${next}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* storage unavailable — the choice still applies for this session */
    }
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
      formatRelativeTime: (v, now) => formatRelativeTime(v, locale, now),
      formatDurationMs: (v) => formatDurationMs(v, locale),
      formatBytes: (v) => formatBytes(v, locale),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

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
  const setLocale = context?.setLocale ?? (() => undefined);

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
