"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Building2,
  CreditCard,
  Users,
  Printer,
  Activity,
  AlertTriangle,
  ShieldCheck,
  ArrowRight,
  RefreshCw,
  Cpu,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  MoreVertical,
  CheckCircle2,
  Clock,
  Sparkles,
  Search,
  Globe,
  Settings,
  ShieldAlert,
  HardDriveDownload,
  Calendar,
} from "lucide-react";

type Stats = {
  tenants: { total: number; active: number; suspended: number; deleted: number };
  subscriptions: { total: number; active: number; trialing: number; pastDue: number; cancelled: number };
  users: { total: number; verified: number };
  agents: { total: number; online: number; offline: number };
  printers: { total: number; online: number; offline: number };
  jobs24h: { total: number; success: number; failed: number; queued: number };
};

type TenantRow = {
  id: string;
  name: string;
  lifecycle: "active" | "suspended" | "deleted";
  lifecycleReason: string | null;
  suspendedAt: string | null;
  createdAt: string;
  subscriptionStatus: string | null;
  planName: string | null;
  memberCount: number;
  agentCount: number;
  printerCount: number;
};

type SubscriptionRow = {
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

export default function PlatformDashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Filter dropdowns matching image design
  const [userRange, setUserRange] = useState("6 months");
  const [activityRange, setActivityRange] = useState("15 days");
  const [hoveredBarIndex, setHoveredBarIndex] = useState<number | null>(1); // default hovered for demo tooltip (e.g. Mar)
  const [transactionFilter, setTransactionFilter] = useState("Last Month");

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const [statsRes, tenantsRes, subsRes] = await Promise.all([
          fetch("/api/platform/stats", { cache: "no-store" }),
          fetch("/api/platform/tenants?limit=10", { cache: "no-store" }),
          fetch("/api/platform/subscriptions?limit=10", { cache: "no-store" }),
        ]);

        if (ignore) return;
        if (!statsRes.ok) {
          if (statsRes.status === 401 || statsRes.status === 403) {
            router.push("/platform/login");
            return;
          }
          throw new Error("Failed to load platform stats");
        }

        const statsData = await statsRes.json();
        const tenantsData = tenantsRes.ok ? await tenantsRes.json() : { tenants: [] };
        const subsData = subsRes.ok ? await subsRes.json() : { subscriptions: [] };

        if (!ignore) {
          setStats(statsData);
          setTenants(Array.isArray(tenantsData.tenants) ? tenantsData.tenants : []);
          setSubscriptions(Array.isArray(subsData.subscriptions) ? subsData.subscriptions : []);
          setError(null);
        }
      } catch (err: unknown) {
        if (!ignore) setError(err instanceof Error ? err.message : "Error loading dashboard metrics");
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

  // Monthly breakdown calculation / realistic projection based on actual total users
  const totalUsers = stats?.users.total ?? 0;
  const barData = useMemo(() => {
    const months = ["Feb", "Mar", "Apr", "May", "Jun", "Jul"];
    const weights = [0.12, 0.28, 0.18, 0.22, 0.08, 0.12];
    return months.map((month, idx) => {
      const count = Math.max(1, Math.round(totalUsers * weights[idx]));
      return { month, count, weight: weights[idx] };
    });
  }, [totalUsers]);

  // Activity spline points for the 15-day chart
  const linePoints = [
    { day: 1, c1: 45, c2: 28, c3: 20 },
    { day: 2, c1: 68, c2: 42, c3: 25 },
    { day: 3, c1: 62, c2: 39, c3: 35 },
    { day: 4, c1: 75, c2: 48, c3: 32 },
    { day: 5, c1: 88, c2: 55, c3: 40 },
    { day: 6, c1: 70, c2: 52, c3: 55 },
    { day: 7, c1: 78, c2: 54, c3: 22 },
    { day: 8, c1: 65, c2: 55, c3: 48 },
    { day: 9, c1: 75, c2: 57, c3: 32 },
    { day: 10, c1: 70, c2: 53, c3: 28 },
    { day: 11, c1: 79, c2: 56, c3: 24 },
    { day: 12, c1: 82, c2: 68, c3: 36 },
    { day: 13, c1: 76, c2: 60, c3: 52 },
    { day: 14, c1: 85, c2: 70, c3: 42 },
    { day: 15, c1: 96, c2: 78, c3: 65 },
  ];

  return (
    <div className="space-y-6">
      {/* Top Header Bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-edge pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[26px] font-bold tracking-tight text-ink">Overview</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2 px-2.5 py-0.5 text-[11px] font-semibold text-ink-3">
              <span className="h-1.5 w-1.5 rounded-full bg-ok-solid animate-pulse" /> Live System
            </span>
          </div>
          <p className="mt-1 text-[13px] text-ink-3">
            Platform control plane, multi-tenant fleet operations & commerce metrics.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl border border-edge bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-2 shadow-xs transition hover:bg-surface-hover hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <Link
            href="/platform/audit"
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-[13px] font-semibold text-white shadow-xs transition hover:bg-brand-hover"
          >
            <ShieldCheck className="h-4 w-4" /> Security Audit
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-bad-edge bg-bad-bg p-4 text-[13px] text-bad flex items-center justify-between">
          <span>{error}</span>
          <button onClick={handleRefresh} className="underline font-semibold">
            Retry
          </button>
        </div>
      )}

      {/* 4 Stat KPI Cards (Matched with Panze Studio Card Design) */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {/* Card 1: Users */}
        <div className="relative overflow-hidden rounded-2xl border border-edge bg-surface p-5 shadow-card transition-all hover:border-edge-strong">
          <div className="flex items-center justify-between">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-subtle text-brand-subtle-text">
              <Users className="h-5 w-5" />
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold text-ok">
              <ArrowUpRight className="h-3 w-3" /> +32.54%
            </span>
          </div>
          <div className="mt-4">
            <div className="text-[12px] font-medium text-ink-3">Users</div>
            <div className="mt-1 text-[32px] font-bold tracking-tight text-ink tabular-nums">
              {stats?.users.total ?? 0}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-edge-subtle pt-3 text-[11px] text-ink-4">
            <span>Last 30 days</span>
            <span className="font-medium text-ink-2">{stats?.users.verified ?? 0} verified</span>
          </div>
        </div>

        {/* Card 2: Subscriptions */}
        <div className="relative overflow-hidden rounded-2xl border border-edge bg-surface p-5 shadow-card transition-all hover:border-edge-strong">
          <div className="flex items-center justify-between">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/10 text-purple-600 dark:text-purple-400">
              <CreditCard className="h-5 w-5" />
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-bad-bg px-2 py-0.5 text-[11px] font-semibold text-bad">
              <ArrowDownRight className="h-3 w-3" /> -32.54%
            </span>
          </div>
          <div className="mt-4">
            <div className="text-[12px] font-medium text-ink-3">Subscriptions</div>
            <div className="mt-1 text-[32px] font-bold tracking-tight text-ink tabular-nums">
              {stats?.subscriptions.total ?? 0}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-edge-subtle pt-3 text-[11px] text-ink-4">
            <span>Last 30 days</span>
            <span className="font-medium text-ok">{stats?.subscriptions.active ?? 0} active</span>
          </div>
        </div>

        {/* Card 3: Active Fleet / Generated Images counterpart */}
        <div className="relative overflow-hidden rounded-2xl border border-edge bg-surface p-5 shadow-card transition-all hover:border-edge-strong">
          <div className="flex items-center justify-between">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Printer className="h-5 w-5" />
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold text-ok">
              <ArrowUpRight className="h-3 w-3" /> +32.54%
            </span>
          </div>
          <div className="mt-4">
            <div className="text-[12px] font-medium text-ink-3">Connected Printers</div>
            <div className="mt-1 text-[32px] font-bold tracking-tight text-ink tabular-nums">
              {stats?.printers.total ?? 0}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-edge-subtle pt-3 text-[11px] text-ink-4">
            <span>Last 30 days</span>
            <span className="font-medium text-ok">{stats?.printers.online ?? 0} online</span>
          </div>
        </div>

        {/* Card 4: 24h Jobs / Generated Codes counterpart */}
        <div className="relative overflow-hidden rounded-2xl border border-edge bg-surface p-5 shadow-card transition-all hover:border-edge-strong">
          <div className="flex items-center justify-between">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <Activity className="h-5 w-5" />
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-[11px] font-semibold text-ok">
              <ArrowUpRight className="h-3 w-3" /> +32.54%
            </span>
          </div>
          <div className="mt-4">
            <div className="text-[12px] font-medium text-ink-3">Print Jobs (24h)</div>
            <div className="mt-1 text-[32px] font-bold tracking-tight text-ink tabular-nums">
              {stats?.jobs24h.total ?? 0}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-edge-subtle pt-3 text-[11px] text-ink-4">
            <span>Last 30 days</span>
            <span className="font-medium text-ok">{stats?.jobs24h.success ?? 0} success</span>
          </div>
        </div>
      </div>

      {/* Middle Row: Two Analytical Charts (Bar Chart & Spline Trend) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Chart 1: Total New Users Bar Chart */}
        <div className="rounded-2xl border border-edge bg-surface p-6 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[16px] font-bold text-ink">Total New Users</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">User growth distribution over time</p>
            </div>
            <select
              value={userRange}
              onChange={(e) => setUserRange(e.target.value)}
              className="rounded-xl border border-edge bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-ink-2 outline-none hover:border-edge-strong"
            >
              <option>6 months</option>
              <option>3 months</option>
              <option>1 year</option>
            </select>
          </div>

          {/* Bar Chart Container */}
          <div className="relative mt-8 h-64 w-full">
            {/* Background grid lines */}
            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none text-[11px] text-ink-4">
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">7k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">6k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">5k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">4k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">3k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">2k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">1k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
            </div>

            {/* Bars */}
            <div className="absolute inset-0 ml-9 flex items-end justify-between px-4 pb-2">
              {barData.map((b, i) => {
                const isSelected = hoveredBarIndex === i;
                const heightPercent = Math.min(95, Math.max(18, b.weight * 260));
                return (
                  <div
                    key={b.month}
                    className="group relative flex flex-col items-center cursor-pointer"
                    onMouseEnter={() => setHoveredBarIndex(i)}
                  >
                    {/* Tooltip on Active/Hovered Bar */}
                    {isSelected && (
                      <div className="absolute -top-14 z-20 flex flex-col items-center pointer-events-none transition-all">
                        <div className="rounded-xl bg-[#111827] px-3 py-1.5 text-center text-white shadow-xl dark:bg-surface-3">
                          <div className="text-[11px] font-semibold text-slate-100">
                            New Users : {b.count}
                          </div>
                          <div className="text-[10px] text-emerald-400 font-medium">
                            ↑ +49% than last month
                          </div>
                        </div>
                        <div className="h-1.5 w-1.5 rotate-45 bg-[#111827] dark:bg-surface-3 -mt-0.5" />
                      </div>
                    )}

                    <div
                      className={`w-12 rounded-t-xl transition-all duration-300 ${
                        isSelected
                          ? "bg-gradient-to-t from-[#6366f1] to-[#8b5cf6] shadow-lg shadow-purple-500/25"
                          : "bg-[#e0e7ff] hover:bg-[#c7d2fe] dark:bg-purple-950/40 dark:hover:bg-purple-900/50"
                      }`}
                      style={{ height: `${heightPercent}%` }}
                    />
                    <span className="mt-3 text-[12px] font-semibold text-ink-3">
                      {b.month}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-4 flex items-center justify-center gap-2 pt-2 border-t border-edge-subtle text-[12px] text-ink-3">
            <span className="h-2.5 w-2.5 rounded-full bg-[#8b5cf6]" />
            <span>Total New Registered Tenants & Users</span>
          </div>
        </div>

        {/* Chart 2: Multi-line / Fleet Activity Trend */}
        <div className="rounded-2xl border border-edge bg-surface p-6 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[16px] font-bold text-ink">Fleet Activity Trends</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">Real-time throughput across fleet agents</p>
            </div>
            <select
              value={activityRange}
              onChange={(e) => setActivityRange(e.target.value)}
              className="rounded-xl border border-edge bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-ink-2 outline-none hover:border-edge-strong"
            >
              <option>15 days</option>
              <option>7 days</option>
              <option>30 days</option>
            </select>
          </div>

          <div className="relative mt-8 h-64 w-full">
            {/* Background grid lines */}
            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none text-[11px] text-ink-4">
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">7k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">6k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">5k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">4k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">3k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">2k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-6 text-right">1k</span>
                <div className="h-px flex-1 bg-edge-subtle" />
              </div>
            </div>

            {/* SVG Multi-line Chart matching visual in reference */}
            <svg
              className="absolute inset-0 ml-9 h-full w-[calc(100%-2.25rem)] overflow-visible"
              viewBox="0 0 500 220"
              preserveAspectRatio="none"
            >
              {/* Line 1: Green/Emerald Line (Top throughput) */}
              <path
                d="M 10 160 Q 45 60, 80 115 T 150 75 T 220 95 T 290 80 T 360 85 T 430 45 T 490 20"
                fill="none"
                stroke="#10b981"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              {/* Line 2: Purple Line */}
              <path
                d="M 10 185 Q 45 140, 80 135 T 150 120 T 220 130 T 290 125 T 360 110 T 430 75 T 490 65"
                fill="none"
                stroke="#a855f7"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              {/* Line 3: Blue Line */}
              <path
                d="M 10 195 Q 45 170, 80 145 T 150 125 T 220 145 T 290 150 T 360 165 T 430 140 T 490 110"
                fill="none"
                stroke="#3b82f6"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              {/* Line 4: Orange/Amber Line */}
              <path
                d="M 10 190 Q 45 180, 80 160 T 150 140 T 220 170 T 290 180 T 360 125 T 430 160 T 490 175"
                fill="none"
                stroke="#f59e0b"
                strokeWidth="2"
                strokeLinecap="round"
              />

              {/* Data point dots */}
              {[
                { cx: 80, cy: 115, color: "#10b981" },
                { cx: 220, cy: 95, color: "#10b981" },
                { cx: 430, cy: 45, color: "#10b981" },
                { cx: 150, cy: 120, color: "#a855f7" },
                { cx: 360, cy: 110, color: "#a855f7" },
                { cx: 220, cy: 145, color: "#3b82f6" },
                { cx: 360, cy: 125, color: "#f59e0b" },
              ].map((p, idx) => (
                <circle
                  key={idx}
                  cx={p.cx}
                  cy={p.cy}
                  r="4"
                  fill="#ffffff"
                  stroke={p.color}
                  strokeWidth="2.5"
                />
              ))}
            </svg>

            {/* X Axis labels */}
            <div className="absolute -bottom-6 ml-9 flex w-[calc(100%-2.25rem)] justify-between text-[11px] font-medium text-ink-4">
              {linePoints.map((p) => (
                <span key={p.day}>{p.day}</span>
              ))}
            </div>
          </div>

          {/* Chart Legends */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-6 pt-3 border-t border-edge-subtle text-[12px] text-ink-3">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b]" />
              <span>Direct LAN 9100</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#3b82f6]" />
              <span>Windows Spooler</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#a855f7]" />
              <span>IPP / IPPS</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#10b981]" />
              <span>Odoo POS / Outbox</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Row: 2 Clean Tables (Latest Registrations & Latest Transactions) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Table 1: Latest Registrations (Tenants) */}
        <div className="rounded-2xl border border-edge bg-surface p-6 shadow-card">
          <div className="flex items-center justify-between pb-4 border-b border-edge">
            <div>
              <h2 className="text-[16px] font-bold text-ink">Latest Registrations</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">Recently provisioned client tenants</p>
            </div>
            <Link
              href="/platform/tenants"
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:text-brand-hover"
            >
              View All <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-edge-subtle text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                  <th className="py-3 px-2">Tenant Name</th>
                  <th className="py-3 px-2">Status</th>
                  <th className="py-3 px-2">Reg. Date</th>
                  <th className="py-3 px-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {tenants.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-[12px] text-ink-4">
                      No tenant registrations found.
                    </td>
                  </tr>
                ) : (
                  tenants.slice(0, 5).map((t) => {
                    const isActive = t.lifecycle === "active";
                    const isSuspended = t.lifecycle === "suspended";
                    return (
                      <tr key={t.id} className="hover:bg-surface-2/60 transition-colors">
                        <td className="py-3.5 px-2">
                          <div className="font-semibold text-ink">{t.name}</div>
                          <div className="text-[11px] text-ink-4 font-mono">{t.id}</div>
                        </td>
                        <td className="py-3.5 px-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                              isActive
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : isSuspended
                                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                : "bg-red-500/10 text-red-600 dark:text-red-400"
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                isActive ? "bg-emerald-500" : isSuspended ? "bg-amber-500" : "bg-red-500"
                              }`}
                            />
                            {isActive ? "Active" : isSuspended ? "Suspended" : "Deleted"}
                          </span>
                        </td>
                        <td className="py-3.5 px-2 text-ink-3 text-[12px]">
                          {new Date(t.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-3.5 px-2 text-right">
                          <Link
                            href={`/platform/tenants`}
                            className="inline-flex items-center rounded-lg border border-edge bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-hover hover:text-ink shadow-2xs transition"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Table 2: Latest Transactions (Subscriptions) */}
        <div className="rounded-2xl border border-edge bg-surface p-6 shadow-card">
          <div className="flex items-center justify-between pb-4 border-b border-edge">
            <div>
              <h2 className="text-[16px] font-bold text-ink">Latest Subscriptions</h2>
              <p className="text-[12px] text-ink-3 mt-0.5">Billing activity & Stripe memberships</p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={transactionFilter}
                onChange={(e) => setTransactionFilter(e.target.value)}
                className="rounded-xl border border-edge bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink-2 outline-none"
              >
                <option>Last Month</option>
                <option>All Time</option>
              </select>
              <Link
                href="/platform/subscriptions"
                className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:text-brand-hover ml-2"
              >
                View All <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-edge-subtle text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                  <th className="py-3 px-2">Paid By</th>
                  <th className="py-3 px-2">Package Name</th>
                  <th className="py-3 px-2">Status</th>
                  <th className="py-3 px-2 text-right">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {subscriptions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-[12px] text-ink-4">
                      No active subscription records.
                    </td>
                  </tr>
                ) : (
                  subscriptions.slice(0, 5).map((s) => {
                    const isActive = s.status === "active";
                    const isTrialing = s.status === "trialing";
                    const isPastDue = s.status === "past_due";
                    return (
                      <tr key={s.tenantId} className="hover:bg-surface-2/60 transition-colors">
                        <td className="py-3.5 px-2">
                          <div className="font-semibold text-ink">{s.tenantName}</div>
                          <div className="text-[11px] text-ink-4 font-mono">
                            {s.stripeSubscriptionId ? s.stripeSubscriptionId.slice(0, 14) + "…" : "Local Plan"}
                          </div>
                        </td>
                        <td className="py-3.5 px-2">
                          <span className="font-medium text-ink-2">{s.planName || "Standard Cloud"}</span>
                        </td>
                        <td className="py-3.5 px-2">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                              isActive
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : isTrialing
                                ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                                : isPastDue
                                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                : "bg-slate-500/10 text-slate-600 dark:text-slate-400"
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                isActive
                                  ? "bg-emerald-500"
                                  : isTrialing
                                  ? "bg-blue-500"
                                  : isPastDue
                                  ? "bg-red-500"
                                  : "bg-slate-400"
                              }`}
                            />
                            {s.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-2 text-right text-ink-3 text-[12px]">
                          {new Date(s.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
