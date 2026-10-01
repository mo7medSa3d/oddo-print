"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { AuthShell } from "../../../components/AuthShell";
import { Button, Field, Input, ErrorState, Skeleton } from "../../../components/ui";

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/platform/auth/me", { credentials: "include", cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          router.replace("/platform/dashboard");
          return;
        }
        const refresh = await fetch("/api/platform/auth/refresh", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });
        if (!cancelled && refresh.ok) router.replace("/platform/dashboard");
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
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Authentication failed");
      }

      router.replace("/platform/dashboard");
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <AuthShell subtitle="Platform Administration">
        <div className="space-y-4" role="status" aria-label="Checking your session">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-60" />
          <Skeleton className="mt-6 h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <span className="sr-only">Checking your session…</span>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      subtitle="Platform Administration"
      eyebrow="Platform access"
      title="Sign in"
      description="Platform Owner credentials manage tenants, plans and subscriptions."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Platform owner email" htmlFor="platform-email" required>
          <Input
            id="platform-email"
            type="email"
            placeholder="admin@platform.local"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            required
          />
        </Field>

        <Field label="Password" htmlFor="platform-password" required>
          <Input
            id="platform-password"
            type="password"
            placeholder="Enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        {error && <ErrorState title="Couldn’t sign you in" message={error} />}

        <Button
          variant="primary"
          type="submit"
          loading={loading}
          className="w-full"
          size="lg"
          icon={loading ? undefined : <ArrowRight className="h-4 w-4" />}
        >
          {loading ? "Signing in…" : "Continue"}
        </Button>

        <div className="flex items-start gap-2.5 rounded-sg border border-edge-strong bg-surface px-3.5 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <p className="text-sm leading-relaxed text-ink-3">
            Restricted to authorized Platform Owners. Control-plane access uses a separate
            server-side session with a shorter lifetime.
          </p>
        </div>
      </form>
    </AuthShell>
  );
}
