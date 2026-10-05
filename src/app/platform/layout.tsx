"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Building2, CreditCard, Tags, Shield } from "lucide-react";
import { TopNavbar, type TopNavItem } from "../../components/TopNavbar";
import { PageContainer, PageSkeleton } from "../../components/ui";
import { useI18n } from "../../i18n/react";

const NAV_ITEMS: TopNavItem[] = [
  { href: "/platform/dashboard", labelKey: "platform.nav.overview", icon: Activity, sectionKey: "platform.section.operations", keywords: "overview dashboard platform" },
  { href: "/platform/tenants", labelKey: "platform.nav.tenants", icon: Building2, sectionKey: "platform.section.operations", keywords: "tenants customers workspaces" },
  { href: "/platform/subscriptions", labelKey: "platform.nav.subscriptions", icon: CreditCard, sectionKey: "platform.section.commerce", keywords: "subscriptions billing invoices" },
  { href: "/platform/plans", labelKey: "platform.nav.plans", icon: Tags, sectionKey: "platform.section.commerce", keywords: "plans pricing tiers" },
  { href: "/platform/audit", labelKey: "platform.nav.audit", icon: Shield, sectionKey: "platform.section.security", keywords: "audit trail logs security" },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
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
            scheduleRefresh();
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

  if (authenticated === null || authenticated === false) {
    const label = authenticated === null ? t("platform.session.checking") : t("platform.session.redirecting");
    return (
      <div className="min-h-screen bg-app text-ink" aria-busy="true" aria-label={label}>
        <PageContainer className="pt-10">
          <PageSkeleton />
          <span className="sr-only">{label}</span>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-app text-ink font-sans selection:bg-brand/20">
      <TopNavbar
        items={NAV_ITEMS}
        brandHref="/platform/dashboard"
        brandTitle="Yaseir"
        brandSubtitle={t("platform.brand.controlPlane")}
        onLogout={handleLogout}
        variant="platform"
      />
      <main className="page-transition min-h-[calc(100vh-56px)] bg-app text-ink">
        <PageContainer>{children}</PageContainer>
      </main>
    </div>
  );
}
