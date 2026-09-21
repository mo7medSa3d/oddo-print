"use client";

import { useState } from "react";
import Link from "next/link";
import { BrandMark, Button, Field, Input } from "../../components/ui";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      const retryAfter = Number(res.headers.get("retry-after"));
      // Rate limiting: the API answers 202 with a Retry-After header and does
      // NOT send an email. Claiming success here would be a false "email sent".
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        setError(`Too many attempts. Please try again later.`);
        return;
      }
      if (!res.ok) {
        // Enumeration-safe success (202), including unknown accounts, is the
        // only path below; a non-2xx here means a real failure (413, 5xx).
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
    <main className="canvas-wash min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md card p-7">
        <BrandMark size="lg" title="Yasser" subtitle="Account recovery" />
        <h1 className="mt-6 text-2xl font-bold text-ink">Forgot password</h1>
        {done ? (
          <p className="mt-3 text-sm text-ink-2">
            If that account exists, a reset email is on its way.{" "}
            <Link className="font-semibold text-brand" href="/login">
              Return to sign in
            </Link>
            .
          </p>
        ) : (
          <form className="mt-6 space-y-5" onSubmit={submit}>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </Field>
            {error && (
              <div role="alert" className="rounded-xl border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] text-bad">
                {error}
              </div>
            )}
            <Button variant="primary" className="w-full" loading={loading}>
              {loading ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
