import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { AppShell } from "../components/AppShell";
import { CspStyleNonce } from "../components/CspStyleNonce";
import { I18nProvider } from "../i18n/react";
import { getServerLocale, makeT } from "../i18n/server";
import { LOCALE_COOKIE_KEY, LOCALE_STORAGE_KEY, dirFor } from "../i18n/config";
import "./globals.css";

// Gateway served typefaces (next/font/local, this origin only, no CDN).
// Thmanyah Sans is the primary face, served from this origin under the
// project's purchased Thmanyah licence (owner-held; licence document is
// not committed to the repo). The WOFF2 files in ./fonts/thmanyah are
// full conversions of the licensed OTFs (no subsetting; cmap verified
// identical — see scripts/check-thmanyah-coverage.py). OFL-licensed IBM
// Plex stays behind Thmanyah as the fallback if Thmanyah fails to load;
// its files are NOT deleted. next/font/google downloads CSS during
// builds; its remote response can fail inside Docker even when our own
// application code and test suites are healthy.
//
// The web ships WOFF2 (about two-thirds smaller than the OTF sources the
// Desktop app bundles). `display: "block"`: the files are served from this
// origin, so the face is available immediately, and a print-critical page
// must never be laid out with a fallback face whose line boxes differ from
// the real one.
// One Thmanyah variable leads both the Latin and the Arabic stack in
// globals.css: a single Thmanyah family carries both scripts, so unlike
// IBM Plex it needs no per-script variable. Preload stays on (the
// default): Thmanyah is the primary face in both languages, and a
// print-critical page must not render first in a fallback face.
const thmanyahSans = localFont({
  src: [
    { path: "./fonts/thmanyah/thmanyahsans-Light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Bold.woff2", weight: "700", style: "normal" },
    { path: "./fonts/thmanyah/thmanyahsans-Black.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-thmanyah",
  display: "block",
});

const ibmPlexSans = localFont({
  src: "./fonts/ibm-plex-sans-variable.woff2",
  weight: "100 700",
  style: "normal",
  variable: "--font-ibm-plex-sans",
  display: "block",
});

const ibmPlexSansArabic = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-arabic-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-arabic-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-arabic-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/ibm-plex-sans-arabic-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-ibm-plex-sans-arabic",
  display: "block",
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
// left-to-right layout. Interpolation uses only the shared build-time storage
// and cookie constants; no request input enters the script. Preference order: localStorage,
// then the locale cookie (cookie-only preference, e.g. cleared site data),
// then English.
const LOCALE_INIT = `(function(){try{var stored=null;try{stored=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)});}catch(e){}var locale=(stored==="ar"||stored==="en")?stored:null;if(!locale){var m=/(?:^|;\\s*)${LOCALE_COOKIE_KEY}=(ar|en)(?:;|$)/.exec(document.cookie||"");locale=m?m[1]:"en";}var root=document.documentElement;root.lang=locale;root.dir=(locale==="ar")?"rtl":"ltr";}catch(e){}})();`;

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
      className={`${thmanyahSans.variable} ${ibmPlexSans.variable} ${ibmPlexSansArabic.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased bg-app text-ink min-h-screen">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: LOCALE_INIT }} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <CspStyleNonce nonce={nonce} />
        <I18nProvider initialLocale={locale}>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
