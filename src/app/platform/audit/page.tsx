"use client";

import { useEffect, useState } from "react";
import { Shield, Search, RefreshCw, ShieldAlert } from "lucide-react";

type AuditEvent = {
  id: string;
  tenantId: string | null;
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
        if (!res.ok) throw new Error("Failed to fetch audit feed");
        const data = await res.json();
        if (!ignore) { setEvents(data.auditEvents || []); setError(null); }
      } catch (err: unknown) { if (!ignore) setError(err instanceof Error ? err.message : "Error loading audit logs"); }
      finally { if (!ignore) setLoading(false); }
    }
    load();
    return () => { ignore = true; };
  }, [reloadKey]);

  function handleRefresh() { setLoading(true); setReloadKey((k) => k + 1); }

  const filtered = events.filter((e) => e.action.toLowerCase().includes(search.toLowerCase()) || (e.tenantId && e.tenantId.toLowerCase().includes(search.toLowerCase())) || (e.tenantName && e.tenantName.toLowerCase().includes(search.toLowerCase())) || (e.actorId && e.actorId.toLowerCase().includes(search.toLowerCase())));

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-edge-strong bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            <ShieldAlert className="h-3.5 w-3.5" /> Compliance • Immutable
          </div>
          <h1 className="mt-4 text-[26px] font-bold tracking-[-0.02em] text-ink leading-tight flex items-center gap-2.5"><Shield className="h-6 w-6 text-ok" /> System Audit Stream</h1>
          <p className="mt-2 text-[13px] text-ink-3">Platform-wide audit events across tenants and actors. Last 150 events.</p>
        </div>
        <button onClick={handleRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-full border border-edge-strong bg-surface-2 px-4 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink transition self-start sm:self-auto">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh stream
        </button>
      </div>

      {error && <div className="rounded-[12px] border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] text-bad">{error}</div>}

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by action (e.g. tenant.suspended, agent.paired), tenant, or actor ID…" className="w-full rounded-[12px] border border-edge-strong bg-surface pl-10 pr-4 py-2.5 text-[13px] text-ink placeholder-ink-4 outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
      </div>

      <div className="overflow-hidden rounded-[14px] border border-edge bg-surface">
        <div className="border-b border-edge px-5 py-4"><h2 className="text-[13px] font-semibold text-ink">Audit log • {filtered.length} events</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px] text-ink-2">
            <thead className="border-b border-edge bg-surface-2 text-[11px] uppercase font-semibold tracking-wide text-ink-4">
              <tr><th className="px-5 py-3">Timestamp</th><th className="px-5 py-3">Action</th><th className="px-5 py-3">Actor</th><th className="px-5 py-3">Tenant</th><th className="px-5 py-3">Resource</th></tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle font-mono text-[11px]">
              {filtered.length === 0 ? <tr><td colSpan={5} className="px-5 py-16 text-center text-ink-4 text-[13px] font-sans">No audit events found.</td></tr> : filtered.map((e) => (
                <tr key={e.id} className="hover:bg-surface-hover transition">
                  <td className="px-5 py-3 text-ink-3 whitespace-nowrap tabular-nums">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-5 py-3"><span className="font-semibold text-ok">{e.action}</span></td>
                  <td className="px-5 py-3 text-ink-2"><span className="inline-flex rounded-full border border-edge-strong bg-surface-2 px-2 py-0.5 text-[10px] font-sans mr-2 text-ink-3">{e.actorType}</span>{e.actorId || "N/A"}</td>
                  <td className="px-5 py-3"><div className="font-sans font-medium text-ink text-[12px]">{e.tenantName || e.tenantId || "Platform"}</div><div className="text-[10px] text-ink-4 font-mono">{e.tenantId ?? "—"}</div></td>
                  <td className="px-5 py-3 text-ink-4">{e.resourceType ? `${e.resourceType}: ${e.resourceId}` : "N/A"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
