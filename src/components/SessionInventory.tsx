"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardHeader, ErrorState, Skeleton } from "./ui";
import { useI18n } from "../i18n/react";
import { fetchWithTimeout, fetchWithSessionRetry } from "../lib/fetch-timeout";
import { useRouter } from "next/navigation";
import { SESSION_REVOCATION_EVENT } from "../lib/session-events";

type Session = { id: string; kind: "customer" | "manager" | "platform"; tenantId: string | null; tenantName: string | null;
  current: boolean; createdAt: string; lastRefreshedAt: string; expiresAt: string;
  ipAddress: string | null; userAgent: string | null };
type Page = { sessions: Session[]; truncated: boolean; nextCursor: string | null };
type Action = "revoke" | "revoke_others" | "revoke_all";

/**
 * WP-A (S2): best-effort client-side user-agent parsing into short device
 * words ("Chrome on Windows", "Safari on iPhone"). No server change, no
 * new data collection. Returns null when nothing recognizable is present;
 * the caller falls back to the existing `security.unknownDevice` key, so
 * no new i18n string is needed. Browser/OS names are proper nouns and are
 * intentionally left untranslated. Order matters: Edge, Opera and Samsung
 * Internet UAs also contain a Chrome token, and Chrome UAs contain a
 * Safari token, so the more specific tokens are checked first.
 */
export function parseDeviceLabel(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.slice(0, 1024);
  const browser =
    /EdgA?\/|Edge\//.test(ua) ? "Edge"
    : /OPR\/|Opera Mini|Opera\//.test(ua) ? "Opera"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /CriOS\//.test(ua) ? "Chrome"
    : /FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|Chromium\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Version\/[^ ]+.*Safari\//.test(ua) ? "Safari"
    : null;
  const os =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `${os} device`;
  return null;
}

