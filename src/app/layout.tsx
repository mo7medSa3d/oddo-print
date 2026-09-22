import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Yasser — Cloud Print Operations",
  description: "Yasser connects Odoo 19 to physical printers through a durable queue, Windows Agent, and production print operations.",
};

// Pre-paint theme resolution: stored choice wins, otherwise follow the OS.
// Runs before the body renders so there is no light/dark flash.
const THEME_INIT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-app text-ink min-h-screen">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
