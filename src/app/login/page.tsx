"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, Lock } from "lucide-react";
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

  // The AppShell redirects unauthenticated console visits to
  // /login?next=<path>. Honor that destination only when it is a safe
  // in-app absolute path (starts with a single "/"), never a protocol-relative
  // or external URL — otherwise fall back to the dashboard.
  const postAuthDestination = useCallback((): string => {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    return "/dashboard";
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include", cache: "no-store" })
      .then((res) => { if (!cancelled && res.ok) router.replace(postAuthDestination()); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setCheckingSession(false); });
    return () => { cancelled = true; };
  }, [router, postAuthDestination]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Unable to sign in");
    } finally {
      setLoading(false);
    }
  }

  async function chooseWorkspace(tenantId: string) {
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/auth/select-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tenantId, selectionToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Workspace selection failed");
      router.replace(postAuthDestination()); router.refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : "Workspace selection failed"); } finally { setLoading(false); }
  }

  if (checkingSession) {
    return <div className="canvas-wash min-h-screen flex items-center justify-center px-4"><div className="flex flex-col items-center gap-4 text-center"><BrandMark size="lg" title="Yasser" subtitle="Customer portal" /><span className="text-sm text-ink-3">Checking session…</span></div></div>;
  }

  return (
    <div className="canvas-wash min-h-screen flex items-center justify-center py-12">
      <div className="container mx-auto flex max-w-md flex-col px-4">
        <BrandMark size="lg" title="Yasser" subtitle="Customer portal" />
        <div className="mt-6"><h1 className="text-2xl font-bold tracking-tight text-ink">Sign in</h1><p className="mt-1 text-sm text-ink-3">Use the email address associated with your workspace.</p></div>
        <form onSubmit={onSubmit} className="card brand-hairline mt-6 space-y-5 p-6" aria-describedby="login-help">
          <Field label="Email" htmlFor="email"><Input id="email" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required aria-invalid={err ? true : undefined} /></Field>
          <Field label="Password" htmlFor="password"><Input id="password" type="password" placeholder="Enter password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required aria-invalid={err ? true : undefined} /></Field>
          <div className="flex justify-end"><Link href="/forgot-password" className="text-sm font-semibold text-brand hover:underline">Forgot password?</Link></div>
          {err && <ErrorState title="Authentication error" message={err} />}
          {workspaces.length > 0 && <div className="rounded-xl border border-edge-accent bg-brand-subtle p-4"><div className="text-sm font-semibold text-ink">Choose a workspace</div><div className="mt-3 grid gap-2">{workspaces.map((id) => <button key={id} type="button" disabled={loading} onClick={() => void chooseWorkspace(id)} className="rounded-lg border border-edge bg-surface px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface-2">{id}</button>)}</div></div>}
          <Button variant="primary" type="submit" loading={loading} className="w-full" icon={<Lock className="h-4 w-4" />}>{loading ? "Signing in…" : "Sign in"}</Button>
          <div id="login-help" className="surface-accent flex items-start gap-2.5 rounded-xl border border-edge-accent p-3.5"><ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" aria-hidden /><p className="text-xs leading-relaxed text-ink-2">Sessions use an HttpOnly cookie and are revoked server-side. Customer accounts must verify their email before login.</p></div>
        </form>
        <p className="mt-5 text-center text-sm text-ink-3">New customer? <Link href="/signup" className="font-semibold text-brand hover:underline">Create an account</Link></p>
      </div>
    </div>
  );
}
