"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { HeaderNav } from "./HeaderNav";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthScreen = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/invite"].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  const isPlatformScreen = pathname === "/platform" || pathname.startsWith("/platform/");

  if (isPlatformScreen) {
    return <main className="min-h-screen bg-slate-950 text-slate-100">{children}</main>;
  }

  if (isAuthScreen) {
    return <main className="min-h-screen">{children}</main>;
  }

  return (
    <div className="flex min-h-screen flex-col bg-app text-ink">
      <HeaderNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-edge bg-surface py-5 mt-auto">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-4 text-xs text-ink-3 sm:px-6">
          <p>© 2026 Print Gateway</p>
          <p>Enterprise print operations</p>
        </div>
      </footer>
    </div>
  );
}
