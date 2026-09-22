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
    <div className="group relative overflow-hidden rounded-[14px] border border-edge bg-surface p-5 transition-all hover:border-edge-strong hover:bg-surface-hover">
      <div className={`absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r ${accent} opacity-60`} />
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-surface-2 border border-edge text-ink-3 group-hover:text-ink transition">{icon}</span>
      </div>
      <div className="mt-4 text-[30px] font-bold tracking-tight text-ink tabular-nums leading-none">{value}</div>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-4 border-t border-edge-subtle pt-3">{sub}</div>
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
          <div className="inline-flex items-center gap-2 rounded-full border border-edge-strong bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            <span className="h-1.5 w-1.5 rounded-full bg-ok-solid animate-pulse" /> Control plane • Live
          </div>
          <h1 className="mt-4 text-[28px] font-bold tracking-[-0.02em] text-ink leading-tight">Platform overview</h1>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-3">Real-time metrics, fleet health, and operational risk — Stripe is billing source of truth, Gateway enforces entitlements.</p>
        </div>
        <button onClick={handleRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-full border border-edge-strong bg-surface-2 px-4 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink transition disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="rounded-[12px] border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] text-bad">{error}</div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Tenants" value={stats?.tenants.total ?? 0} icon={<Building2 className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<><span className="text-ok font-medium">{stats?.tenants.active ?? 0} active</span><span className="text-ink-4">•</span><span className="text-warn">{stats?.tenants.suspended ?? 0} suspended</span></>} />
        <KpiCard label="Subscriptions" value={stats?.subscriptions.total ?? 0} icon={<CreditCard className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<><span className="text-ok font-medium">{stats?.subscriptions.active ?? 0} active</span><span className="text-ink-4">•</span><span className="text-info">{stats?.subscriptions.trialing ?? 0} trialing</span></>} />
        <KpiCard label="Users" value={stats?.users.total ?? 0} icon={<Users className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<span className="text-ink-2">{stats?.users.verified ?? 0} verified • {stats?.users.total ? Math.round((stats.users.verified / stats.users.total) * 100) : 0}%</span>} />
        <KpiCard label="Jobs 24h" value={stats?.jobs24h.total ?? 0} icon={<Activity className="h-4 w-4" />} accent="from-brand-400 to-transparent" sub={<><span className="text-ok font-medium">{stats?.jobs24h.success ?? 0} success</span><span className="text-ink-4">•</span><span className="text-bad">{stats?.jobs24h.failed ?? 0} failed</span></>} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7 rounded-[14px] border border-edge bg-surface p-6">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Cpu className="h-4 w-4 text-brand" /> Fleet health</h2>
            <span className="text-[11px] text-ink-4">Last 24h queue depth</span>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="rounded-[12px] border border-edge bg-surface-2 p-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">Agents</span>
                <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-surface-2 text-ink-3"><Cpu className="h-3.5 w-3.5" /></span>
              </div>
              <div className="mt-3 text-[24px] font-bold text-ink tabular-nums">{stats?.agents.total ?? 0}</div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-ok-solid" style={{ width: `${stats?.agents.total ? Math.round(((stats.agents.online ?? 0) / stats.agents.total) * 100) : 0}%` }} />
              </div>
              <div className="mt-2 flex justify-between text-[11px]"><span className="text-ok">{stats?.agents.online ?? 0} online</span><span className="text-ink-4">{stats?.agents.offline ?? 0} offline</span></div>
            </div>
            <div className="rounded-[12px] border border-edge bg-surface-2 p-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">Printers</span>
                <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-surface-2 text-ink-3"><Printer className="h-3.5 w-3.5" /></span>
              </div>
              <div className="mt-3 text-[24px] font-bold text-ink tabular-nums">{stats?.printers.total ?? 0}</div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-brand" style={{ width: `${stats?.printers.total ? Math.round(((stats.printers.online ?? 0) / stats.printers.total) * 100) : 0}%` }} />
              </div>
              <div className="mt-2 flex justify-between text-[11px]"><span className="text-brand-subtle-text">{stats?.printers.online ?? 0} online</span><span className="text-ink-4">{stats?.printers.offline ?? 0} offline</span></div>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-edge pt-5">
            <div className="text-center"><div className="text-[11px] text-ink-4">Queued</div><div className="mt-1 text-[16px] font-semibold text-ink tabular-nums">{stats?.jobs24h.queued ?? 0}</div></div>
            <div className="text-center border-x border-edge"><div className="text-[11px] text-ink-4">Success</div><div className="mt-1 text-[16px] font-semibold text-ok tabular-nums">{stats?.jobs24h.success ?? 0}</div></div>
            <div className="text-center"><div className="text-[11px] text-ink-4">Failed</div><div className="mt-1 text-[16px] font-semibold text-bad tabular-nums">{stats?.jobs24h.failed ?? 0}</div></div>
          </div>
        </div>

        <div className="lg:col-span-5 space-y-4">
          <div className="rounded-[14px] border border-edge bg-surface p-6">
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><AlertTriangle className="h-4 w-4 text-warn" /> Risk & alerts</h2>
            <div className="mt-5 space-y-3">
              {(stats?.tenants.suspended ?? 0) > 0 ? (
                <div className="flex items-center justify-between rounded-[10px] border border-warn-edge bg-warn-bg px-4 py-3 text-[12px] text-warn">
                  <span>{stats?.tenants.suspended} tenant(s) suspended — requires review</span>
                  <Link href="/platform/tenants" className="font-semibold underline hover:text-warn">Review</Link>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-[10px] border border-ok-edge bg-ok-bg px-4 py-3 text-[12px] text-ok"><ShieldCheck className="h-4 w-4" /> All tenant lifecycles normal</div>
              )}
              {(stats?.subscriptions.pastDue ?? 0) > 0 && (
                <div className="flex items-center justify-between rounded-[10px] border border-bad-edge bg-bad-bg px-4 py-3 text-[12px] text-bad">
                  <span>{stats?.subscriptions.pastDue} past_due billing — Stripe action needed</span>
                  <Link href="/platform/subscriptions" className="font-semibold underline hover:text-bad">View</Link>
                </div>
              )}
              <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-4"><TrendingUp className="h-3.5 w-3.5" /> Operational notes</div>
                <ul className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-ink-3">
                  <li>• Entitlements enforced server-side, not UI-only</li>
                  <li>• Tenant isolation: WS, API, DB queries scoped</li>
                  <li>• No fake dashboard numbers — real backend counts only</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <Link href="/platform/tenants" className="group flex items-center justify-between rounded-[12px] border border-edge bg-surface p-4 transition hover:border-edge-strong hover:bg-surface-hover">
              <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-subtle border border-edge-accent text-brand-subtle-text"><Building2 className="h-4 w-4" /></span><div><div className="text-[13px] font-semibold text-ink group-hover:text-brand-subtle-text">Tenants</div><div className="text-[11px] text-ink-4">Lifecycle & suspension</div></div></div><ArrowRight className="h-4 w-4 text-ink-4 group-hover:text-ink transition" />
            </Link>
            <Link href="/platform/subscriptions" className="group flex items-center justify-between rounded-[12px] border border-edge bg-surface p-4 transition hover:border-edge-strong hover:bg-surface-hover">
              <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-subtle border border-edge-accent text-brand-subtle-text"><CreditCard className="h-4 w-4" /></span><div><div className="text-[13px] font-semibold text-ink group-hover:text-brand-subtle-text">Subscriptions</div><div className="text-[11px] text-ink-4">Stripe & billing states</div></div></div><ArrowRight className="h-4 w-4 text-ink-4 group-hover:text-ink transition" />
            </Link>
            <Link href="/platform/audit" className="group flex items-center justify-between rounded-[12px] border border-edge bg-surface p-4 transition hover:border-edge-strong hover:bg-surface-hover">
              <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-ok-bg border border-ok-edge text-ok"><Layers className="h-4 w-4" /></span><div><div className="text-[13px] font-semibold text-ink group-hover:text-ok">Audit feed</div><div className="text-[11px] text-ink-4">Platform events stream</div></div></div><ArrowRight className="h-4 w-4 text-ink-4 group-hover:text-ink transition" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
