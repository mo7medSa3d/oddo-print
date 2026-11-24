"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Callout } from "./ui";
import { useI18n } from "../i18n/react";
import { ensureCustomerSession } from "../lib/session-config";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { subscribeSessionSync } from "../lib/session-sync";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const WORKSPACE_ROUTES = ["/onboarding", "/dashboard", "/api-keys", "/team", "/billing", "/settings"];
type ActivityBudget = { lastSent: number | null };

/** Only explicit navigation to a known same-origin workspace UI is allowed. */
export function safeWorkspaceReturnPath(value: string | null, origin: string): string | null {
  if (!value || value.length > 4096 || value !== value.trim() || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (!["https:", "http:"].includes(base.protocol) || url.origin !== base.origin || url.username || url.password) return null;
    // Validate escapes as well as the URL parser's normalized path. Encoded
    // path separators must not turn a UI path into an API/auth destination.
    decodeURIComponent(url.pathname);
    if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)) return null;
    if (!WORKSPACE_ROUTES.some(route => url.pathname === route || url.pathname.startsWith(route + "/"))) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

/** A foreground input hint, never a background keepalive or fresh proof. */
export function observeWorkspaceActivity(
  target: Document,
  onExpired: () => void,
  now: () => number = () => performance.now(),
  budget: ActivityBudget = { lastSent: null },
): () => void {
  let disposed = false;
  let expired = false;
  let flight: AbortController | null = null;
  // One activity round: ensure a live access token, post the heartbeat, and
  // — only if that post still answers 401 — ensure once more and retry the
  // post exactly once. A refresh never extends idle time (only this POST
  // touches last_seen_at), so ensuring first cannot keep an idle session
  // alive: a session already past 30 minutes of no trusted input still fails
  // the ensure and is reported expired, honestly, without a retry storm.
  const postActivity = async (controller: AbortController): Promise<number> => {
    const response = await fetchWithTimeout("/api/auth/activity", {
      method: "POST", credentials: "same-origin", mode: "same-origin", cache: "no-store",
      redirect: "error", signal: controller.signal,
    }, 10_000);
    return response.status;
  };
  const onActivity = (event: Event) => {
    if (disposed || expired || !event.isTrusted || target.visibilityState !== "visible" || flight) return;
    const at = now();
    if (budget.lastSent !== null && at - budget.lastSent < 60_000) return;
    const controller = new AbortController();
    flight = controller;
    const aborted = () => disposed || controller.signal.aborted;
    void (async () => {
      try {
        // Recoverable heartbeat, step 1: an expired access token is the
        // common case (15-minute cycle vs. the shell timer), not expiry.
        let session;
        try {
          session = await ensureCustomerSession();
        } catch {
          // Transient probe/refresh failure: an outage does not establish
          // expiry. Leave the budget untouched so the next trusted input
          // retries instead of waiting out the 60-second window.
          return;
        }
        if (aborted()) return;
        if (!session.authenticated) {
          expired = true;
          onExpired();
          return;
        }
        budget.lastSent = at;
        let status: number | null;
        try {
          status = await postActivity(controller);
        } catch {
          // An outage does not establish expiry; elapsed time alone never
          // sends a call, and the next trusted input retries after the
          // throttle window.
          return;
        }
        if (aborted() || status !== 401) return;
        // Recoverable heartbeat, step 2: the token may have expired between
        // the ensure and the post (or a sibling tab rotated it). Ensure
        // once more and retry the post exactly once before calling expiry.
        try {
          session = await ensureCustomerSession();
        } catch {
          return;
        }
        if (aborted()) return;
        if (!session.authenticated) {
          expired = true;
          onExpired();
          return;
        }
        try {
          status = await postActivity(controller);
        } catch {
          return;
        }
        if (!aborted() && status === 401) {
          expired = true;
          onExpired();
        }
      } finally {
        if (flight === controller) flight = null;
      }
    })();
  };
  for (const type of ACTIVITY_EVENTS) target.addEventListener(type, onActivity, { passive: true });
  return () => {
    disposed = true;
    flight?.abort();
    for (const type of ACTIVITY_EVENTS) target.removeEventListener(type, onActivity);
  };
}


/** Mounted only inside the authenticated workspace shell.
 * No-step-up: this notice reports only genuine session expiry (from the
 * activity heartbeat or cross-tab sync). It never asks for a password and
 * never links to a confirmation flow; expiry goes to sign-in. */
export function WorkspaceSecurityNotice() {
  const { t } = useI18n();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const expire = () => setExpired(true);
    const budget: ActivityBudget = { lastSent: null };
    const stopActivity = observeWorkspaceActivity(document, expire, undefined, budget);
    // Cross-tab sync, workspace scope only. A renewed event only clears a
    // STALE expired callout (the family proved alive in another tab); it
    // never triggers a refresh here. A logged-out/revoked event surfaces
    // the same expired callout the heartbeat would show; the shell also
    // redirects. This handler never broadcasts, so no echo loop is possible.
    const unsubscribeSync = subscribeSessionSync("workspace", event => {
      if (event.type === "session-renewed") {
        setExpired(current => current ? false : current);
      } else {
        expire();
      }
    });
    return () => {
      stopActivity();
      unsubscribeSync();
    };
  }, []);
  if (!expired) return null;
  return <div className="px-4 pt-4 sm:px-6">
    <div data-testid="workspace-session-expired-notice">
      <Callout tone="bad" title={t("workspaceSecurity.sessionExpiredTitle")}
        action={<Link href="/login?next=%2Fsettings" prefetch={false} className="rounded-sm font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("workspaceSecurity.signIn")}</Link>}>
        {t("errors.sessionExpired")}
      </Callout>
    </div>
  </div>;
}
