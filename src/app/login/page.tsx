"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Building2, ShieldCheck } from "lucide-react";
import { AuthShell } from "../../components/AuthShell";
import { Button, Field, Input, ErrorState, Skeleton } from "../../components/ui";

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
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          router.replace(postAuthDestination());
          return;
        }
        const refresh = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });
        if (!cancelled && refresh.ok) router.replace(postAuthDestination());
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
      <AuthShell subtitle="Yaseir Print Gateway">
        <div className="space-y-4" role="status" aria-label="Checking your session">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-64" />
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
      subtitle="Yaseir Print Gateway"
      eyebrow="Workspace access"
      title="Sign in"
      description="Use the email address associated with your Yaseir workspace."
      footer={
        <>
          Need an account?{" "}
          <Link href="/signup" className="font-[600] text-brand hover:text-brand-hover hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            required
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          actions={
            <Link
              href="/forgot-password"
              className="text-sm font-[550] text-ink-3 transition-colors hover:text-brand"
            >
              Forgot password?
            </Link>
          }
        >
          <Input
            id="password"
            type="password"
            placeholder="Enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        {err && <ErrorState title="Couldn’t sign you in" message={err} />}

        {workspaces.length > 0 && (
          <div className="rounded-lg border border-edge-accent bg-brand-subtle p-4">
            <div className="flex items-center gap-2 text-sm font-[600] text-ink">
              <Building2 className="h-4 w-4 text-brand" aria-hidden />
              Choose a workspace
            </div>
            <p className="mt-1 text-sm text-ink-2">
              This account belongs to more than one workspace.
            </p>
            <div className="mt-3 grid gap-2">
              {workspaces.map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={loading}
                  onClick={() => void chooseWorkspace(id)}
                  className="flex min-h-10 items-center justify-between gap-3 rounded-sm border border-edge bg-surface px-3.5 text-left text-sm font-[550] text-ink transition-colors duration-[140ms] hover:border-edge-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50"
                >
                  <span className="truncate">{id}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        )}

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

        <div className="flex items-start gap-2.5 rounded-lg border border-edge-subtle bg-surface-2 px-3.5 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <p className="text-sm leading-relaxed text-ink-3">
            Sessions are protected server-side. Email verification is required before sign-in.
          </p>
        </div>
      </form>
    </AuthShell>
  );
}
