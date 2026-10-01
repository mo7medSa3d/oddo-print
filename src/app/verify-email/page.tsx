"use client";

import { useEffect, useState, Suspense } from "react";
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
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ok" | "error" | "pending">(
    token ? "loading" : initialEmail ? "pending" : "error",
  );
  const [msg, setMsg] = useState(
    token
      ? "Verifying your email…"
      : initialEmail
        ? `Check your inbox (${initialEmail}) for a verification link.`
        : "Verification link is missing or invalid.",
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
        if (!response.ok) throw new Error(payload.error ?? "Verification failed");
        setState("ok");
        setMsg("Email verified. Redirecting to workspace setup…");
        redirectTimer = setTimeout(() => {
          if (cancelled) return;
          const next = planId ? `/onboarding?plan=${encodeURIComponent(planId)}` : "/onboarding";
          router.replace(next);
        }, 500);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState("error");
        setMsg(error instanceof Error ? error.message : "Verification failed");
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
      if (!response.ok) throw new Error(data.error ?? "Failed to resend verification email");
      setResendMsg("A new verification link has been sent if the account exists.");
    } catch (error) {
      setResendMsg(error instanceof Error ? error.message : "Failed to resend verification email");
    } finally {
      setResending(false);
    }
  }

  const title = state === "loading" ? "Verify your email" : state === "ok" ? "Email verified" : state === "pending" ? "Check your email" : "Verification failed";
  const eyebrow = state === "ok" ? "Verified" : state === "error" ? "Action needed" : "Email verification";

  return (
    <AuthShell subtitle="Email verification" eyebrow={eyebrow} title={title} description={msg}>
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
            title={state === "error" ? "This link can’t be used" : "Links expire after a short time"}
          >
            {state === "error"
              ? "Request a new verification link below, or sign in if you already verified this address."
              : "If it doesn’t arrive within a few minutes, check spam or resend it below."}
          </Callout>

          <form onSubmit={handleResend} className="space-y-4">
            <Field label="Email address" htmlFor="resend-email" hint="We only send a link if the account exists.">
              <Input
                id="resend-email"
                type="email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                placeholder="name@example.com"
                autoComplete="email"
                required
              />
            </Field>

            {resendMsg && (
              <p
                role="status"
                className="rounded-lg border border-edge-subtle bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed text-ink-2"
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
              {resending ? "Sending…" : "Resend verification email"}
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
        <AuthShell subtitle="Email verification">
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
