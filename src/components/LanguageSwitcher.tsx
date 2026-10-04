"use client";

import { Globe2 } from "lucide-react";
import { useI18n } from "../i18n/react";
import { LOCALES, LOCALE_LABELS, type Locale } from "../i18n/config";
import { Menu } from "./ui";

export function LanguageSwitcher({
  align = "end",
  placement = "below",
  compact = true,
  className = "",
}: {
  align?: "start" | "end";
  placement?: "below" | "above";
  compact?: boolean;
  className?: string;
}) {
  const { t, locale, setLocale } = useI18n();

  const items = LOCALES.map((code: Locale) => ({
    key: `locale-${code}`,
    label: LOCALE_LABELS[code],
    icon: <Globe2 className="h-4 w-4" aria-hidden />,
    meta: code === locale ? "✓" : undefined,
    disabled: code === locale,
    onSelect: () => { setLocale(code); window.dispatchEvent(new Event("yaseir:locale-navigation")); },
  }));

  return (
    <Menu
      label={t("common.language")}
      align={align}
      placement={placement}
      className={className}
      menuClassName="min-w-[160px]"
      trigger={
        <span
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-semibold text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none"
          title={t("common.language")}
        >
          <Globe2 className="h-4 w-4 shrink-0" aria-hidden />
          {compact && <span>{locale.toUpperCase()}</span>}
          <span className="sr-only">{LOCALE_LABELS[locale]}</span>
        </span>
      }
      items={items}
    />
  );
}
