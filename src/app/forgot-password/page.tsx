"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Field, Input, ErrorState } from "../../components/ui";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        setError("Too many attempts. Please try again later.");
        return;
      }
      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : "Unable to send reset email.");
        return;
      }
      setDone(true);
    } catch {
      setError("Unable to send reset email. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell subtitle="Account recovery">
      <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-lg">
        <div className="border-b border-edge bg-surface-2/55 px-6 py-6">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Account recovery</div>
          <h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-ink">Forgot password</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">We&apos;ll send a reset link when the account is eligible.</p>
        </div>
        <div className="p-6 sm:p-7">
          {done ? (
            <div className="rounded-[11px] border border-ok-edge bg-ok-bg p-4 text-[13px] leading-relaxed text-ok">
              If that account exists, a reset email is on its way.{" "}
              <Link className="font-semibold underline" href="/login">Return to sign in</Link>.
            </div>
          ) : (
            <form className="space-y-5" onSubmit={submit}>
              <Field label="Email" htmlFor="email">
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </Field>
              {error && <ErrorState title="Could not send reset link" message={error} />}
              <Button variant="primary" className="w-full" loading={loading} icon={<ArrowRight className="h-4 w-4" />}>
                {loading ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}
          <Link href="/login" className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3 hover:text-ink">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>
        </div>
      </section>
    </AuthShell>
  );
}
