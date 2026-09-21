"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Field, Input, ErrorState } from "../../components/ui";

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
    <AuthShell subtitle="Account recovery">
      <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-lg">
        <div className="border-b border-edge bg-surface-2/55 px-6 py-6">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Account recovery</div>
          <h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-ink">Reset password</h1>
        </div>
        <div className="p-6 sm:p-7">
          {done ? (
            <div className="rounded-[11px] border border-ok-edge bg-ok-bg p-4 text-[13px] leading-relaxed text-ok">
              Password changed. <Link href="/login" className="font-semibold underline">Sign in</Link>.
            </div>
          ) : (
            <form className="space-y-5" onSubmit={submit}>
              <Field label="New password" htmlFor="password" hint="Use at least 12 characters.">
                <Input id="password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={12} autoComplete="new-password" required />
              </Field>
              {err && <ErrorState title="Could not reset password" message={err} />}
              <Button type="submit" variant="primary" className="w-full" loading={loading} icon={<ArrowRight className="h-4 w-4" />}>
                {loading ? "Changing…" : "Change password"}
              </Button>
            </form>
          )}
        </div>
      </section>
    </AuthShell>
  );
}

export default function ResetPassword() {
  return (
    <Suspense fallback={
      <AuthShell subtitle="Account recovery">
        <div className="rounded-[14px] border border-edge bg-surface p-8 text-center text-[13px] text-ink-3 shadow-card">Loading…</div>
      </AuthShell>
    }>
      <ResetPasswordContent />
    </Suspense>
  );
}
