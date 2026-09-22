"use client";

import { useEffect, useState } from "react";
import { CreditCard, Search, RefreshCw, CheckCircle, AlertTriangle, Clock, ShieldAlert } from "lucide-react";

type Subscription = {
  tenantId: string;
  tenantName: string;
  tenantLifecycle: string;
  planId: string;
  planName: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: "trialing" | "active" | "past_due" | "paused" | "cancelled";
  currentPeriodEnd: string | null;
  trialStartedAt: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
};

export default function PlatformSubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/subscriptions");
        if (ignore) return;
        if (!res.ok) throw new Error("Failed to fetch platform subscriptions");
        const data = await res.json();
        if (!ignore) { setSubscriptions(data.subscriptions || []); setError(null); }
      } catch (err: unknown) {
        if (!ignore) setError(err instanceof Error ? err.message : "Error loading subscriptions");
      } finally { if (!ignore) setLoading(false); }
    }
    load();
    return () => { ignore = true; };
  }, [reloadKey]);

  function handleRefresh() { setLoading(true); setReloadKey((k) => k + 1); }

  const filtered = subscriptions.filter(
    (s) =>
      s.tenantName.toLowerCase().includes(search.toLowerCase()) ||
      s.tenantId.toLowerCase().includes(search.toLowerCase()) ||
      (s.stripeCustomerId && s.stripeCustomerId.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <ShieldAlert className="h-3.5 w-3.5" /> Control Plane • Billing
          </div>
          <h1 className="mt-4 flex items-center gap-2.5 text-[26px] font-bold tracking-[-0.02em] text-white leading-tight">
            <CreditCard className="h-6 w-6 text-blue-400" /> Subscriptions
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-400">Global SaaS plans, Stripe customer mapping, and billing states — Stripe source of truth.</p>
        </div>
        <button onClick={handleRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-[13px] font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white transition disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="rounded-[12px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">{error}</div>}

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by tenant name, ID, or Stripe customer ID…" className="w-full rounded-[12px] border border-white/[0.08] bg-[#12141f] py-2.5 pl-10 pr-4 text-[13px] text-slate-100 placeholder-slate-500 outline-none focus:border-blue-500/30 focus:ring-2 focus:ring-blue-500/15" />
      </div>

      <div className="overflow-hidden rounded-[14px] border border-white/[0.06] bg-[#12141f]">
        <div className="border-b border-white/[0.06] px-5 py-4">
          <h2 className="text-[13px] font-semibold text-white">Subscriptions • {filtered.length}</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">Stripe billing states • cancel_at_period_end honored • no fake values</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-[13px] text-slate-300">
            <thead className="border-b border-white/[0.06] bg-[#0c0e1a] text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr><th className="px-5 py-3">Tenant</th><th className="px-5 py-3">Plan</th><th className="px-5 py-3">Billing Status</th><th className="px-5 py-3">Stripe Customer</th><th className="px-5 py-3">Period End</th><th className="px-5 py-3">Created</th></tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center text-[13px] text-slate-500">No subscriptions found.</td></tr>
              ) : filtered.map((s) => (
                <tr key={s.tenantId} className="hover:bg-white/[0.02] transition">
                  <td className="px-5 py-4"><div className="font-semibold text-white text-[13px]">{s.tenantName}</div><div className="mt-1 font-mono text-[11px] text-slate-500">{s.tenantId}</div></td>
                  <td className="px-5 py-4 text-[12px] font-medium text-slate-200">{s.planName}</td>
                  <td className="px-5 py-4">
                    {s.status === "active" ? <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300"><CheckCircle className="h-3 w-3" /> Active</span> : s.status === "trialing" ? <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-300"><Clock className="h-3 w-3" /> Trialing</span> : s.status === "past_due" ? <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300"><AlertTriangle className="h-3 w-3" /> Past Due</span> : <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-400">{s.status}</span>}
                  </td>
                  <td className="px-5 py-4 font-mono text-[11px] text-slate-400">{s.stripeCustomerId || "Unlinked (Trial)"}</td>
                  <td className="px-5 py-4 text-[11px] text-slate-400">{s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "N/A"}</td>
                  <td className="px-5 py-4 text-[11px] text-slate-500">{new Date(s.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
