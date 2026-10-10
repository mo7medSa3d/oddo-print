"use client";

import { fetchWithTimeout } from "../../lib/fetch-timeout";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Building2, CreditCard, Tags, Shield } from "lucide-react";
import type { TopNavItem } from "../../components/TopNavbar";
import { PlatformSidebar } from "../../components/platform/PlatformSidebar";
import { PageContainer, PageSkeleton, ErrorState, Callout } from "../../components/ui";
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
  const [checkFailed, setCheckFailed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [checkTick, setCheckTick] = useState(0);

  const isLoginPage = pathname === "/platform/login";

  useEffect(() => {
    if (isLoginPage) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let flight: Promise<void> | null = null;

    // Refresh no later than a minute before the supplied expiry (bounded to
    // 13 minutes), never a fixed 13-minute wait that ignores it (C062).
    function scheduleRefresh(expiresAtMs?: number) {
      if (timer) clearTimeout(timer);
      const delay = expiresAtMs
        ? Math.min(Math.max(expiresAtMs - Date.now() - 60_000, 15_000), 13 * 60 * 1000)
        : 13 * 60 * 1000;
      timer = setTimeout(() => {
        void refreshSession();
      }, delay);
    }

    function redirectToLogin() {
      if (!cancelled) router.replace("/platform/login");
    }

    async function refreshSession() {
      // Single flight: one recovery at a time (C062).
      if (flight) return flight;
      flight = (async () => {
        try {
          const refresh = await fetchWithTimeout("/api/platform/auth/refresh", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
          });
          if (cancelled) return;
          if (refresh.status === 401) {
            // Authoritative: the family is invalid/revoked.
            setAuthenticated(false);
            redirectToLogin();
            return;
          }
          if (!refresh.ok) {
            // Transient: keep the session, retry soon — never sign out on a
            // blip, and never leave observation to a fixed timer (C062).
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              void refreshSession();
            }, 30_000);
            return;
          }
          const data = await refresh.json().catch(() => null) as { expiresAt?: unknown } | null;
          if (cancelled) return;
          setAuthenticated(true);
          setCheckFailed(false);
          const expMs = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
          scheduleRefresh(Number.isFinite(expMs) ? expMs : undefined);
        } catch {
          // Transport failure: retry, don't redirect (C062).
          if (cancelled) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refreshSession();
          }, 30_000);
        } finally {
          flight = null;
        }
      })();
      return flight;
    }

    async function initialCheck() {
      try {
        const res = await fetchWithTimeout("/api/platform/auth/me", { credentials: "include", cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json().catch(() => null) as { exp?: unknown } | null;
          setAuthenticated(true);
          const expMs = typeof data?.exp === "number" ? data.exp * 1000 : NaN;
          scheduleRefresh(Number.isFinite(expMs) ? expMs : undefined);
          return;
        }
        if (res.status === 401) {
          await refreshSession();
          return;
        }
        // Non-401 failure of the probe itself: retryable, not a verdict.
        setCheckFailed(true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (!cancelled) void initialCheck();
        }, 15_000);
      } catch {
        // Transport failure on first paint: show retry, not a permanent
        // "redirecting" skeleton that never redirects (C062).
        if (cancelled) return;
        setCheckFailed(true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (!cancelled) void initialCheck();
        }, 15_000);
      }
    }

    void initialCheck();

    // Reconcile suspension/rotation when the tab becomes visible (C062).
    function onVisible() {
      if (document.visibilityState === "visible") void initialCheck();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isLoginPage, router, checkTick]);

  if (isLoginPage) return <>{children}</>;

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const res = await fetchWithTimeout("/api/platform/auth/logout", { method: "POST", credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(t("platform.session.logoutFailed"));
    } catch {
      // Finite visible failure: stay signed in with an explanation instead
      // of a hang or a silent redirect (C062).
      setLogoutError(t("platform.session.logoutFailed"));
      setLoggingOut(false);
      return;
    }
    router.push("/");
    router.refresh();
  }

  if (authenticated === null || authenticated === false) {
    // authenticated === false only follows an authoritative 401 (a redirect
    // is already in flight). A failed transport check keeps retrying with a
    // visible retry action instead of a permanent skeleton (C062).
    if (authenticated === null && checkFailed) {
      return (
        <div className="min-h-screen bg-app text-ink">
          <PageContainer className="pt-10">
            <ErrorState
              title={t("platform.session.checkFailedTitle")}
              message={t("platform.session.checkFailedBody")}
              retry={() => { setCheckFailed(false); setCheckTick((tick) => tick + 1); }}
            />
          </PageContainer>
        </div>
      );
    }
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
    <PlatformSidebar items={NAV_ITEMS} onLogout={handleLogout} loggingOut={loggingOut}>
      {logoutError && (
        <PageContainer>
          <Callout tone="bad" title={logoutError}>
            <button
              type="button"
              className="inline-flex min-h-9 items-center rounded-sm px-2 font-[600] text-brand transition-colors hover:text-brand-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2"
              onClick={() => setLogoutError(null)}
            >
              {t("common.dismiss")}
            </button>
          </Callout>
        </PageContainer>
      )}
      <main className="page-transition min-w-0 max-w-full bg-app text-ink">
        <PageContainer>{children}</PageContainer>
      </main>
    </PlatformSidebar>
  );
}
