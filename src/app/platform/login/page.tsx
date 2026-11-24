"use client";

import { fetchWithTimeout } from "../../../lib/fetch-timeout";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { AuthShell } from "../../../components/AuthShell";
import { Button, Field, Input, ErrorState, Skeleton, focusFirstError } from "../../../components/ui";
import { useI18n } from "../../../i18n/react";
import { codeMessageKey } from "../../../lib/api-error-keys";

/** Keep the return target on this origin and inside the authenticated platform. */
function afterLoginDestination(): string {
  if (typeof window === "undefined") return "/platform/dashboard";
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/platform/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return "/platform/dashboard";
  try {
    const destination = new URL(next, window.location.origin);
    const cleanPath = destination.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
    if (destination.origin === window.location.origin && cleanPath.startsWith("/platform/") && cleanPath !== "/platform/login") {
      return destination.pathname + destination.search + destination.hash;
    }
  } catch { /* fall through to the safe platform destination */ }
  return "/platform/dashboard";
}

export default function PlatformLoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const mounted = useRef(false);
  const flight = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    const startup = new AbortController();

    fetchWithTimeout("/api/platform/auth/me", { credentials: "include", cache: "no-store", signal: startup.signal })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          router.replace(afterLoginDestination());
          return;
        }
        const refresh = await fetchWithTimeout("/api/platform/auth/refresh", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          signal: startup.signal,
        });
        if (!cancelled && refresh.ok) router.replace(afterLoginDestination());
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });

    return () => {
      cancelled = true;
      mounted.current = false;
      startup.abort();
      flight.current?.abort();
      flight.current = null;
    };
  }, [router]);

  const formRef = useRef<HTMLFormElement>(null);
  // Guide form rule: move focus to the first error when submission fails.
  useEffect(() => {
    if (error) focusFirstError(formRef.current);
  }, [error]);
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!mounted.current || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setError("");
    setLoading(true);
    const exactPassword = password;
    setPassword("");

    try {
      const res = await fetchWithTimeout("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password: exactPassword }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!mounted.current || controller.signal.aborted || flight.current !== controller) return;

      if (!res.ok) {
        setError(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined)
          ?? (res.status === 429 ? "errors.tooManyAttempts" : "auth.signIn.failed")));
        return;
      }

      router.replace(afterLoginDestination());
      router.refresh();
    } catch (err: unknown) {
      if (mounted.current && !controller.signal.aborted && flight.current === controller) {
        setError(t("auth.signIn.failed"));
      }
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }

  if (checkingSession) {
    return (
      <AuthShell subtitle={t("auth.shell.platformAdmin")}>
        <div className="space-y-4" role="status" aria-busy="true" aria-label={t("platform.login.checkingSession")}>
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-60" />
          <Skeleton className="mt-6 h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <span className="sr-only">{t("platform.login.checkingSessionShort")}</span>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      subtitle={t("auth.shell.platformAdmin")}
      eyebrow={t("platform.login.eyebrow")}
      title={t("auth.signIn.title")}
      description={t("platform.login.description")}
    >
      <form ref={formRef} onSubmit={handleSubmit} aria-busy={loading || undefined} className="space-y-4">
        <Field label={t("platform.login.email")} htmlFor="platform-email" required>
          <Input
            id="platform-email"
            type="email"
            placeholder={t("platform.login.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            dir="ltr"
            autoComplete="email"
            disabled={loading}
            autoFocus
            required
          />
        </Field>

        <Field label={t("platform.login.password")} htmlFor="platform-password" required>
          <Input
            id="platform-password"
            type="password"
            placeholder={t("platform.login.passwordPlaceholder")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            maxLength={4096}
            disabled={loading}
            required
          />
        </Field>

        {error && <ErrorState title={t("platform.login.signInTitle")} message={error} />}

        <Button
          variant="primary"
          type="submit"
          loading={loading}
          className="w-full"
          size="lg"
          icon={loading ? undefined : <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
        >
          {loading ? t("auth.signIn.submitting") : t("common.continue")}
        </Button>

        <div className="flex items-start gap-2.5 rounded-md border border-edge bg-surface-2 px-4 py-3.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <p className="text-sm leading-relaxed text-ink-3">
            {t("platform.login.restricted")}
          </p>
        </div>
      </form>
    </AuthShell>
  );
}
