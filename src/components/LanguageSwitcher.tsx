"use client";

import { Check, Globe2 } from "lucide-react";
import { useI18n } from "../i18n/react";
import { LOCALES, LOCALE_LABELS, type Locale } from "../i18n/config";
import { Menu } from "./ui";

export function LanguageSwitcher({
  align = "end",
  placement = "above",
  compact = true,
  className = "",
}: {
  align?: "start" | "end";
  placement?: "below" | "above";
  compact?: boolean;
  className?: string;
}) {
  const { t, locale, setLocale } = useI18n();

  const selectLocale = (next: Locale) => {
    if (next === locale) return;
    setLocale(next);
    window.dispatchEvent(new Event("yaseir:locale-navigation"));
  };

  const items = LOCALES.map((code: Locale) => ({
    key: `locale-${code}`,
    label: LOCALE_LABELS[code],
    icon: code === locale ? <Check className="h-4 w-4" aria-hidden /> : <Globe2 className="h-4 w-4" aria-hidden />,
    meta: code.toUpperCase(),
    disabled: code === locale,
    onSelect: () => selectLocale(code),
  }));
  const nextLocale = locale === "en" ? "ar" : "en";
  const mobileLabel = `${compact ? `${nextLocale.toUpperCase()} — ` : ""}${t("common.language")}: ${LOCALE_LABELS[nextLocale]}`;

  return (
    <div className={`inline-flex ${className}`}>
      {/*
        A direct one-tap switch on phones avoids rendering a portaled menu
        outside the mobile navigation dialog's focus/pointer boundary.
        Keep the existing accessible menu unchanged on larger viewports.
      */}
      <button
        type="button"
        data-mobile-language-toggle
        aria-label={mobileLabel}
        title={mobileLabel}
        onClick={() => selectLocale(nextLocale)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-sm px-2.5 py-2 text-xs font-[600] text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-[3px] lg:hidden"
      >
        <Globe2 className="h-4 w-4 shrink-0" aria-hidden />
        {compact && <span dir="ltr">{nextLocale.toUpperCase()}</span>}
      </button>
      <div className="hidden lg:inline-flex">
        <Menu
          label={t("common.language")}
          align={align}
          placement={placement}
          menuClassName="min-w-[160px]"
          trigger={
            <span
              className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-sm px-2.5 py-2 text-xs font-[600] text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
              title={t("common.language")}
            >
              <Globe2 className="h-4 w-4 shrink-0" aria-hidden />
              {compact && <span>{locale.toUpperCase()}</span>}{" "}
              <span className="sr-only">{LOCALE_LABELS[locale]}</span>
            </span>
          }
          items={items}
        />
      </div>
    </div>
  );
}
