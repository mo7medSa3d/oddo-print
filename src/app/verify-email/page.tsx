"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark, Button, Input, Field } from "../../components/ui";

function VerifyEmailContent() {
  const params = useSearchParams();
  const token = params.get("token");
  const initialEmail = params.get("email") ?? "";
  const router = useRouter();
  const [state, setState] = useState<"loading" | "ok" | "error" | "pending">(
    token ? "loading" : initialEmail ? "pending" : "error"
  );
  const [msg, setMsg] = useState(
    token ? "Verifying your email…" : initialEmail ? `Check your inbox (${initialEmail}) for a verification link.` : "Verification link is missing or invalid."
  );
  const [resendEmail, setResendEmail] = useState(initialEmail);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Verification failed");
      setState("ok");
      setMsg("Email verified. Redirecting to workspace setup…");
      setTimeout(() => router.replace("/onboarding"), 500);
    }).catch(e => {
      setState("error");
      setMsg(e instanceof Error ? e.message : "Verification failed");
    });
  }, [token, router]);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    if (!resendEmail || resending) return;
    setResending(true);
    setResendMsg("");
    try {
      const r = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resendEmail })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to resend verification email");
      setResendMsg("A new verification link has been sent if the account exists.");
    } catch (e) {
      setResendMsg(e instanceof Error ? e.message : "Failed to resend verification email");
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="w-full max-w-md card p-7 text-center">
      <BrandMark size="lg" title="Yasser" subtitle="Email verification" />
      <h1 className="mt-6 text-2xl font-bold text-ink">
        {state === "loading" ? "Verify your email" : state === "ok" ? "Email verified" : state === "pending" ? "Check your email" : "Verification failed"}
      </h1>
      <p className="mt-2 text-sm text-ink-2">{msg}</p>

      {(state === "error" || state === "pending") && (
        <div className="mt-6 pt-6 border-t border-edge text-left">
          <h2 className="text-sm font-semibold text-ink">Didn&apos;t receive a link?</h2>
          <form onSubmit={handleResend} className="mt-3 space-y-3">
            <Field label="Email address" htmlFor="resend-email">
              <Input
                id="resend-email"
                type="email"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
                placeholder="name@example.com"
                required
              />
            </Field>
            {resendMsg && (
              <p className="text-xs text-ink-2 bg-surface-2 p-2 rounded border border-edge">
                {resendMsg}
              </p>
            )}
            <Button
              type="submit"
              variant="secondary"
              className="w-full"
              loading={resending}
              disabled={resending || !resendEmail}
            >
              {resending ? "Sending…" : "Resend verification email"}
            </Button>
          </form>
          <div className="mt-4 text-center">
            <Link href="/login" className="text-sm font-semibold text-brand">
              Back to sign in
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VerifyEmail() {
  return (
    <main className="canvas-wash min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={<div className="w-full max-w-md card p-7 text-center">Loading...</div>}>
        <VerifyEmailContent />
      </Suspense>
    </main>
  );
}
