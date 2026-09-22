"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2, ShieldCheck } from "lucide-react";
import { BrandMark } from "../../../components/brand";
import { ThemeToggle } from "../../../components/ThemeToggle";

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
    return () => { cancelled = true; };
  }, [router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      <main className="flex min-h-screen items-center justify-center bg-[var(--platform-bg)] text-[var(--platform-muted)]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-brand-400" />
          <span className="text-[12px]">Checking session…</span>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--platform-bg)] px-4 py-10 text-ink">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute left-1/2 top-[-260px] h-[420px] w-[680px] -translate-x-1/2 rounded-full bg-[var(--glow)] blur-3xl" />
      </div>
      <div className="absolute right-4 top-4 z-20">
        <ThemeToggle />
      </div>

      <div className="relative z-10 w-full max-w-[430px]">
        <div className="mb-7 flex justify-center">
          <BrandMark size="lg" title="Yasser" subtitle="Platform Control Plane" variant="inverted" />
        </div>

        <section className="overflow-hidden rounded-[16px] border border-[var(--platform-border)] bg-[var(--platform-surface)] shadow-2xl">
          <div className="border-b border-[var(--platform-border)] px-6 py-6 sm:px-7">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Restricted administration</div>
            <h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-ink">Platform sign in</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">Control tenants, plans, subscriptions and platform audit data.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6 p-6 sm:p-7">
            {error && (
              <div role="alert" className="rounded-xl border border-bad-edge bg-bad-bg px-3.5 py-3 text-[12.5px] text-bad">
                {error}
              </div>
            )}

            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Platform owner email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@platform.local"
                className="mt-2 h-11 w-full rounded-xl border border-[var(--platform-border)] bg-[var(--platform-bg)] px-3.5 text-[13px] text-ink placeholder:text-ink-4 outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
              />
            </label>

            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Password</span>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="mt-2 h-11 w-full rounded-xl border border-[var(--platform-border)] bg-[var(--platform-bg)] px-3.5 text-[13px] text-ink placeholder:text-ink-4 outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
              />
            </label>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brand px-4 text-[13.5px] font-semibold text-white shadow-sm transition hover:bg-brand-hover hover:shadow-md disabled:cursor-default disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              {loading ? "Authenticating…" : "Sign in to platform"}
            </button>

            <div className="flex items-start gap-2.5 rounded-[11px] border border-[var(--platform-border)] bg-[var(--platform-bg)] px-3.5 py-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />
              <p className="text-[11px] leading-relaxed text-ink-3">
                This portal is restricted to authorized Platform Owners. Platform routes enforce the session independently.
              </p>
            </div>
          </form>
        </section>

        <p className="mt-5 text-center text-[11px] text-ink-4">Yasser · Platform Control Plane</p>
      </div>
    </main>
  );
}
