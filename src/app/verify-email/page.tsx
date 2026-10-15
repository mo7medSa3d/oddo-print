"use client";

import { useEffect, useState, Suspense } from "react";
import { useI18n } from "../../i18n/react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, MailCheck, ShieldAlert } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, Skeleton } from "../../components/ui";
import { codeMessageKey } from "../../lib/api-error-keys";
import { fetchWithTimeout } from "../../lib/fetch-timeout";

// A token represents one mutation, even through StrictMode remounts/locale changes.
// Failures are NOT retained: a rejected or 5xx outcome must not poison the
// cache, or a later successful retry in the same browser is impossible (C063).
const verificationRequests = new Map<string, Promise<{ ok: boolean; code?: string; next?: string }>>();
function verifyOnce(token: string) {
  const existing = verificationRequests.get(token);
  if (existing) return existing;
  const request = fetchWithTimeout("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }, 15_000)
    .then(async response => { const body = await response.json().catch(() => ({})); return { ok: response.ok, code: typeof body?.code === "string" ? body.code : undefined, next: typeof body?.next === "string" ? body.next : undefined }; })
    .then(
      (result) => {
        if (!result.ok) verificationRequests.delete(token);
        return result;
      },
      (error) => {
        verificationRequests.delete(token);
        throw error;
      },
    );
  verificationRequests.set(token, request);
  if (verificationRequests.size > 64) verificationRequests.delete(verificationRequests.keys().next().value!);
  return request;
}

type OutcomeState =
  | { kind: "code"; code?: string }
  | { kind: "message"; message: string };

function VerifyEmailContent() {
  const params = useSearchParams();
  const token = params.get("token");
  const initialEmail = params.get("email") ?? "";
  const planId = params.get("plan") ?? "";
  const inviteToken = params.get("invite") ?? "";
  const { t } = useI18n();
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ok" | "error" | "pending">(
    token ? "loading" : initialEmail ? "pending" : "error",
  );
  const [verifyError, setVerifyError] = useState<OutcomeState | null>(null);
  const [resendEmail, setResendEmail] = useState(initialEmail);
  const [resending, setResending] = useState(false);
  const [resendOutcome, setResendOutcome] = useState<
    { kind: "sent" } | { kind: "error"; outcome: OutcomeState } | null
  >(null);

  useEffect(() => {
    if (!token) return;
    // The request and the redirect both outlive a fast navigation if they are
    // not owned by this effect: an in-flight verification could overwrite the
    // state of a later render, and a pending redirect could yank the user back
    // to onboarding after they had already moved on. Both are cancelled here.
    let cancelled = false;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const result = await verifyOnce(token);
        if (cancelled) return;
        if (!result.ok) {
          setVerifyError({ kind: "code", code: result.code });
          setState("error");
          return;
        }
        const destination = new URL(result.next ?? "/login", window.location.origin);
        if (destination.origin !== window.location.origin || !["/reset-password", "/login"].includes(destination.pathname)) {
          setVerifyError({ kind: "code" });
          setState("error");
          return;
        }
        // Carry optional onboarding/invitation context through password setup;
        // neither query parameter grants a workspace or a session.
        if (destination.pathname === "/reset-password") {
          if (planId) destination.searchParams.set("plan", planId);
          if (inviteToken) destination.searchParams.set("invite", inviteToken);
        }
        setVerifyError(null);
        setState("ok");
        redirectTimer = setTimeout(() => {
          if (cancelled) return;
          router.replace(destination.pathname + destination.search);
        }, 500);
      } catch (error) {
        if (cancelled) return;
        setVerifyError(
          error instanceof Error && error.message
            ? { kind: "message", message: error.message }
            : { kind: "code" },
        );
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
      if (redirectTimer !== undefined) clearTimeout(redirectTimer);
    };
  }, [token, planId, inviteToken, router]);

  async function handleResend(event: React.FormEvent) {
    event.preventDefault();
    if (!resendEmail || resending) return;
    setResending(true);
    setResendOutcome(null);
    try {
      const response = await fetchWithTimeout("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resendEmail, planId, inviteToken }),
      });
      const data = await response.json();
      if (!response.ok) {
        setResendOutcome({
          kind: "error",
          outcome: { kind: "code", code: typeof data.code === "string" ? data.code : undefined },
        });
        return;
      }
      setResendOutcome({ kind: "sent" });
    } catch (error) {
      setResendOutcome({
        kind: "error",
        outcome:
          error instanceof Error && error.message
            ? { kind: "message", message: error.message }
            : { kind: "code" },
      });
    } finally {
      setResending(false);
    }
  }

  const msg =
    state === "loading"
      ? t("auth.verify.verifying")
      : state === "pending"
        ? t("auth.verify.checkInbox", { email: initialEmail })
        : state === "ok"
          ? t("auth.verify.verifiedBody")
          : !token
            ? t("auth.verify.missingLink")
            : verifyError?.kind === "code"
              ? t(codeMessageKey(verifyError.code) ?? "auth.verify.failed")
              : verifyError?.message || t("auth.verify.failed");

  const resendMsg = !resendOutcome
    ? ""
    : resendOutcome.kind === "sent"
      ? t("auth.verify.resendSent")
      : resendOutcome.outcome.kind === "code"
        ? t(codeMessageKey(resendOutcome.outcome.code) ?? "auth.verify.resendFailed")
        : resendOutcome.outcome.message || t("auth.verify.resendFailed");

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
        <Callout tone="ok" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} title={t("auth.verify.allSetTitle")}>
          {t("auth.verify.continuing")}
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
              {t("auth.verify.backToSignIn")}
            </Link>
          </div>
        </div>
      )}
    </AuthShell>
  );
}

export default function VerifyEmail() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <AuthShell subtitle={t("auth.verify.eyebrowPending")}>
          <div className="space-y-4" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-6 h-20 w-full" />
            <span className="sr-only">{t("common.loading")}</span>
          </div>
        </AuthShell>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
