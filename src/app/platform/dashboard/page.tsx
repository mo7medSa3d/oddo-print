"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, CreditCard, Users, Printer, Activity, AlertTriangle, ShieldCheck, ArrowRight, RefreshCw } from "lucide-react";

type Stats = {
  tenants: { total: number; active: number; suspended: number; deleted: number };
  subscriptions: { total: number; active: number; trialing: number; pastDue: number; cancelled: number };
  users: { total: number; verified: number };
  agents: { total: number; online: number; offline: number };
  printers: { total: number; online: number; offline: number };
  jobs24h: { total: number; success: number; failed: number; queued: number };
};

export default function PlatformDashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/stats");
        if (ignore) return;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            router.push("/platform/login");
            return;
          }
          throw new Error("Failed to load platform metrics");
        }
        const data = await res.json();
        if (!ignore) {
          setStats(data);
          setError(null);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Error loading stats");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    load();
    return () => {
      ignore = true;
    };
  }, [router, reloadKey]);

  function handleRefresh() {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Platform Overview</h1>
          <p className="text-sm text-slate-400 mt-1">Real-time control plane metrics and operational health.</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-sm font-medium transition"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Tenants Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Tenants</span>
            <Building2 className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="text-3xl font-bold text-white">{stats?.tenants.total ?? 0}</div>
          <div className="flex items-center gap-3 text-xs text-slate-400 pt-1 border-t border-slate-800/60">
            <span className="text-emerald-400 font-medium">{stats?.tenants.active ?? 0} Active</span>
            <span>•</span>
            <span className="text-amber-400 font-medium">{stats?.tenants.suspended ?? 0} Suspended</span>
          </div>
        </div>

        {/* Subscriptions Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Subscriptions</span>
            <CreditCard className="w-5 h-5 text-blue-400" />
          </div>
          <div className="text-3xl font-bold text-white">{stats?.subscriptions.total ?? 0}</div>
          <div className="flex items-center gap-3 text-xs text-slate-400 pt-1 border-t border-slate-800/60">
            <span className="text-emerald-400 font-medium">{stats?.subscriptions.active ?? 0} Active</span>
            <span>•</span>
            <span className="text-blue-400 font-medium">{stats?.subscriptions.trialing ?? 0} Trialing</span>
          </div>
        </div>

        {/* System Users Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">System Users</span>
            <Users className="w-5 h-5 text-violet-400" />
          </div>
          <div className="text-3xl font-bold text-white">{stats?.users.total ?? 0}</div>
          <div className="flex items-center gap-3 text-xs text-slate-400 pt-1 border-t border-slate-800/60">
            <span className="text-slate-300 font-medium">{stats?.users.verified ?? 0} Email Verified</span>
          </div>
        </div>

        {/* Print Jobs 24h Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Jobs (24h)</span>
            <Activity className="w-5 h-5 text-cyan-400" />
          </div>
          <div className="text-3xl font-bold text-white">{stats?.jobs24h.total ?? 0}</div>
          <div className="flex items-center gap-3 text-xs text-slate-400 pt-1 border-t border-slate-800/60">
            <span className="text-emerald-400 font-medium">{stats?.jobs24h.success ?? 0} Success</span>
            <span>•</span>
            <span className="text-red-400 font-medium">{stats?.jobs24h.failed ?? 0} Failed</span>
          </div>
        </div>
      </div>

      {/* Operational Infrastructure & System Health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hardware & Agent Status */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Printer className="w-4 h-4 text-indigo-400" />
            Infrastructure Fleet Status
          </h2>
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-4">
              <div className="text-xs font-semibold text-slate-400 uppercase">Agents</div>
              <div className="text-2xl font-bold text-white mt-1">{stats?.agents.total ?? 0}</div>
              <div className="mt-2 text-xs text-slate-400 flex items-center justify-between">
                <span className="text-emerald-400 font-medium">{stats?.agents.online ?? 0} Online</span>
                <span className="text-slate-500">{stats?.agents.offline ?? 0} Offline</span>
              </div>
            </div>
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-4">
              <div className="text-xs font-semibold text-slate-400 uppercase">Printers</div>
              <div className="text-2xl font-bold text-white mt-1">{stats?.printers.total ?? 0}</div>
              <div className="mt-2 text-xs text-slate-400 flex items-center justify-between">
                <span className="text-emerald-400 font-medium">{stats?.printers.online ?? 0} Online</span>
                <span className="text-slate-500">{stats?.printers.offline ?? 0} Offline</span>
              </div>
            </div>
          </div>
        </div>

        {/* Operational Alerts & System Status */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            Platform Alerts & Actions
          </h2>
          <div className="space-y-3">
            {(stats?.tenants.suspended ?? 0) > 0 ? (
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center justify-between text-xs text-amber-400">
                <span>{stats?.tenants.suspended} tenant(s) currently suspended.</span>
                <Link href="/platform/tenants" className="underline font-semibold hover:text-amber-300">Review Tenants</Link>
              </div>
            ) : (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center gap-2 text-xs text-emerald-400">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                All active tenant lifecycles operating normally.
              </div>
            )}

            {(stats?.subscriptions.pastDue ?? 0) > 0 && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between text-xs text-red-400">
                <span>{stats?.subscriptions.pastDue} subscription(s) in past_due billing state.</span>
                <Link href="/platform/subscriptions" className="underline font-semibold hover:text-red-300">View Subscriptions</Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Access Links */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          href="/platform/tenants"
          className="group p-5 bg-slate-900 hover:bg-slate-800/80 border border-slate-800 rounded-xl transition flex items-center justify-between"
        >
          <div>
            <div className="font-semibold text-white group-hover:text-indigo-400 transition">Manage Tenants</div>
            <div className="text-xs text-slate-400 mt-0.5">Directory, suspension, & reactivation</div>
          </div>
          <ArrowRight className="w-5 h-5 text-slate-500 group-hover:text-indigo-400 transition" />
        </Link>

        <Link
          href="/platform/subscriptions"
          className="group p-5 bg-slate-900 hover:bg-slate-800/80 border border-slate-800 rounded-xl transition flex items-center justify-between"
        >
          <div>
            <div className="font-semibold text-white group-hover:text-blue-400 transition">View Subscriptions</div>
            <div className="text-xs text-slate-400 mt-0.5">Global SaaS plans & Stripe billing state</div>
          </div>
          <ArrowRight className="w-5 h-5 text-slate-500 group-hover:text-blue-400 transition" />
        </Link>

        <Link
          href="/platform/audit"
          className="group p-5 bg-slate-900 hover:bg-slate-800/80 border border-slate-800 rounded-xl transition flex items-center justify-between"
        >
          <div>
            <div className="font-semibold text-white group-hover:text-emerald-400 transition">System Audit Feed</div>
            <div className="text-xs text-slate-400 mt-0.5">Platform-wide audit events stream</div>
          </div>
          <ArrowRight className="w-5 h-5 text-slate-500 group-hover:text-emerald-400 transition" />
        </Link>
      </div>
    </div>
  );
}
