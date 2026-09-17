"use client";

import { useEffect, useState } from "react";
import { CreditCard, Search, RefreshCw, CheckCircle, AlertTriangle, Clock } from "lucide-react";

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
        if (!ignore) {
          setSubscriptions(data.subscriptions || []);
          setError(null);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Error loading subscriptions");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    load();
    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  function handleRefresh() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  const filtered = subscriptions.filter(
    (s) =>
      s.tenantName.toLowerCase().includes(search.toLowerCase()) ||
      s.tenantId.toLowerCase().includes(search.toLowerCase()) ||
      (s.stripeCustomerId && s.stripeCustomerId.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
            <CreditCard className="w-6 h-6 text-blue-400" />
            Platform Subscriptions Overview
          </h1>
          <p className="text-sm text-slate-400 mt-1">Global SaaS plans, Stripe customer mapping, and billing status.</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-sm font-medium transition self-start sm:self-auto"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh Subscriptions
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Filter Bar */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by tenant name, ID, or Stripe customer ID..."
          className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Subscriptions Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/70 text-xs uppercase font-semibold text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">Tenant</th>
                <th className="px-5 py-3.5">Plan</th>
                <th className="px-5 py-3.5">Billing Status</th>
                <th className="px-5 py-3.5">Stripe Customer</th>
                <th className="px-5 py-3.5">Period End</th>
                <th className="px-5 py-3.5">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-500 text-sm">
                    No subscriptions found.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.tenantId} className="hover:bg-slate-850/50 transition">
                    <td className="px-5 py-4">
                      <div className="font-semibold text-white">{s.tenantName}</div>
                      <div className="text-xs font-mono text-slate-500 mt-0.5">{s.tenantId}</div>
                    </td>
                    <td className="px-5 py-4 font-medium text-slate-200">
                      {s.planName}
                    </td>
                    <td className="px-5 py-4">
                      {s.status === "active" ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                          <CheckCircle className="w-3 h-3" />
                          Active
                        </span>
                      ) : s.status === "trialing" ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400">
                          <Clock className="w-3 h-3" />
                          Trialing
                        </span>
                      ) : s.status === "past_due" ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-400">
                          <AlertTriangle className="w-3 h-3" />
                          Past Due
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-500/10 border border-slate-500/20 text-slate-400">
                          {s.status}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-xs font-mono text-slate-400">
                      {s.stripeCustomerId || "Unlinked (Trial)"}
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-400 whitespace-nowrap">
                      {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "N/A"}
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-400 whitespace-nowrap">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
