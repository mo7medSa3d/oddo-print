"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, Lock, Loader2 } from "lucide-react";

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

  if (checkingSession) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-100">
        <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
        <span className="mt-3 text-sm text-slate-400">Checking session…</span>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Authentication failed");
      }

      router.push("/platform/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <main className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2 text-center">
            <div className="mb-2 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-400/20 bg-indigo-500/10 text-indigo-300">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Platform Control Plane</h1>
            <p className="text-sm text-slate-400">Global administration and security sign in</p>
          </div>

          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/20"
          >
            {error && (
              <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-300">
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Platform Owner Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@platform.local"
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-950/40 transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Authenticating...
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4" />
                  Sign In to Platform
                </>
              )}
            </button>
          </form>

          <p className="text-center text-xs text-slate-500">
            This portal is restricted to authorized Platform Owners only.
          </p>
        </div>
      </main>

      <footer className="border-t border-slate-800 bg-slate-950">
        <div className="mx-auto flex min-h-14 max-w-7xl items-center justify-center px-4 py-4 text-xs text-slate-600">
          © 2026 Yasser · Platform Control Plane
        </div>
      </footer>
    </div>
  );
}
