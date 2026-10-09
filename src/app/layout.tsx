import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { AppShell } from "../components/AppShell";
import { I18nProvider } from "../i18n/react";
import { getServerLocale, makeT } from "../i18n/server";
import { dirFor } from "../i18n/config";
import "./globals.css";

// Avoid build-time network requests for Google Fonts. The design system uses
// platform-installed font families with Arabic-capable fallbacks until vetted
// self-hosted font assets are checked into this repository.

export async function generateMetadata(): Promise<Metadata> {
  const t = makeT(await getServerLocale());
  return {
    title: t("meta.title"),
    description: t("meta.description"),
  };
}

// Pre-paint locale resolution: the stored language decides `lang` and `dir`
// before the first frame, so a right-to-left session never flashes a
// left-to-right layout. Deliberately free of interpolation — the CSP nonce is
// the only dynamic part of the document head. Preference order: localStorage,
// then the locale cookie (cookie-only preference, e.g. cleared site data),
// then English.
const LOCALE_INIT = `(function(){try{var stored=null;try{stored=localStorage.getItem("yaseir:locale");}catch(e){}var locale=(stored==="ar"||stored==="en")?stored:null;if(!locale){var m=/(?:^|;\\s*)yaseir_locale=(ar|en)/.exec(document.cookie||"");locale=m?m[1]:"en";}var root=document.documentElement;root.lang=locale;root.dir=(locale==="ar")?"rtl":"ltr";}catch(e){}})();`;

// Pre-paint theme resolution: stored choice wins, otherwise follow the OS.
// Runs before the body renders so there is no light/dark flash.
const THEME_INIT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.setAttribute("data-theme","light");document.documentElement.style.colorScheme="light";}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // Resolve the language on the server so the first byte is already in the
  // operator's language. The pre-paint script below still owns the final word
  // (it reads the same cookie plus localStorage, which the server cannot see),
  // and `suppressHydrationWarning` covers the case where the two disagree.
  const locale = await getServerLocale();

  return (
    <html
      lang={locale}
      dir={dirFor(locale)}
      suppressHydrationWarning
    >
      <body className="antialiased bg-app text-ink min-h-screen">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: LOCALE_INIT }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <I18nProvider initialLocale={locale}>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
