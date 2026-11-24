"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState, Skeleton, focusFirstError } from "../../components/ui";
import { codeMessageKey } from "../../lib/api-error-keys";
import { fetchWithTimeout } from "../../lib/fetch-timeout";

function ResetPasswordContent() {
  const params = useSearchParams();
  return <ResetPasswordForm key={params.toString()} params={params} />;
}

function ResetPasswordForm({ params }: { params: ReturnType<typeof useSearchParams> }) {
  const token = params.get("token") ?? "";
  const setup = params.get("setup") === "1";
  const invite = params.get("invite") ?? "";
  const joined = params.get("joined") === "1";
  const plan = params.get("plan") ?? "";
  const term = params.get("term") ?? "";
  const billingQuery = new URLSearchParams();
  if (plan) billingQuery.set("plan", plan);
  if (term === "monthly" || term === "yearly") billingQuery.set("term", term);
  const billingSuffix = billingQuery.toString();
  const continuation = joined
    ? "/dashboard"
    : invite
      ? `/invite?token=${encodeURIComponent(invite)}`
      : billingSuffix
        ? `/billing?${billingSuffix}`
        : "/billing";
  const signInDestination = setup ? `/login?next=${encodeURIComponent(continuation)}` : "/login";
  const router = useRouter();
  const [pw, setPw] = useState("");
  const { t } = useI18n();
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [nextRoute, setNextRoute] = useState(signInDestination);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => router.replace(nextRoute), 500);
    return () => clearTimeout(timer);
  }, [done, router, nextRoute]);

  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (err) focusFirstError(formRef.current);
  }, [err]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (!token) {
      setErr(t("auth.reset.linkMissing"));
      return;
    }
    submitting.current = true;
    setErr("");
    setLoading(true);
    try {
      const response = await fetchWithTimeout("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErr(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "auth.reset.failed"));
        return;
      }
      setPw("");
      setNextRoute(setup && data.authenticated === true ? continuation : signInDestination);
      setDone(true);
    } catch {
      setErr(t("auth.reset.failedBody"));
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.forgot.eyebrow")}
      title={t(setup ? "auth.setup.title" : "auth.reset.title")}
      description={t(setup ? "auth.setup.description" : "auth.reset.description")}
      footer={
        !done ? (
          <Link
            id="request-new-reset-link"
            href="/forgot-password"
            className="inline-flex min-h-11 items-center rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            {t("auth.reset.requestNewLink")}
          </Link>
        ) : undefined
      }
    >
      {done ? (
        <Callout tone="ok" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} title={t("auth.reset.updatedTitle")}>
          {t(setup && nextRoute === continuation ? "auth.setup.takingYou" : "auth.reset.takingYou")}{" "}
          <Link href={nextRoute} className="rounded-sm font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
            {t("auth.reset.continueNow")}
          </Link>
          .
        </Callout>
      ) : (
        <form ref={formRef} aria-busy={loading} className="space-y-4" onSubmit={submit}>
          <Field
            label={t("auth.reset.password")}
            htmlFor="password"
            hint={t("auth.passwordHint")}
            required
          >
            <Input
              id="password"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={12}
              maxLength={4096}
              autoComplete="new-password"
              autoFocus
              disabled={loading}
              aria-invalid={Boolean(err) || undefined}
              aria-describedby={err ? "password-hint reset-error" : undefined}
              required
            />
          </Field>

          {err && <div id="reset-error"><ErrorState title={t("auth.reset.failed")} message={err} /></div>}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
          >
            {loading ? t("auth.reset.submitting") : t(setup ? "auth.setup.submit" : "auth.reset.submit")}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export default function ResetPassword() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <AuthShell subtitle={t("auth.forgot.eyebrow")}>
          <div className="space-y-4" role="status" aria-label={t("auth.reset.loadingAria")}>
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-6 h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <span className="sr-only">{t("auth.reset.loadingShort")}</span>
          </div>
        </AuthShell>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}
