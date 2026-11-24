"use client";

import { fetchWithTimeout } from "../../lib/fetch-timeout";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Building2, MailCheck, ShieldCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Skeleton } from "../../components/ui";
import { useI18n } from "../../i18n/react";
import { codeMessageKey } from "../../lib/api-error-keys";

type Preview = { email: string; workspaceName: string; role: string };
type Step = "ready" | "verification" | "sign-in" | "joined" | "error";

function InviteContent() {
  const token = useSearchParams().get("token") ?? "";
  return <InvitationDetails key={token} token={token} />;
}

function InvitationDetails({ token }: { token: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>("ready");
  const [message, setMessage] = useState("");
  const feedbackRef = useRef<HTMLDivElement>(null);
  const returnUrl = `/invite?token=${encodeURIComponent(token)}`;
  const signInUrl = `/login?next=${encodeURIComponent(returnUrl)}&switch=1`;

  useEffect(() => {
    const controller = new AbortController();
    if (!token || token.length > 256) return;
    fetchWithTimeout(`/api/team/invitations/preview?token=${encodeURIComponent(token)}`, {
      cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { code?: string };
        if (!controller.signal.aborted) setMessage(t(codeMessageKey(body.code) ?? "invite.failed"));
        return null;
      }
      return await response.json() as Preview;
    }).then(data => {
      if (!controller.signal.aborted && data) setPreview(data);
    }).catch(() => {
      if (!controller.signal.aborted) setMessage(t("invite.failed"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [token, t]);

  async function accept() {
    if (!preview || busy) return;
    setBusy(true);
    setStep("ready");
    setMessage("");
    try {
      const response = await fetchWithTimeout("/api/team/invitations/accept", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json().catch(() => ({})) as {
        code?: string; sessionEstablished?: boolean;
      };
      if (response.ok && payload.code === "VERIFICATION_SENT") {
        setStep("verification");
        setMessage(t("invite.verificationSent"));
      } else if (response.ok) {
        setStep("joined");
        setMessage(t("invite.accepted"));
        if (payload.sessionEstablished) {
          router.replace("/dashboard");
          router.refresh();
        }
      } else if (payload.code === "SIGN_IN_REQUIRED") {
        setStep("sign-in");
        setMessage(t("invite.signInRequired"));
      } else if (payload.code === "VERIFY_EMAIL_REQUIRED") {
        const resend = await fetchWithTimeout("/api/auth/resend-verification", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: preview.email, inviteToken: token }),
        });
        if (!resend.ok) throw new Error("Verification email unavailable");
        setStep("verification");
        setMessage(t("invite.verificationSent"));
      } else if (payload.code === "ALREADY_MEMBER") {
        setStep("joined");
        setMessage(t("invite.alreadyMember"));
      } else {
        setStep("error");
        setMessage(t(codeMessageKey(payload.code) ?? "invite.failed"));
      }
    } catch {
      setStep("error");
      setMessage(t("invite.failed"));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => feedbackRef.current?.focus());
    }
  }

  return (
    <AuthShell
      subtitle={t("auth.shell.invitation")}
      title={t("invite.title")}
      description={t("invite.description")}
      footer={
        <Link
          className="inline-flex min-h-11 items-center gap-1.5 rounded-sm font-medium text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
          href={token ? signInUrl : "/login"}
        >
          {t("invite.signIn")} <ArrowRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
        </Link>
      }
    >
      {!token || token.length > 256 ? (
        <Callout tone="bad" title={t("invite.rejectedTitle")}>{t("invite.linkMissing")}</Callout>
      ) : loading ? (
        <div role="status" className="space-y-4" aria-label={t("invite.loading")}>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : !preview ? (
        <Callout tone="bad" title={t("invite.rejectedTitle")}>{message || t("invite.failed")}</Callout>
      ) : (
        <div className="space-y-5">
          <div className="rounded-[20px] border border-edge-subtle bg-surface-2/70 p-5">
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-brand-subtle p-3 text-brand">
                <Building2 className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="text-xs text-ink-3">{t("invite.workspaceLabel")}</div>
                <div className="break-words font-semibold text-ink">{preview.workspaceName}</div>
              </div>
            </div>
            <div className="mt-4 border-t border-edge-subtle pt-3 text-sm text-ink-2">
              <span className="text-xs text-ink-3">{t("invite.invitedEmail")}</span>
              <div dir="ltr" className="mt-1 break-all text-start font-medium text-ink">{preview.email}</div>
            </div>
          </div>

          {step === "ready" || step === "error" ? (
            <Button
              type="button"
              className="w-full"
              size="lg"
              variant="primary"
              loading={busy}
              disabled={busy}
              onClick={() => void accept()}
              icon={busy ? undefined : <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
            >
              {busy ? t("invite.submitting") : t("invite.submit")}
            </Button>
          ) : null}

          {message && (
            <div ref={feedbackRef} role={step === "error" ? "alert" : "status"} tabIndex={-1} className="outline-none">
              <Callout
                tone={step === "error" ? "bad" : step === "joined" ? "ok" : "info"}
                icon={step === "error" || step === "sign-in" ? undefined : step === "verification"
                  ? <MailCheck className="h-4 w-4" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
                title={step === "error" ? t("invite.rejectedTitle") :
                  step === "verification" ? t("invite.checkInboxTitle") : step === "sign-in" ? t("invite.signIn") : t("invite.acceptedTitle")}
              >
                {message}
                {step === "sign-in" && (
                  <Link href={signInUrl} className="mt-3 inline-flex min-h-11 items-center rounded-sm font-semibold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
                    {t("invite.signIn")}
                  </Link>
                )}
                {step === "joined" && (
                  <Link href="/dashboard" className="mt-3 inline-flex min-h-11 items-center rounded-sm font-semibold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
                    {t("invite.openWorkspace")}
                  </Link>
                )}
              </Callout>
            </div>
          )}
        </div>
      )}
    </AuthShell>
  );
}

export default function Invite() {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <AuthShell subtitle={t("auth.shell.invitation")}>
          <div role="status" aria-label={t("invite.loading")} className="space-y-4">
            <Skeleton className="h-7 w-52" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </AuthShell>
      }
    >
      <InviteContent />
    </Suspense>
  );
}
