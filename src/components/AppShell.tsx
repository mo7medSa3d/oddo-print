"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  KeyRound,
  Users,
  CreditCard,
  Settings,
} from "lucide-react";
import { TopNavbar, type TopNavItem } from "./TopNavbar";

const NAV_ITEMS: TopNavItem[] = [
  { href: "/dashboard", label: "Console", icon: LayoutDashboard, section: "Workspace" },
  { href: "/api-keys", label: "API Keys", icon: KeyRound, section: "Integration" },
  { href: "/team", label: "Team", icon: Users, section: "Administration" },
  { href: "/billing", label: "Billing", icon: CreditCard, section: "Administration" },
  { href: "/settings", label: "Settings", icon: Settings, section: "Administration" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const isAuthScreen = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/invite"].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  const isPlatformScreen = pathname === "/platform" || pathname.startsWith("/platform/");
  // Public marketing/informational pages render server-side for anonymous
  // visitors (they read auth from cookies themselves) and must never be
  // bounced to /login.
  const isPublicScreen = pathname === "/" || pathname.startsWith("/pricing");

  useEffect(() => {
    if (isPlatformScreen || isAuthScreen || isPublicScreen) return;
    let cancelled = false;
    fetch("/api/auth/me", { method: "GET", credentials: "include", cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setAuthenticated(true);
        } else {
          // The shell is a presentation boundary, never an authorization
          // boundary: the console API routes would reject these requests
          // regardless (validateManager + per-route permissions). Redirecting
          // here only stops the user from staring at a chrome-less page whose
          // contents fail with 401s. Auth/public/platform screens are never
          // captured as a return destination to prevent redirect loops.
          const dest = encodeURIComponent(pathname);
          router.replace(`/login?next=${dest}`);
        }
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pathname, isPlatformScreen, isAuthScreen, isPublicScreen, router]);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", cache: "no-store" });
    } finally {
      router.replace("/login");
      router.refresh();
      setLoggingOut(false);
    }
  }

  // Platform control plane keeps its own layout (src/app/platform/layout.tsx).
  if (isPlatformScreen) {
    return <main className="min-h-screen bg-[#080a12] text-slate-100">{children}</main>;
  }

  // Auth screens render their own centered card — no shell chrome.
  if (isAuthScreen) {
    return <main className="min-h-screen bg-app">{children}</main>;
  }

  // Authenticated console: compact horizontal top navbar + full-width content.
  if (authenticated === true) {
    return (
      <div className="min-h-screen bg-app text-ink">
        <TopNavbar
          items={NAV_ITEMS}
          brandHref="/"
          brandTitle="Yasser"
          brandSubtitle="Cloud printing"
          onLogout={handleLogout}
          loggingOut={loggingOut}
          variant="console"
        />
        <main className="min-h-screen page-transition">{children}</main>
      </div>
    );
  }

  // Marketing home / pricing, and the brief loading state while the session
  // check resolves, render without navigation chrome.
  return <main className="min-h-screen bg-app text-ink">{children}</main>;
}
