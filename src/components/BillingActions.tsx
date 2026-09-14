"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function post(path: string) {
  const res = await fetch(path, { method: "POST", credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Billing request failed");
  return data;
}

export function BillingActions({ hasSubscription, cancelAtPeriodEnd }: { hasSubscription: boolean; cancelAtPeriodEnd: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Billing request failed"); } finally { setBusy(""); }
  };
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={!hasSubscription || !!busy} onClick={() => run("portal", async () => { const d = await post("/api/billing/portal"); window.location.href = d.url; })} className="rounded-lg border border-edge px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy === "portal" ? "Opening…" : "Customer Portal"}</button>
      {hasSubscription && !cancelAtPeriodEnd && <button type="button" disabled={!!busy} onClick={() => run("cancel", async () => { await post("/api/billing/cancel"); router.refresh(); })} className="rounded-lg border border-edge px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy === "cancel" ? "Updating…" : "Cancel at period end"}</button>}
      {hasSubscription && cancelAtPeriodEnd && <button type="button" disabled={!!busy} onClick={() => run("resume", async () => { await post("/api/billing/resume"); router.refresh(); })} className="rounded-lg border border-edge px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy === "resume" ? "Updating…" : "Resume subscription"}</button>}
    </div>
    {error && <p className="text-sm text-bad">{error}</p>}
  </div>;
}
