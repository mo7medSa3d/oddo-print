import type { ReactNode } from "react";
import { BrandMark } from "./brand";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useI18n } from "../i18n/react";
import type { MessageKey } from "../i18n/messages/en";

const TRUST_POINT_KEYS: MessageKey[] = [
  "auth.shell.point1",
  "auth.shell.point2",
  "auth.shell.point3",
];

/**
 * Entrance surface shared by every unauthenticated route (console, platform,
 * verification, invitation). A quiet brand rail carries the promise; the form
 * column stays narrow, focused and free of chrome.
 */
export function AuthShell({
  children,
  subtitle,
  eyebrow,
  title,
  description,
  footer,
}: {
  children: ReactNode;
  subtitle?: string;
  eyebrow?: string;
  title?: string;
  description?: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const subtitleText = subtitle ?? t("auth.shell.console");
  return (
    <main className="ambient-surface relative flex min-h-screen flex-col">
      <div className="relative z-10 flex min-h-screen flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
        {/* Brand rail — desktop only; small screens get the mark above the form. */}
        <section className="relative hidden flex-col justify-between border-e border-edge-subtle bg-surface/40 px-10 py-12 lg:flex xl:px-14">
          <BrandMark size="lg" title="Yaseir" subtitle={t("brand.tagline")} />

          <div className="max-w-[46ch]">
            <p className="text-eyebrow">{t("auth.shell.heading")}</p>
            <h2 className="mt-3 text-3xl font-[640] leading-[1.15] tracking-[-0.026em] text-ink">
              {t("auth.shell.headline")}
            </h2>
            <p className="mt-4 text-base leading-relaxed text-ink-2">
              {t("auth.shell.body")}
            </p>
            <ul className="mt-8 space-y-3.5">
              {TRUST_POINT_KEYS.map((key) => (
                <li key={key} className="flex items-start gap-3 text-sm leading-relaxed text-ink-2">
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                  />
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-xs text-ink-4">
            © {new Date().getFullYear()} Yaseir · {subtitleText}
          </p>
        </section>

        {/* Form column */}
        <section className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full max-w-[420px]">
            <div className="mb-7 flex items-center justify-between gap-4 lg:hidden">
              <BrandMark size="md" title="Yaseir" subtitle={subtitleText} />
              <div className="flex items-center gap-1">
                <LanguageSwitcher />
                <ThemeToggle />
              </div>
            </div>

            {(eyebrow || title || description) && (
              <header className="mb-6">
                {eyebrow && <p className="text-eyebrow mb-2">{eyebrow}</p>}
                {title && (
                  <h1 className="text-3xl font-[640] leading-tight tracking-[-0.026em] text-ink">
                    {title}
                  </h1>
                )}
                {description && (
                  <p className="mt-2 text-base leading-relaxed text-ink-3">{description}</p>
                )}
              </header>
            )}

            {children}

            {footer && <div className="mt-6 text-center text-sm text-ink-3">{footer}</div>}
          </div>
        </section>
      </div>

      <div className="absolute end-4 top-4 z-20 hidden lg:flex items-center gap-1">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
    </main>
  );
}
