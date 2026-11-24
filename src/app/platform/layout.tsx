"use client";

import { fetchWithTimeout } from "../../lib/fetch-timeout";
import { broadcastSessionSync, subscribeSessionSync, type SessionSyncEventType } from "../../lib/session-sync";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Building2, CreditCard, KeyRound, Shield, ListChecks } from "lucide-react";
import type { TopNavItem } from "../../components/TopNavbar";
import { PlatformSidebar } from "../../components/platform/PlatformSidebar";
import { PageContainer, PageSkeleton, ErrorState, Callout } from "../../components/ui";
import { useI18n } from "../../i18n/react";

// Grouped-sidebar model matching the Gateway shell (Operations,
// Administration): Overview and Odoo & credentials sit in the first
// group; the remaining license/subscription items form Administration.
const NAV_ITEMS: TopNavItem[] = [
 {href:"/platform/dashboard",labelKey:"v4.admin.overview",icon:Activity,sectionKey:"nav.section.operations"},
 {href:"/platform/integrations",labelKey:"v4.admin.integrations",icon:KeyRound,sectionKey:"nav.section.operations"},
 {href:"/platform/tenants",labelKey:"v4.admin.workspaces",icon:Building2,sectionKey:"nav.section.administration"},
 {href:"/platform/subscription-requests",labelKey:"v4.admin.requests",icon:ListChecks,sectionKey:"nav.section.administration"},
 {href:"/platform/subscriptions",labelKey:"v4.admin.subscriptions",icon:CreditCard,sectionKey:"nav.section.administration"},
 {href:"/platform/security",labelKey:"platform.section.security",icon:Shield,sectionKey:"nav.section.administration"},
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
  // Same shape as the workspace shell's remote sign-out: set once when
  // another tab reports a platform logout/revocation, renders the message,
  // and drives the delayed redirect. Never re-broadcast from here.
  const [remoteSignOut, setRemoteSignOut] = useState<{ type: SessionSyncEventType; next: string } | null>(null);
  const remoteSignOutRef = useRef(false);

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
      if (!cancelled) router.replace(`/platform/login?next=${encodeURIComponent(pathname)}`);
    }

    async function refreshSession() {
      // A remote sign-out already owns this tab's exit (interstitial +
      // delayed redirect); no local round may preempt it with an instant one.
      if (remoteSignOutRef.current) return Promise.resolve();
      // Single flight: one recovery at a time per tab (C062), and — where
      // Web Locks exist — one recovery at a time across tabs, mirroring
      // the workspace ensure path ("yaseir:customer-session"). Without the
      // lock, two tabs presenting the same refresh token in parallel can
      // race rotation; serialized, the second round still presents its own
      // token and the server's 5-second grace/revocation policy decides.
      if (flight) return flight;
      flight = (async () => {
        const refreshOnce = async () => {
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
              if (!remoteSignOutRef.current) redirectToLogin();
              return;
            }
            if (!refresh.ok) {
              setCheckFailed(true);
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
            // A successful revalidation in this tab proves the family alive
            // to siblings; they only clear stale error UI on this event,
            // never refresh because of it.
            broadcastSessionSync("session-renewed", "platform");
            const expMs = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
            scheduleRefresh(Number.isFinite(expMs) ? expMs : undefined);
          } catch {
            // Transport failure: retry, don't redirect (C062).
            if (cancelled) return;
            setCheckFailed(true);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              void refreshSession();
            }, 30_000);
          }
        };
        try {
          if (typeof navigator !== "undefined" && navigator.locks) {
            await navigator.locks.request("yaseir:platform-session", () => refreshOnce());
          } else {
            await refreshOnce();
          }
        } catch {
          // A lock failure (or an unexpected throw inside the round) is
          // transient, never a verdict: keep the session, retry soon.
          if (cancelled) return;
          setCheckFailed(true);
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
      if (remoteSignOutRef.current) return;
      try {
        const res = await fetchWithTimeout("/api/platform/auth/me", { credentials: "include", cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json().catch(() => null) as { exp?: unknown } | null;
          if (cancelled) return;
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

    // Focus revalidation mirrors visibility: a window refocus that does not
    // change visibility (OS/app switching, embed hosts) must still
    // revalidate instead of waiting for the next timer tick.
    function onFocus() {
      void initialCheck();
    }
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [isLoginPage, pathname, router, checkTick]);

  // Cross-tab session sync (platform scope only — workspace events never
  // reach this handler). A renewed event only clears a stale check-failed
  // state; it never triggers a refresh. A logged-out/revoked event shows
  // the sign-out message and follows to login shortly. Never broadcast
  // from this handler, so no echo loop is possible. The login page itself
  // does not subscribe: it has no session to lose.
  useEffect(() => {
    if (isLoginPage) return;
    return subscribeSessionSync("platform", (event) => {
      if (event.type === "session-renewed") {
        setCheckFailed(false);
        return;
      }
      if (remoteSignOutRef.current) return;
      remoteSignOutRef.current = true;
      setAuthenticated(false);
      setRemoteSignOut({ type: event.type, next: pathname });
    });
  }, [isLoginPage, pathname]);

  useEffect(() => {
    if (!remoteSignOut) return;
    const timer = setTimeout(() => {
      router.replace(`/platform/login?next=${encodeURIComponent(remoteSignOut.next)}`);
    }, 5000);
    return () => clearTimeout(timer);
  }, [remoteSignOut, router]);

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
    // Successful local logout only: sibling platform tabs follow to login
    // instead of discovering a dead family on their next check.
    broadcastSessionSync("session-logged-out", "platform");
    router.push("/");
    router.refresh();
  }

  if (remoteSignOut) {
    return (
      <div className="min-h-screen bg-app text-ink">
        <PageContainer className="pt-10">
          <div className="mx-auto max-w-lg">
            <Callout tone="warn" title={t(remoteSignOut.type === "session-revoked" ? "workspaceSecurity.sessionExpiredTitle" : "nav.signOut")}>
              {t(remoteSignOut.type === "session-logged-out" ? "workspaceSecurity.signedOutElsewhere" : "errors.sessionExpired")}
            </Callout>
            <p className="mt-4 text-sm">
              <a
                href={`/platform/login?next=${encodeURIComponent(remoteSignOut.next)}`}
                className="font-semibold text-brand underline underline-offset-4"
              >
                {t("workspaceSecurity.signIn")}
              </a>
            </p>
          </div>
        </PageContainer>
      </div>
    );
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
