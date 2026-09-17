import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Yasser — Cloud Printing Platform",
  description: "Yasser Cloud Printing Platform — Agent ↔ Gateway (WS) + Manager + Odoo Integration",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased bg-app text-ink min-h-screen">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
