"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Callout, Field, Input, ErrorState, Skeleton } from "../../components/ui";

function ResetPasswordContent() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErr(typeof data.error === "string" ? data.error : "Reset failed");
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
    <AuthShell
      subtitle="Account recovery"
      eyebrow="Account recovery"
      title="Choose a new password"
      description="This replaces the password for your Yaseir account immediately."
    >
      {done ? (
        <Callout tone="ok" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} title="Password updated">
          Taking you to sign in…{" "}
          <Link href="/login" className="font-[600] underline">
            Continue now
          </Link>
          .
        </Callout>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field
            label="New password"
            htmlFor="password"
            hint="At least 12 characters."
            required
          >
            <Input
              id="password"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={12}
              autoComplete="new-password"
              autoFocus
              required
            />
          </Field>

          {err && <ErrorState title="Couldn’t reset the password" message={err} />}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            size="lg"
            loading={loading}
            icon={loading ? undefined : <ArrowRight className="h-4 w-4" />}
          >
            {loading ? "Updating…" : "Update password"}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export default function ResetPassword() {
  return (
    <Suspense
      fallback={
        <AuthShell subtitle="Account recovery">
          <div className="space-y-4" role="status" aria-label="Loading">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="mt-6 h-10 w-full" />
            <Skeleton className="h-11 w-full" />
            <span className="sr-only">Loading…</span>
          </div>
        </AuthShell>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}
