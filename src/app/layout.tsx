import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { AppShell } from "../components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Yasser — Cloud Printing Platform",
  description: "Automated Odoo printing for receipts, invoices, labels, and reports across branches, stores, and warehouses.",
};

// Pre-paint theme resolution: stored choice wins, otherwise follow the OS.
// Runs before the body renders so there is no light/dark flash.
const THEME_INIT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.setAttribute("data-theme",t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.setAttribute("data-theme","light");document.documentElement.style.colorScheme="light";}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-app text-ink min-h-screen">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
