"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Input, Field } from "../../components/ui";

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
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Verification failed");
      setState("ok");
      setMsg("Email verified. Redirecting to workspace setup…");
      setTimeout(() => {
        const next = planId ? `/onboarding?plan=${encodeURIComponent(planId)}` : "/onboarding";
        router.replace(next);
      }, 500);
    }).catch((error) => {
      setState("error");
      setMsg(error instanceof Error ? error.message : "Verification failed");
    });
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

  return (
    <AuthShell subtitle="Email verification">
      <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-lg">
        <div className="border-b border-edge bg-surface-2/55 px-6 py-6 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] border border-edge-accent bg-brand-subtle text-brand">
            {state === "ok" ? <CheckCircle2 className="h-5 w-5" /> : <MailCheck className="h-5 w-5" />}
          </div>
          <h1 className="mt-4 text-[26px] font-bold tracking-[-0.035em] text-ink">{title}</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{msg}</p>
        </div>

        {(state === "error" || state === "pending") && (
          <div className="p-6 sm:p-7">
            <h2 className="text-[13px] font-semibold text-ink">Didn&apos;t receive a link?</h2>
            <form onSubmit={handleResend} className="mt-4 space-y-4">
              <Field label="Email address" htmlFor="resend-email">
                <Input id="resend-email" type="email" value={resendEmail} onChange={(e) => setResendEmail(e.target.value)} placeholder="name@example.com" required />
              </Field>
              {resendMsg && <p className="rounded-[9px] border border-edge bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">{resendMsg}</p>}
              <Button type="submit" variant="secondary" className="w-full" loading={resending} disabled={resending || !resendEmail}>
                {resending ? "Sending…" : "Resend verification email"}
              </Button>
            </form>
            <div className="mt-5 text-center">
              <Link href="/login" className="text-[12.5px] font-semibold text-brand hover:underline">Back to sign in</Link>
            </div>
          </div>
        )}
      </section>
    </AuthShell>
  );
}

export default function VerifyEmail() {
  return (
    <Suspense fallback={
      <AuthShell subtitle="Email verification">
        <div className="rounded-[14px] border border-edge bg-surface p-8 text-center text-[13px] text-ink-3 shadow-card">Loading…</div>
      </AuthShell>
    }>
      <VerifyEmailContent />
    </Suspense>
  );
}
