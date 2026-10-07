"use client";

import { fetchWithTimeout } from "../../../lib/fetch-timeout";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { AuthShell } from "../../../components/AuthShell";
import { Button, Field, Input, ErrorState, Skeleton } from "../../../components/ui";
import { useI18n } from "../../../i18n/react";
import { codeMessageKey } from "../../../lib/api-error-keys";

export default function PlatformLoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchWithTimeout("/api/platform/auth/me", { credentials: "include", cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          router.replace("/platform/dashboard");
          return;
        }
        const refresh = await fetchWithTimeout("/api/platform/auth/refresh", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });
        if (!cancelled && refresh.ok) router.replace("/platform/dashboard");
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetchWithTimeout("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined)
          ?? (res.status === 429 ? "errors.tooManyAttempts" : "auth.signIn.failed")));
      }

      router.replace("/platform/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("auth.signIn.failed"));
    } finally {
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <AuthShell subtitle={t("auth.shell.platformAdmin")}>
        <div className="space-y-4" role="status" aria-label={t("platform.login.checkingSession")}>
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
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label={t("platform.login.email")} htmlFor="platform-email" required>
          <Input
            id="platform-email"
            type="email"
            placeholder={t("platform.login.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
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