export function SessionInventory({ platform = false, canRevoke = true }: { platform?: boolean; canRevoke?: boolean }) {
  const router = useRouter();
  const { t, formatDate } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [confirmAll, setConfirmAll] = useState(false);
  const generation = useRef(0);
  const currentRead = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const actionInFlight = useRef(false);
  const mounted = useRef(false);
  const endpoint = platform ? "/api/platform/auth/sessions" : "/api/auth/sessions";
  const redirectToSignIn = useCallback(() => {
    const next = window.location.pathname + window.location.search + window.location.hash;
    router.replace(`${platform ? "/platform/login" : "/login"}?next=${encodeURIComponent(next)}`);
  }, [platform, router]);
  // Workspace inventory uses the session-retry wrapper; the platform
  // variant keeps plain fetchWithTimeout because ensureCustomerSession
  // refreshes workspace cookies only and must never be applied to the
  // platform session kind.
  const inventoryFetch = useCallback((input: RequestInfo | URL, init: RequestInit): Promise<Response> =>
    platform ? fetchWithTimeout(input, init) : fetchWithSessionRetry(input, init), [platform]);
  const load = useCallback(async (cursor: string | null, signal: AbortSignal): Promise<Page> => {
    // Read: safe to retry once after refresh (workspace only).
    const response = await inventoryFetch(endpoint + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), {
      credentials: "include", cache: "no-store", signal,
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !signal.aborted) redirectToSignIn();
      throw new Error(t("security.sessionsFailed"));
    }
    if (!Array.isArray(body.sessions) || body.sessions.length > 100) throw new Error(t("security.sessionsFailed"));
    return body as Page;
  }, [endpoint, redirectToSignIn, t, inventoryFetch]);
  const readPage = useCallback(async (cursor: string | null, number: number, controller: AbortController, ownGeneration: number) => {
    try {
      const body = await load(cursor, controller.signal);
      if (!mounted.current || controller.signal.aborted || generation.current !== ownGeneration) return;
      // Pagination replaces the current page: the renderer retains at most
      // 100 device records, even for an account with a long session history.
      setSessions(body.sessions); setNextCursor(body.nextCursor); setPageNumber(number);
    } catch (err) {
      if (mounted.current && !controller.signal.aborted && generation.current === ownGeneration) {
        // Do not keep outdated revocation targets or a stale pagination cursor
        // after the authoritative session inventory read fails.
        setSessions([]);
        setNextCursor(null);
        setPageNumber(1);
        setConfirmAll(false);
        setError(t("security.sessionsFailed"));
      }
    } finally {
      if (mounted.current && generation.current === ownGeneration) setLoading(false);
    }
  }, [load, t]);
  const showPage = useCallback((cursor: string | null, number: number) => {
    currentRead.current?.abort();
    const controller = new AbortController(); currentRead.current = controller;
    const ownGeneration = ++generation.current;
    setLoading(true); setError("");
    return readPage(cursor, number, controller, ownGeneration);
  }, [readPage]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); currentRead.current = controller;
    const ownGeneration = ++generation.current;
    // Initial loading is already state=true. Only the asynchronous response
    // updates render state; effect replay still cancels the obsolete read.
    void readPage(null, 1, controller, ownGeneration);
    return () => {
      mounted.current = false; generation.current += 1;
      currentRead.current?.abort(); actionController.current?.abort();
    };
  }, [readPage, showPage]);
  async function revoke(action: Action, id?: string) {
    if (actionInFlight.current || !canRevoke || (action === "revoke_all" && !confirmAll)) return;
    actionInFlight.current = true; setBusy(true); setError("");
    currentRead.current?.abort(); generation.current += 1; setLoading(false);
    const controller = new AbortController(); actionController.current = controller;
    try {
      // Auto-retry (workspace only): session revocation is idempotent by
      // design — revoking an already-revoked family is a no-op, never a
      // second sweep. No password is sent: a valid session is sufficient.
      const response = await inventoryFetch(endpoint, { method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(id ? { id } : {}) }) });
      const data = await response.json();
      if (!mounted.current || controller.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setSessions([]); setNextCursor(null); setPageNumber(1);
          if (response.status === 401) redirectToSignIn();
        }
        setError(t("security.sessionsFailed")); return;
      }
      // The committed account sweep consumes pre-existing management
      // challenges, including this device's. Publish no credential or ID.
      window.dispatchEvent(new Event(SESSION_REVOCATION_EVENT));
      if (data.signedOut) { router.replace(platform ? "/platform/login" : "/login"); router.refresh(); return; }
      await showPage(null, 1);
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(t("security.sessionsFailed"));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) { setBusy(false); setConfirmAll(false); }
    }
  }
  const enabled = canRevoke;
  const kindLabel = (kind: Session["kind"]) => t(kind === "platform" ? "security.sessionPlatform" : kind === "manager" ? "security.sessionManager" : "security.sessionCustomer");
  return <Card data-testid="session-inventory">
    <CardHeader title={t("security.sessions")} subtitle={t(platform ? "security.platformSessionsHint" : "security.workspaceSessionsHint")} />
    <div className="space-y-4 p-5" aria-busy={loading || busy}>
      {error && <ErrorState title={t("security.sessionsFailed")} message={error} retry={() => void showPage(null, 1)} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" disabled={!enabled || busy || loading} onClick={() => void revoke("revoke_others")}>{t("security.revokeOthers")}</Button>
        <Button id="session-revoke-all" type="button" variant="secondary" disabled={!enabled || busy || loading || !confirmAll} onClick={() => void revoke("revoke_all")}>{t("security.revokeAll")}</Button>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink-3">
        <input id="session-confirm-all" type="checkbox" className="mt-0.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" checked={confirmAll} disabled={busy} onChange={e => setConfirmAll(e.target.checked)} />
        <span>{t("security.confirmRevokeAll")}</span>
      </label>
      {loading && (
        <div role="status" aria-live="polite" aria-label={t("security.loadingSessions")} className="space-y-3 py-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-5/6" />
          <span className="sr-only">{t("security.loadingSessions")}</span>
        </div>
      )}
      <ul className="divide-y divide-edge">
        {sessions.map(session => <li key={session.id} className="flex flex-wrap items-start justify-between gap-4 py-4">
          <div className="min-w-0 space-y-1 text-sm">
            <p className="font-semibold">{session.current ? t("security.currentSession") : t("security.otherSession")}</p>
            <p className="break-words text-ink-3">{kindLabel(session.kind)}{session.tenantName ? ` · ${session.tenantName}` : ""}</p>
            <p className="max-w-xl break-words text-ink-3">{parseDeviceLabel(session.userAgent) ?? t("security.unknownDevice")}</p>
            {session.userAgent && <details className="max-w-xl text-ink-3">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("common.viewDetails")}</summary>
              <p className="break-all" dir="ltr">{session.userAgent}</p>
            </details>}
            {session.ipAddress && <p className="font-mono text-xs tabular-nums text-ink-3" dir="ltr">{session.ipAddress}</p>}
            <p className="tabular-nums text-ink-3">{t("security.sessionCreated")}: {formatDate(session.createdAt)} · {t("security.sessionExpires")}: {formatDate(session.expiresAt)}</p>
          </div>
          <Button type="button" variant="secondary" disabled={!enabled || busy || loading} onClick={() => void revoke("revoke", session.id)}>{t("security.revoke")}</Button>
        </li>)}
      </ul>
      <div className="flex flex-wrap gap-3">
        {pageNumber > 1 && <Button type="button" variant="secondary" disabled={busy || loading} onClick={() => void showPage(null, 1)}>{t("security.firstSessions")}</Button>}
        {nextCursor && <Button id="session-next-page" type="button" variant="secondary" disabled={busy || loading} onClick={() => void showPage(nextCursor, pageNumber + 1)}>{t("security.nextSessions")}</Button>}
      </div>
    </div>
  </Card>;
}
