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
          // Presentation-only redirect: every /api/platform route independently
          // enforces the platform-owner session, so hiding chrome here never
          // weakens authorization. Keeps expired/reconnect sessions from
          // staring at an erroring chrome-less control plane.
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

  // Brief session-resolution state: render nothing so the control plane never
  // flashes privileged chrome before proving the session.
  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-[var(--platform-bg)]" aria-busy="true">
        <span className="sr-only">Checking session…</span>
      </div>
    );
  }

  if (authenticated === false) {
    return (
      <div className="min-h-screen bg-[#0d1016]" aria-busy="true">
        <span className="sr-only">Redirecting to sign in…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f1218] text-slate-100 font-sans selection:bg-brand-500/20">
      <TopNavbar
        items={NAV_ITEMS}
        brandHref="/platform/dashboard"
        brandTitle="Yasser"
        brandSubtitle="Control Plane"
        onLogout={handleLogout}
        variant="platform"
      />
      <main className="min-h-screen bg-[#0d1016]">
        <div className="mx-auto w-full max-w-[1440px] px-5 py-7 sm:px-7 lg:px-8 lg:py-9">{children}</div>
      </main>
    </div>
  );
}
