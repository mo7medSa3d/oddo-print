"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Field, Input, ErrorState } from "../../components/ui";

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setErr("");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Registration failed");
      setDone(true);
      window.location.assign(`/verify-email?email=${encodeURIComponent(email)}`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell subtitle="Customer account">
      <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-lg">
        <div className="border-b border-edge bg-surface-2/55 px-6 py-6">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Create workspace access</div>
          <h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-ink">Create your account</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">Use your business email. A verification link is required.</p>
        </div>

        {done ? (
          <div className="p-6 sm:p-7">
            <div className="rounded-[11px] border border-ok-edge bg-ok-bg p-4 text-[13px] leading-relaxed text-ok">
              Check your email for the verification link. <Link className="font-semibold underline" href="/login">Return to sign in</Link>.
            </div>
          </div>
        ) : (
          <form className="space-y-5 p-6 sm:p-7" onSubmit={submit}>
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </Field>
            <Field label="Password" htmlFor="password" hint="Use at least 12 characters.">
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required />
            </Field>
            {err && <ErrorState title="Could not create account" message={err} />}
            <Button type="submit" variant="primary" className="w-full" loading={loading} icon={<ArrowRight className="h-4 w-4" />}>
              {loading ? "Creating…" : "Create account"}
            </Button>
            <p className="text-center text-[12.5px] text-ink-3">
              Already have an account? <Link className="font-semibold text-brand hover:underline" href="/login">Sign in</Link>
            </p>
          </form>
        )}
      </section>
    </AuthShell>
  );
}
