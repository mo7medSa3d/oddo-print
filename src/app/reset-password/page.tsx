"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark, Button, Field, Input, ErrorState } from "../../components/ui";

function ResetPasswordContent() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const r = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(typeof d.error === "string" ? d.error : "Reset failed");
        return;
      }
      setDone(true);
      setTimeout(() => router.replace("/login"), 700);
    } catch {
      setErr("Could not reset password. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md card p-7">
      <BrandMark size="lg" title="Yasser" subtitle="Account recovery" />
      <h1 className="mt-6 text-2xl font-bold text-ink">Reset password</h1>
      {done ? (
        <p className="mt-3 text-sm text-ink-2">
          Password changed.{" "}
          <Link href="/login" className="font-semibold text-brand">
            Sign in
          </Link>
          .
        </p>
      ) : (
        <form className="mt-6 space-y-5" onSubmit={submit}>
          <Field label="New password" htmlFor="password">
            <Input
              id="password"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={12}
              autoComplete="new-password"
              required
            />
          </Field>
          {err && <ErrorState title="Could not reset password" message={err} />}
          <Button type="submit" variant="primary" className="w-full" loading={loading}>
            {loading ? "Changing…" : "Change password"}
          </Button>
        </form>
      )}
    </div>
  );
}

export default function ResetPassword() {
  // useSearchParams is request-time data; statically prerendered routes must
  // isolate it behind a Suspense boundary (the repo's verify-email page holds
  // the same pattern) so the page keeps a static shell instead of CSR-bailing
  // out and rendering blank until client JavaScript loads.
  return (
    <main className="canvas-wash min-h-screen flex items-center justify-center px-4">
      <Suspense
        fallback={
          <div className="w-full max-w-md card p-7 text-center text-sm text-ink-3">
            Loading…
          </div>
        }
      >
        <ResetPasswordContent />
      </Suspense>
    </main>
  );
}
