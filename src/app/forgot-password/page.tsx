"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, MailCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState } from "../../components/ui";

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
    <AuthShell
      subtitle="Account recovery"
      eyebrow="Account recovery"
      title="Reset your password"
      description="Enter your workspace email and we’ll send a reset link if the account is eligible."
    >
      {done ? (
        <Callout tone="ok" icon={<MailCheck className="h-4 w-4" aria-hidden />} title="Check your inbox">
          If that account exists, a reset link is on its way. The link expires shortly, so use it
          soon.
        </Callout>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Email" htmlFor="email" required>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </Field>

          {error && <ErrorState title="Couldn’t send the reset link" message={error} />}

          <Button
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4" />}
          >
            {loading ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}

      <Link
        href="/login"
        className="mt-6 inline-flex items-center gap-1.5 text-sm font-[550] text-ink-3 transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to sign in
      </Link>
    </AuthShell>
  );
}
