"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { BrandMark, Button, Field, Input, ErrorState } from "../../components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [selectionToken, setSelectionToken] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);
  const router = useRouter();

  const postAuthDestination = useCallback((): string => {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    return "/dashboard";
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include", cache: "no-store" })
      .then((res) => {
        if (!cancelled && res.ok) router.replace(postAuthDestination());
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCheckingSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router, postAuthDestination]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && Array.isArray(data.workspaces)) {
        if (typeof data.selectionToken === "string") setSelectionToken(data.selectionToken);
        setWorkspaces(data.workspaces.filter((id: unknown): id is string => typeof id === "string"));
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Unable to sign in");
      router.replace(postAuthDestination());
      router.refresh();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Unable to sign in");
    } finally {
      setLoading(false);
    }
  }

  async function chooseWorkspace(tenantId: string) {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/api/auth/select-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tenantId, selectionToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Workspace selection failed");
      router.replace(postAuthDestination());
      router.refresh();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "Workspace selection failed");
    } finally {
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <AuthShell subtitle="Customer portal">
        <div className="rounded-[14px] border border-edge bg-surface p-8 text-center shadow-card">
          <div className="flex justify-center">
            <BrandMark size="sm" showWordmark={false} />
          </div>
          <p className="mt-4 text-[13px] text-ink-3">Checking your session…</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Customer portal">
      <section className="overflow-hidden rounded-[16px] border border-edge-strong bg-surface shadow-lg">
        <div className="border-b border-edge bg-surface-2/55 px-6 py-6 sm:px-7">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Workspace access</div>
          <h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-ink">Sign in</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">Use the email address associated with your workspace.</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5 p-6 sm:p-7">
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" placeholder="Enter password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>

          <div className="flex justify-end">
            <Link href="/forgot-password" className="text-[12.5px] font-semibold text-brand transition hover:text-brand-hover hover:underline">
              Forgot password?
            </Link>
          </div>

          {err && <ErrorState title="Authentication error" message={err} />}

          {workspaces.length > 0 && (
            <div className="rounded-[12px] border border-edge-accent bg-brand-subtle p-4">
              <div className="text-[13px] font-semibold text-ink">Choose a workspace</div>
              <div className="mt-3 grid gap-2">
                {workspaces.map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={loading}
                    onClick={() => void chooseWorkspace(id)}
                    className="flex min-h-10 items-center justify-between rounded-[9px] border border-edge bg-surface px-3.5 text-left text-[12.5px] font-semibold text-ink transition hover:border-edge-accent hover:bg-surface-2 disabled:opacity-50"
                  >
                    <span className="truncate">{id}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-ink-4" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <Button variant="primary" type="submit" loading={loading} className="w-full" icon={<ArrowRight className="h-4 w-4" />}>
            {loading ? "Signing in…" : "Continue"}
          </Button>

          <div className="flex items-start gap-2.5 rounded-[11px] border border-edge bg-surface-2 px-3.5 py-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              Sessions use an HttpOnly cookie and are enforced server-side. Email verification is required before customer login.
            </p>
          </div>
        </form>
      </section>

      <p className="mt-5 text-center text-[12.5px] text-ink-3">
        New customer? <Link href="/signup" className="font-semibold text-brand hover:underline">Create an account</Link>
      </p>
    </AuthShell>
  );
}
