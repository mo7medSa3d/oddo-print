import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { AppShell } from "../components/AppShell";
import { I18nProvider } from "../i18n/react";
import { getServerLocale, makeT } from "../i18n/server";
import { dirFor } from "../i18n/config";
import "./globals.css";

// Bundle the OFL-licensed IBM Plex families with the app. next/font/google
// downloads CSS during builds; its remote response can fail inside Docker
// even when our own application code and test suites are healthy.
const ibmPlexSans = localFont({
  src: "./fonts/ibm-plex-sans-variable.ttf",
  weight: "100 700",
  style: "normal",
  variable: "--font-ibm-plex-sans",
  display: "swap",
});

const ibmPlexSansArabic = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-arabic-400.ttf", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-arabic-500.ttf", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-arabic-600.ttf", weight: "600", style: "normal" },
    { path: "./fonts/ibm-plex-sans-arabic-700.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-ibm-plex-sans-arabic",
  display: "swap",
  // Avoid preloading four Arabic weights on English pages; RTL still loads
  // its actual fonts automatically when the language-specific CSS applies.
  preload: false,
});


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
      className={`${ibmPlexSans.variable} ${ibmPlexSansArabic.variable}`}
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
