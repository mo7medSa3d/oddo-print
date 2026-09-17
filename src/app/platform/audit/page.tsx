"use client";

import { useEffect, useState } from "react";
import { Shield, Search, RefreshCw } from "lucide-react";

type AuditEvent = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  actorType: "platform" | "user" | "system" | "agent" | "odoo" | "desktop";
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export default function PlatformAuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/audit?limit=150");
        if (ignore) return;
        if (!res.ok) throw new Error("Failed to fetch system audit feed");
        const data = await res.json();
        if (!ignore) {
          setEvents(data.auditEvents || []);
          setError(null);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Error loading audit logs");
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

  const filtered = events.filter(
    (e) =>
      e.action.toLowerCase().includes(search.toLowerCase()) ||
      e.tenantId.toLowerCase().includes(search.toLowerCase()) ||
      (e.tenantName && e.tenantName.toLowerCase().includes(search.toLowerCase())) ||
      (e.actorId && e.actorId.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
            <Shield className="w-6 h-6 text-emerald-400" />
            System Audit Stream
          </h1>
          <p className="text-sm text-slate-400 mt-1">Platform-wide audit events log across all tenants and actors.</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-sm font-medium transition self-start sm:self-auto"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh Stream
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
          placeholder="Filter by action (e.g. tenant.suspended, agent.paired), tenant, or actor ID..."
          className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </div>

      {/* Audit Log Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/70 text-xs uppercase font-semibold text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">Timestamp</th>
                <th className="px-5 py-3.5">Action</th>
                <th className="px-5 py-3.5">Actor</th>
                <th className="px-5 py-3.5">Tenant</th>
                <th className="px-5 py-3.5">Resource</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-slate-500 text-sm font-sans">
                    No audit events found.
                  </td>
                </tr>
              ) : (
                filtered.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-850/50 transition">
                    <td className="px-5 py-3.5 text-slate-400 whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="font-semibold text-emerald-400">{e.action}</span>
                    </td>
                    <td className="px-5 py-3.5 text-slate-300">
                      <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700/60 text-slate-300 text-[11px] font-sans mr-2">
                        {e.actorType}
                      </span>
                      {e.actorId || "N/A"}
                    </td>
                    <td className="px-5 py-3.5 text-slate-300">
                      <div className="font-sans font-medium text-slate-200">{e.tenantName || e.tenantId}</div>
                      <div className="text-[11px] text-slate-500">{e.tenantId}</div>
                    </td>
                    <td className="px-5 py-3.5 text-slate-400">
                      {e.resourceType ? `${e.resourceType}: ${e.resourceId}` : "N/A"}
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
