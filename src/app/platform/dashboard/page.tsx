"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, CreditCard, Users, Printer, Activity, AlertTriangle, ShieldCheck, ArrowRight, RefreshCw, Cpu, TrendingUp, Layers } from "lucide-react";

type Stats = {
  tenants: { total: number; active: number; suspended: number; deleted: number };
  subscriptions: { total: number; active: number; trialing: number; pastDue: number; cancelled: number };
  users: { total: number; verified: number };
  agents: { total: number; online: number; offline: number };
  printers: { total: number; online: number; offline: number };
  jobs24h: { total: number; success: number; failed: number; queued: number };
};

function KpiCard({ label, value, sub, icon, accent }: { label: string; value: number; sub: React.ReactNode; icon: React.ReactNode; accent: string }) {
  return (
    <div className="group relative overflow-hidden rounded-[14px] border border-white/[0.06] bg-[#12151b] p-5 transition-all hover:border-white/[0.10] hover:bg-[#151725]">
      <div className={`absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r ${accent} opacity-60`} />
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-white/[0.04] border border-white/[0.06] text-slate-400 group-hover:text-white transition">{icon}</span>
      </div>
      <div className="mt-4 text-[30px] font-bold tracking-tight text-white tabular-nums leading-none">{value}</div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500 border-t border-white/[0.04] pt-3">{sub}</div>
    </div>
  );
}

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
          if (res.status === 401 || res.status === 403) { router.push("/platform/login"); return; }
          throw new Error("Failed to load platform metrics");
        }
        const data = await res.json();
        if (!ignore) { setStats(data); setError(null); }
      } catch (err: unknown) {
        if (!ignore) setError(err instanceof Error ? err.message : "Error loading stats");
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    load();
    return () => { ignore = true; };
  }, [router, reloadKey]);

  function handleRefresh() { setLoading(true); setReloadKey((k) => k + 1); }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Control plane • Live
          </div>
          <h1 className="mt-4 text-[28px] font-bold tracking-[-0.02em] text-white leading-tight">Platform overview</h1>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-slate-400">Real-time metrics, fleet health, and operational risk — Stripe is billing source of truth, Gateway enforces entitlements.</p>
        </div>
        <button onClick={handleRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-[13px] font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white transition disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="rounded-[12px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">{error}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Tenants" value={stats?.tenants.total ?? 0} icon={<Building2 className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<><span className="text-emerald-400 font-medium">{stats?.tenants.active ?? 0} active</span><span className="text-slate-600">•</span><span className="text-amber-400">{stats?.tenants.suspended ?? 0} suspended</span></>} />
        <KpiCard label="Subscriptions" value={stats?.subscriptions.total ?? 0} icon={<CreditCard className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<><span className="text-emerald-400 font-medium">{stats?.subscriptions.active ?? 0} active</span><span className="text-slate-600">•</span><span className="text-brand-400">{stats?.subscriptions.trialing ?? 0} trialing</span></>} />
        <KpiCard label="Users" value={stats?.users.total ?? 0} icon={<Users className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<span className="text-slate-300">{stats?.users.verified ?? 0} verified • {stats?.users.total ? Math.round((stats.users.verified / stats.users.total) * 100) : 0}%</span>} />
        <KpiCard label="Jobs 24h" value={stats?.jobs24h.total ?? 0} icon={<Activity className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<><span className="text-emerald-400 font-medium">{stats?.jobs24h.success ?? 0} success</span><span className="text-slate-600">•</span><span className="text-red-400">{stats?.jobs24h.failed ?? 0} failed</span></>} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7 rounded-[14px] border border-white/[0.06] bg-[#12151b] p-6">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white"><Cpu className="h-4 w-4 text-brand-400" /> Fleet health</h2>
            <span className="text-[11px] text-slate-500">Last 24h queue depth</span>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="rounded-[12px] border border-white/[0.06] bg-[#0b0e13] p-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Agents</span>
                <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-white/[0.04] text-slate-400"><Cpu className="h-3.5 w-3.5" /></span>
              </div>
              <div className="mt-3 text-[24px] font-bold text-white tabular-nums">{stats?.agents.total ?? 0}</div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-emerald-400" style={{ width: `${stats?.agents.total ? Math.round(((stats.agents.online ?? 0) / stats.agents.total) * 100) : 0}%` }} />
              </div>
              <div className="mt-2 flex justify-between text-[11px]"><span className="text-emerald-400">{stats?.agents.online ?? 0} online</span><span className="text-slate-500">{stats?.agents.offline ?? 0} offline</span></div>
            </div>
            <div className="rounded-[12px] border border-white/[0.06] bg-[#0b0e13] p-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Printers</span>
                <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-white/[0.04] text-slate-400"><Printer className="h-3.5 w-3.5" /></span>
              </div>
              <div className="mt-3 text-[24px] font-bold text-white tabular-nums">{stats?.printers.total ?? 0}</div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-brand-400" style={{ width: `${stats?.printers.total ? Math.round(((stats.printers.online ?? 0) / stats.printers.total) * 100) : 0}%` }} />
              </div>
              <div className="mt-2 flex justify-between text-[11px]"><span className="text-brand-300">{stats?.printers.online ?? 0} online</span><span className="text-slate-500">{stats?.printers.offline ?? 0} offline</span></div>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-5">
            <div className="text-center"><div className="text-[11px] text-slate-500">Queued</div><div className="mt-1 text-[16px] font-semibold text-white tabular-nums">{stats?.jobs24h.queued ?? 0}</div></div>
            <div className="text-center border-x border-white/[0.06]"><div className="text-[11px] text-slate-500">Success</div><div className="mt-1 text-[16px] font-semibold text-emerald-400 tabular-nums">{stats?.jobs24h.success ?? 0}</div></div>
            <div className="text-center"><div className="text-[11px] text-slate-500">Failed</div><div className="mt-1 text-[16px] font-semibold text-red-400 tabular-nums">{stats?.jobs24h.failed ?? 0}</div></div>
          </div>
        </div>

        <div className="lg:col-span-5 space-y-4">
          <div className="rounded-[14px] border border-white/[0.06] bg-[#12151b] p-6">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white"><AlertTriangle className="h-4 w-4 text-amber-400" /> Risk & alerts</h2>
            <div className="mt-5 space-y-3">
              {(stats?.tenants.suspended ?? 0) > 0 ? (
                <div className="flex items-center justify-between rounded-[10px] border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-[12px] text-amber-300">
                  <span>{stats?.tenants.suspended} tenant(s) suspended — requires review</span>
                  <Link href="/platform/tenants" className="font-semibold underline hover:text-amber-200">Review</Link>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-[10px] border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-[12px] text-emerald-300"><ShieldCheck className="h-4 w-4" /> All tenant lifecycles normal</div>
              )}
              {(stats?.subscriptions.pastDue ?? 0) > 0 && (
                <div className="flex items-center justify-between rounded-[10px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[12px] text-red-300">
                  <span>{stats?.subscriptions.pastDue} past_due billing — Stripe action needed</span>
                  <Link href="/platform/subscriptions" className="font-semibold underline hover:text-red-200">View</Link>
                </div>
              )}
              <div className="rounded-[10px] border border-white/[0.06] bg-[#0b0e13] p-4">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500"><TrendingUp className="h-3.5 w-3.5" /> Operational notes</div>
                <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-slate-400">
                  <li>• Entitlements enforced server-side, not UI-only</li>
                  <li>• Tenant isolation: WS, API, DB queries scoped</li>
                  <li>• No fake dashboard numbers — real backend counts only</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <Link href="/platform/tenants" className="group flex items-center justify-between rounded-[12px] border border-white/[0.06] bg-[#12151b] p-4 transition hover:border-white/[0.10] hover:bg-[#151725]">
              <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white/[0.05] border border-white/[0.10] text-brand-300"><Building2 className="h-4 w-4" /></span><div><div className="text-[13px] font-semibold text-white group-hover:text-brand-300">Tenants</div><div className="text-[11px] text-slate-500">Lifecycle & suspension</div></div></div><ArrowRight className="h-4 w-4 text-slate-600 group-hover:text-white transition" />
            </Link>
            <Link href="/platform/subscriptions" className="group flex items-center justify-between rounded-[12px] border border-white/[0.06] bg-[#12151b] p-4 transition hover:border-white/[0.10] hover:bg-[#151725]">
              <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-500/10 border border-brand-500/20 text-brand-300"><CreditCard className="h-4 w-4" /></span><div><div className="text-[13px] font-semibold text-white group-hover:text-brand-300">Subscriptions</div><div className="text-[11px] text-slate-500">Stripe & billing states</div></div></div><ArrowRight className="h-4 w-4 text-slate-600 group-hover:text-white transition" />
            </Link>
            <Link href="/platform/audit" className="group flex items-center justify-between rounded-[12px] border border-white/[0.06] bg-[#12151b] p-4 transition hover:border-white/[0.10] hover:bg-[#151725]">
              <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"><Layers className="h-4 w-4" /></span><div><div className="text-[13px] font-semibold text-white group-hover:text-emerald-300">Audit feed</div><div className="text-[11px] text-slate-500">Platform events stream</div></div></div><ArrowRight className="h-4 w-4 text-slate-600 group-hover:text-white transition" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
