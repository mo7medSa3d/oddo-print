import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Yasser — Cloud Print Operations",
  description: "Yasser connects Odoo 19 to physical printers through a durable queue, Windows Agent, and production print operations.",
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
