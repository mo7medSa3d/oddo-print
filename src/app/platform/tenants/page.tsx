"use client";

import { useEffect, useState } from "react";
import { Building2, Search, AlertOctagon, CheckCircle2, RefreshCw, X, Loader2 } from "lucide-react";

type Tenant = {
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

export default function PlatformTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Modal state for suspension
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/tenants");
        if (ignore) return;
        if (!res.ok) throw new Error("Failed to fetch platform tenants");
        const data = await res.json();
        if (!ignore) {
          setTenants(data.tenants || []);
          setError(null);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Error loading tenants");
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

  async function handleSuspend() {
    if (!selectedTenant || !suspendReason.trim()) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/platform/tenants/${selectedTenant.id}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: suspendReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to suspend tenant");
      setSelectedTenant(null);
      setSuspendReason("");
      handleRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Suspension failed");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReactivate(tenantId: string) {
    if (!confirm("Are you sure you want to reactivate this tenant?")) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/reactivate`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reactivate tenant");
      handleRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Reactivation failed");
    } finally {
      setActionLoading(false);
    }
  }

  const filtered = tenants.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.id.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
            <Building2 className="w-6 h-6 text-indigo-400" />
            Tenants Directory
          </h1>
          <p className="text-sm text-slate-400 mt-1">Platform-wide multi-tenant management and lifecycle control.</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-sm font-medium transition self-start sm:self-auto"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh Directory
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
          placeholder="Filter tenants by name or ID..."
          className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {/* Tenants Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/70 text-xs uppercase font-semibold text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">Tenant</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Plan</th>
                <th className="px-5 py-3.5">Members</th>
                <th className="px-5 py-3.5">Fleet</th>
                <th className="px-5 py-3.5">Created</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-slate-500 text-sm">
                    No tenants found.
                  </td>
                </tr>
              ) : (
                filtered.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-850/50 transition">
                    <td className="px-5 py-4">
                      <div className="font-semibold text-white">{t.name}</div>
                      <div className="text-xs font-mono text-slate-500 mt-0.5">{t.id}</div>
                    </td>
                    <td className="px-5 py-4">
                      {t.lifecycle === "active" ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" />
                          Active
                        </span>
                      ) : t.lifecycle === "suspended" ? (
                        <div className="space-y-0.5">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400">
                            <AlertOctagon className="w-3 h-3" />
                            Suspended
                          </span>
                          {t.lifecycleReason && (
                            <div className="text-xs text-slate-500 max-w-xs truncate" title={t.lifecycleReason}>
                              {t.lifecycleReason}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-400">
                          Deleted
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-xs font-medium text-slate-300">
                        {t.planName || "Pro Trial"}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-xs font-medium text-slate-300">
                      {t.memberCount} member(s)
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-400">
                      <div>{t.agentCount} agent(s)</div>
                      <div>{t.printerCount} printer(s)</div>
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-400 whitespace-nowrap">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-4 text-right whitespace-nowrap">
                      {t.lifecycle === "active" ? (
                        <button
                          onClick={() => setSelectedTenant(t)}
                          disabled={actionLoading}
                          className="px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-400 text-xs font-semibold transition"
                        >
                          Suspend
                        </button>
                      ) : t.lifecycle === "suspended" ? (
                        <button
                          onClick={() => handleReactivate(t.id)}
                          disabled={actionLoading}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 text-emerald-400 text-xs font-semibold transition"
                        >
                          Reactivate
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Suspension Modal */}
      {selectedTenant && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-semibold text-white text-base">Suspend Tenant: {selectedTenant.name}</h3>
              <button
                onClick={() => setSelectedTenant(null)}
                className="text-slate-400 hover:text-white transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Suspending this tenant will block all member sessions, agent synchronization, and print operations for this tenant until reactivated.
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Suspension Reason (Required)
              </label>
              <textarea
                value={suspendReason}
                onChange={(e) => setSuspendReason(e.target.value)}
                placeholder="e.g. Non-payment, TOS violation, security incident..."
                rows={3}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setSelectedTenant(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSuspend}
                disabled={actionLoading || !suspendReason.trim()}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-semibold transition flex items-center gap-2"
              >
                {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Confirm Suspension
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
