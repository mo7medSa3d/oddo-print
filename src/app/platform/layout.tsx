"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Building2, CreditCard, Tags, Shield } from "lucide-react";
import { TopNavbar, type TopNavItem } from "../../components/TopNavbar";

const NAV_ITEMS: TopNavItem[] = [
  { href: "/platform/dashboard", label: "Overview", icon: Activity },
  { href: "/platform/tenants", label: "Tenants", icon: Building2 },
  { href: "/platform/subscriptions", label: "Subscriptions", icon: CreditCard },
  { href: "/platform/plans", label: "Plans", icon: Tags },
  { href: "/platform/audit", label: "Audit", icon: Shield },
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
      <div className="min-h-screen bg-[#080a12]" aria-busy="true">
        <span className="sr-only">Checking session…</span>
      </div>
    );
  }

  if (authenticated === false) {
    return (
      <div className="min-h-screen bg-[#080a12]" aria-busy="true">
        <span className="sr-only">Redirecting to sign in…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080a12] text-slate-100 font-sans selection:bg-indigo-500/20">
      <TopNavbar
        items={NAV_ITEMS}
        brandHref="/platform/dashboard"
        brandTitle="Yasser"
        brandSubtitle="Control Plane"
        onLogout={handleLogout}
        variant="platform"
      />
      <main className="min-h-screen bg-[#080a12]">
        <div className="mx-auto w-full max-w-[1800px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>
    </div>
  );
}
