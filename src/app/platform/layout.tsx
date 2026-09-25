"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Building2, CreditCard, Tags, Shield } from "lucide-react";
import { TopNavbar, type TopNavItem } from "../../components/TopNavbar";

const NAV_ITEMS: TopNavItem[] = [
  { href: "/platform/dashboard", label: "Overview", icon: Activity, section: "Operations" },
  { href: "/platform/tenants", label: "Tenants", icon: Building2, section: "Operations" },
  { href: "/platform/subscriptions", label: "Subscriptions", icon: CreditCard, section: "Commerce" },
  { href: "/platform/plans", label: "Plans", icon: Tags, section: "Commerce" },
  { href: "/platform/audit", label: "Audit", icon: Shield, section: "Security" },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  const isLoginPage = pathname === "/platform/login";

  useEffect(() => {
    if (isLoginPage) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function scheduleRefresh() {
      timer = setTimeout(() => {
        void refreshSession();
      }, 13 * 60 * 1000);
    }

    async function refreshSession() {
      try {
        const refresh = await fetch("/api/platform/auth/refresh", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });
        if (!refresh.ok) {
          if (!cancelled) router.replace("/platform/login");
          return;
        }
        const data = await refresh.json().catch(() => null) as { expiresAt?: unknown } | null;
        if (!cancelled && typeof data?.expiresAt === "string") {
          setAuthenticated(true);
          scheduleRefresh();
        }
      } catch {
        if (!cancelled) router.replace("/platform/login");
      }
    }

    fetch("/api/platform/auth/me", { credentials: "include", cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json().catch(() => null) as { exp?: unknown } | null;
          setAuthenticated(true);
          if (typeof data?.exp === "number") {
            scheduleRefresh(new Date(data.exp * 1000).toISOString());
          }
          return;
        }
        await refreshSession();
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isLoginPage, router]);

  if (isLoginPage) return <>{children}</>;

  async function handleLogout() {
    await fetch("/api/platform/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-app" aria-busy="true">
        <span className="sr-only">Checking session…</span>
      </div>
    );
  }

  if (authenticated === false) {
    return (
      <div className="min-h-screen bg-app" aria-busy="true">
        <span className="sr-only">Redirecting to sign in…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-app text-ink font-sans selection:bg-brand/20">
      <TopNavbar
        items={NAV_ITEMS}
        brandHref="/platform/dashboard"
        brandTitle="Yasser"
        brandSubtitle="Control Plane"
        onLogout={handleLogout}
        variant="platform"
      />
      <main className="min-h-[calc(100vh-56px)] bg-app text-ink">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9">{children}</div>
      </main>
    </div>
  );
}
