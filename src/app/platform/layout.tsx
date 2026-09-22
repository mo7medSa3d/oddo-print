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

    fetch("/api/platform/auth/me", { credentials: "include", cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setAuthenticated(true);
        } else {
          router.replace("/platform/login");
        }
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isLoginPage, router]);

  if (isLoginPage) return <>{children}</>;

  async function handleLogout() {
    await fetch("/api/platform/auth/logout", { method: "POST" });
    router.push("/platform/login");
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
