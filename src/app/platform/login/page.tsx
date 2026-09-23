"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2, ShieldCheck } from "lucide-react";
import { AuthShell } from "../../../components/AuthShell";
import { Button, ErrorState, Field, Input } from "../../../components/ui";

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/platform/auth/me", { credentials: "include", cache: "no-store" })
      .then((res) => {
        if (!cancelled && res.ok) router.replace("/platform/dashboard");
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Authentication failed");
      router.push("/platform/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <AuthShell subtitle="Platform Control Plane">
        <div className="rounded-[14px] border border-edge bg-surface p-8 text-center shadow-card" aria-busy="true">
          <div className="flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-brand" />
          </div>
          <p className="mt-4 text-[12px] text-ink-3">Checking your session…</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Platform Control Plane">
      <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-lg">
        <div className="border-b border-edge bg-surface-2/55 px-6 py-6 sm:px-7">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Platform administration</div>
          <h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-ink">Platform sign in</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
            Manage tenants, plans, subscriptions, and platform audit data.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6 sm:p-7">
          {error && <ErrorState title="Authentication error" message={error} />}

          <Field label="Platform owner email" htmlFor="platform-email">
            <Input
              id="platform-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@platform.local"
              autoComplete="username"
            />
          </Field>

          <Field label="Password" htmlFor="platform-password">
            <Input
              id="platform-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
            />
          </Field>

          <Button
            variant="primary"
            type="submit"
            loading={loading}
            className="w-full"
            icon={<Lock className="h-4 w-4" />}
          >
            {loading ? "Signing in…" : "Sign in to platform"}
          </Button>

          <div className="flex items-start gap-2.5 rounded-[11px] border border-edge bg-surface-2 px-3.5 py-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              This portal is restricted to authorized Platform Owners. Platform routes enforce the session independently.
            </p>
          </div>
        </form>
      </section>

      <p className="mt-5 text-center text-[12.5px] text-ink-3">
        Authorized platform administration only.
      </p>
    </AuthShell>
  );
}
