"use client";

import { fetchWithTimeout } from "../../lib/fetch-timeout";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Building2 } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Field, Input, ErrorState, Skeleton, focusFirstError } from "../../components/ui";
import { ensureCustomerSession } from "../../lib/session-config";
import { codeMessageKey } from "../../lib/api-error-keys";

import type { MessageKey } from "../../i18n/messages/en";

class LoginRequestError extends Error {
  constructor(readonly key: MessageKey) { super(key); }
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [showNormalSignIn, setShowNormalSignIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name?: string }>>([]);
  const [selectionToken, setSelectionToken] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const router = useRouter();

  const postAuthDestination = useCallback((): string => {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(next)) {
      try {
        const destination = new URL(next, window.location.origin);
        const cleanPath = destination.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
        if (
          destination.origin === window.location.origin &&
          cleanPath !== "/api" &&
          !cleanPath.startsWith("/api/") &&
          !["/login", "/logout", "/register", "/signup"].includes(cleanPath)
        ) {
          return destination.pathname + destination.search + destination.hash;
        }
      } catch { /* use the safe workspace destination */ }
    }
    return "/dashboard";
  }, []);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    const startup = new AbortController();
    const cleanup = () => { cancelled = true; mounted.current = false; startup.abort(); flight.current?.abort(); flight.current = null; };
    if (new URLSearchParams(window.location.search).get("switch") === "1") {
      queueMicrotask(() => { if (!cancelled) setCheckingSession(false); });
      return cleanup;
    }
    ensureCustomerSession()
      .then((session) => {
        if (!cancelled && session.authenticated) router.replace(postAuthDestination());
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });
    return cleanup;
  }, [router, postAuthDestination, t]);

  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (err) focusFirstError(formRef.current);
  }, [err]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (flight.current || !mounted.current) return;
    const exactPassword = password;
    setPassword("");
    const controller = new AbortController(); flight.current = controller;
    setErr("");
    setShowNormalSignIn(false);
    setWorkspaces([]);
    setSelectionToken("");
    setLoading(true);
    try {
      const destination = new URL(postAuthDestination(), window.location.origin);
      const inviteToken = destination.pathname === "/invite" ? destination.searchParams.get("token") : null;
      const res = await fetchWithTimeout("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error",
        body: JSON.stringify({ email, password: exactPassword, ...(inviteToken ? { inviteToken } : {}) }), signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!mounted.current || controller.signal.aborted || flight.current !== controller) return;
      if (res.status === 409 && Array.isArray(data.workspaces)) {
        if (typeof data.selectionToken !== "string" || !data.selectionToken) {
          throw new LoginRequestError("auth.signIn.selectWorkspaceFailed");
        }
        const ids = data.workspaces.filter((id: unknown): id is string => typeof id === "string");
        const names = new Map<string, string>();
        if (Array.isArray(data.workspaceOptions)) {
          for (const option of data.workspaceOptions) {
            if (option && typeof option.id === "string" && typeof option.name === "string" && option.name.trim()) {
              names.set(option.id, option.name.trim());
            }
          }
        }
        setSelectionToken(data.selectionToken);
        setWorkspaces(ids.map((id: string) => ({ id, name: names.get(id) })));
        return;
      }
      if (!res.ok) {
        if (data.code === "INVITATION_ALREADY_MEMBER") setShowNormalSignIn(true);
        throw new LoginRequestError(codeMessageKey(typeof data.code === "string" ? data.code : undefined)
          ?? (res.status === 429 ? "errors.tooManyAttempts" : res.status === 503 ? "errors.serviceUnavailable" : "auth.signIn.failed"));
      }
      router.replace(data.invitationAccepted === true ? "/dashboard" : postAuthDestination());
      router.refresh();
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && flight.current === controller) setErr(t(error instanceof LoginRequestError ? error.key : "errors.networkError"));
    } finally {
      if (flight.current === controller) { flight.current = null; if (mounted.current) { setPassword(""); setLoading(false); } }
    }
  }

  async function chooseWorkspace(tenantId: string) {
    if (flight.current || !mounted.current) return;
    const controller = new AbortController(); flight.current = controller;
    setLoading(true);
    setErr("");
    try {
      const res = await fetchWithTimeout("/api/auth/select-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error",
        body: JSON.stringify({ tenantId, selectionToken }), signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!mounted.current || controller.signal.aborted || flight.current !== controller) return;
      if (!res.ok) {
        throw new LoginRequestError(codeMessageKey(typeof data.code === "string" ? data.code : undefined)
          ?? (res.status === 429 ? "errors.tooManyAttempts" : res.status === 503 ? "errors.serviceUnavailable" : "auth.signIn.selectWorkspaceFailed"));
      }
      router.replace(postAuthDestination());
      router.refresh();
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && flight.current === controller) setErr(t(error instanceof LoginRequestError ? error.key : "errors.networkError"));
    } finally {
      if (flight.current === controller) { flight.current = null; if (mounted.current) { setPassword(""); setLoading(false); } }
    }
  }

  if (checkingSession) {
    return (
      <AuthShell subtitle={t("auth.shell.gateway")}>
        <div className="space-y-4" role="status" aria-label={t("auth.session.checking")}>
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="mt-6 h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <span className="sr-only">{t("auth.session.checkingShort")}</span>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      subtitle={t("auth.shell.gateway")}
      title={t("auth.signIn.title")}
      description={t("auth.signIn.description")}
      footer={
        <>
          {t("auth.signIn.noAccount")}{" "}
          <Link href="/signup" className="rounded-sm font-semibold text-brand hover:text-brand-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
            {t("auth.signIn.createOne")}
          </Link>
        </>
      }
    >
      <form ref={formRef} onSubmit={onSubmit} aria-busy={loading} className="space-y-4">
        <Field label={t("auth.email")} htmlFor="email">
          <Input
            id="email"
            type="email"
            placeholder={t("auth.emailPlaceholder")}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setWorkspaces([]); setSelectionToken(""); }}
            autoComplete="email"
            autoFocus
            disabled={loading}
            aria-invalid={Boolean(err) || undefined}
            aria-describedby={err ? "login-error" : undefined}
            required
          />
        </Field>

        <Field
          label={t("auth.password")}
          htmlFor="password"
          actions={
            <Link
              href="/forgot-password"
              className="inline-flex min-h-9 items-center rounded-sm text-sm font-medium text-ink-3 transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
            >
              {t("auth.password.forgot")}
            </Link>
          }
        >
          <Input
            id="password"
            type="password"
            placeholder={t("auth.passwordPlaceholder")}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setWorkspaces([]); setSelectionToken(""); }}
            autoComplete="current-password"
            maxLength={4096}
            disabled={loading}
            aria-invalid={Boolean(err) || undefined}
            aria-describedby={err ? "login-error" : undefined}
            required
          />
        </Field>

        {err && <div id="login-error"><ErrorState title={t("auth.signIn.failed")} message={err} /></div>}
        {showNormalSignIn && (
          <Link href="/login?switch=1" className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
            {t("invite.normalSignIn")}
          </Link>
        )}

        {workspaces.length > 0 && (
          <div className="rounded-[20px] border border-edge-accent bg-brand-subtle p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Building2 className="h-4 w-4 text-brand" aria-hidden />
              {t("auth.signIn.chooseWorkspace")}
            </div>
            <div className="mt-3 grid gap-2">
              {workspaces.map(({ id, name }) => (
                <button
                  key={id}
                  type="button"
                  disabled={loading}
                  onClick={() => void chooseWorkspace(id)}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-edge-subtle bg-surface px-3.5 py-2 text-start text-sm font-medium text-ink transition-colors duration-150 hover:border-edge-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <span className="min-w-0 break-words" title={id}>{name ?? t("auth.signIn.workspaceSuffix", { suffix: id.slice(-6) })}</span>
                  <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100 shrink-0 text-ink-4" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        )}

        <Button
          variant="primary"
          type="submit"
          loading={loading}
          className="w-full"
          size="lg"
          icon={loading ? undefined : <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
        >
          {loading ? t("auth.signIn.submitting") : t("auth.signIn.title")}
        </Button>
      </form>
    </AuthShell>
  );
}
