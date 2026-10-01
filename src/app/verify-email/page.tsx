"use client";

import { useEffect, useState, Suspense } from "react";
import { useI18n } from "../../i18n/react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, MailCheck, ShieldAlert } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, Skeleton } from "../../components/ui";

function VerifyEmailContent() {
  const params = useSearchParams();
  const token = params.get("token");
  const initialEmail = params.get("email") ?? "";
  const planId = params.get("plan") ?? "";
  const { t } = useI18n();
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ok" | "error" | "pending">(
    token ? "loading" : initialEmail ? "pending" : "error",
  );
  const [msg, setMsg] = useState(
    token
      ? t("auth.verify.verifying")
      : initialEmail
        ? `Check your inbox (${initialEmail}) for a verification link.`
        : t("auth.verify.missingLink"),
  );
  const [resendEmail, setResendEmail] = useState(initialEmail);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  useEffect(() => {
    if (!token) return;
    // The request and the redirect both outlive a fast navigation if they are
    // not owned by this effect: an in-flight verification could overwrite the
    // state of a later render, and a pending redirect could yank the user back
    // to onboarding after they had already moved on. Both are cancelled here.
    const controller = new AbortController();
    let cancelled = false;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const response = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          signal: controller.signal,
        });
        let payload: { error?: string } = {};
        try {
          payload = (await response.json()) as { error?: string };
        } catch {
          payload = {};
        }
        if (cancelled) return;
        if (!response.ok) throw new Error(payload.error ?? t("auth.verify.failed"));
        setState("ok");
        setMsg(t("auth.verify.verifiedBody"));
        redirectTimer = setTimeout(() => {
          if (cancelled) return;
          const next = planId ? `/onboarding?plan=${encodeURIComponent(planId)}` : "/onboarding";
          router.replace(next);
        }, 500);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState("error");
        setMsg(error instanceof Error ? error.message : t("auth.verify.failed"));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (redirectTimer !== undefined) clearTimeout(redirectTimer);
    };
  }, [token, planId, router]);

  async function handleResend(event: React.FormEvent) {
    event.preventDefault();
    if (!resendEmail || resending) return;
    setResending(true);
    setResendMsg("");
    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resendEmail, planId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? t("auth.verify.resendFailed"));
      setResendMsg(t("auth.verify.resendSent"));
    } catch (error) {
      setResendMsg(error instanceof Error ? error.message : t("auth.verify.resendFailed"));
    } finally {
      setResending(false);
    }
  }

  const title =
    state === "loading" || state === "pending"
      ? t("auth.verify.checkEmail")
      : state === "ok"
        ? t("auth.verify.verified")
        : t("auth.verify.failed");
  const eyebrow = state === "ok" ? t("auth.verify.eyebrowDone") : state === "error" ? t("auth.verify.eyebrowError") : t("auth.verify.eyebrowPending");

  return (
    <AuthShell subtitle={t("auth.verify.eyebrowPending")} eyebrow={eyebrow} title={title} description={msg}>
      {state === "ok" ? (
        <Callout tone="ok" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} title="You’re all set">
          Continuing to workspace setup…
        </Callout>
      ) : (
        <div className="space-y-5">
          <Callout
            tone={state === "error" ? "warn" : "info"}
            icon={
              state === "error" ? (
                <ShieldAlert className="h-4 w-4" aria-hidden />
              ) : (
                <MailCheck className="h-4 w-4" aria-hidden />
              )
            }
            title={state === "error" ? t("auth.verify.linkUnusable") : t("auth.verify.linksExpire")}
          >
            {state === "error"
              ? t("auth.verify.linkUnusableBody")
              : t("auth.verify.linksExpireBody")}
          </Callout>

          <form onSubmit={handleResend} className="space-y-4">
            <Field label={t("auth.verify.emailAddress")} htmlFor="resend-email" hint={t("auth.verify.hint")}>
              <Input
                id="resend-email"
                type="email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                placeholder={t("auth.emailPlaceholder")}
                autoComplete="email"
                required
              />
            </Field>

            {resendMsg && (
              <p
                role="status"
                className="rounded-sg border border-edge-subtle bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-ink-2"
              >
                {resendMsg}
              </p>
            )}

            <Button
              type="submit"
              variant="secondary"
              className="w-full"
              size="lg"
              loading={resending}
              disabled={resending || !resendEmail}
            >
              {resending ? t("auth.verify.resending") : t("auth.verify.resend")}
            </Button>
          </form>

          <div className="text-center">
            <Link href="/login" className="text-sm font-[550] text-brand hover:underline">
              Back to sign in
            </Link>
          </div>
        </div>
      )}
    </AuthShell>
  );
}

export default function VerifyEmail() {
  return (
    <Suspense
      fallback={
        <AuthShell subtitle={t("auth.verify.eyebrowPending")}>
          <div className="space-y-4" role="status" aria-label="Loading">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-6 h-20 w-full" />
            <span className="sr-only">Loading…</span>
          </div>
        </AuthShell>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
