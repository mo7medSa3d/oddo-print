/**
 * Localization entry point.
 *
 * One import surface for the whole product (Next console, Vite desktop):
 *   import { useI18n } from "../../i18n/react"; // always a relative path
 */
export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE_KEY,
  LOCALE_LABELS,
  LOCALE_STORAGE_KEY,
  dirFor,
  intlLocale,
  isLocale,
  resolveLocale,
  type Locale,
} from "./config";

export { translate, translateCount, isKnownKey, type MessageVars } from "./translate";
export type { MessageKey } from "./messages/en";

export {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatRelativeTime,
} from "./format";

export { I18nProvider, useI18n, useT, type I18nValue } from "./react";
