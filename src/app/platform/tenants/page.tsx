"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, Building2, CheckCircle2, CircleAlert, Loader2, RefreshCw, Search, ShieldAlert, X } from "lucide-react";

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

type DialogMode = "suspend" | "reactivate";

export default function PlatformTenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>("suspend");
  const [suspendReason, setSuspendReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/tenants", { cache: "no-store" });
        if (ignore) return;
        if (!res.ok) { const data = await res.json().catch(() => null); throw new Error(data?.error || "Failed to load tenants."); }
        const data = await res.json();
        if (!ignore) { setTenants(Array.isArray(data.tenants) ? data.tenants : []); setError(null); }
      } catch (err: unknown) {
        if (!ignore) setError(err instanceof Error ? err.message : "Failed to load tenants.");
      } finally { if (!ignore) setLoading(false); }
    }
    void load();
    return () => { ignore = true; };
  }, [reloadKey]);

  const closeDialog = useCallback(() => {
    if (actionLoading) return;
    setSelectedTenant(null);
    setSuspendReason("");
    setActionError(null);
  }, [actionLoading]);

  useEffect(() => {
    if (!selectedTenant) return;
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape" && !actionLoading) closeDialog(); }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTenant, actionLoading, closeDialog]);

  function handleRefresh() { setLoading(true); setError(null); setNotice(null); setReloadKey((k) => k + 1); }
  function openSuspend(tenant: Tenant) { setSelectedTenant(tenant); setDialogMode("suspend"); setSuspendReason(""); setActionError(null); }
  function openReactivate(tenant: Tenant) { setSelectedTenant(tenant); setDialogMode("reactivate"); setSuspendReason(""); setActionError(null); }

  async function handleLifecycleAction() {
    if (!selectedTenant) return;
    const reason = suspendReason.trim();
    if (dialogMode === "suspend" && !reason) { setActionError("Enter a reason before suspending this tenant."); return; }
    setActionLoading(true); setActionError(null); setNotice(null);
    const nextLifecycle = dialogMode === "suspend" ? "suspended" : "active";
    try {
      const endpoint = dialogMode === "suspend" ? `/api/platform/tenants/${selectedTenant.id}/suspend` : `/api/platform/tenants/${selectedTenant.id}/reactivate`;
      const options: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" } };
      if (dialogMode === "suspend") options.body = JSON.stringify({ reason });
      const res = await fetch(endpoint, options);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "The tenant lifecycle action failed.");
      const actionLabel = nextLifecycle === "suspended" ? "suspended" : "reactivated";
      const tenantName = selectedTenant.name;
      setSelectedTenant(null); setSuspendReason(""); setActionError(null);
      setNotice(`Tenant "${tenantName}" was ${actionLabel} successfully.`);
      handleRefresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "The tenant lifecycle action failed.");
    } finally { setActionLoading(false); }
  }

  const filtered = tenants.filter((tenant) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return tenant.name.toLowerCase().includes(query) || tenant.id.toLowerCase().includes(query);
  });

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <ShieldAlert className="h-3.5 w-3.5" /> Control Plane • Tenants
          </div>
          <h1 className="mt-4 flex items-center gap-2.5 text-[26px] font-bold tracking-[-0.02em] text-white leading-tight">
            <Building2 className="h-6 w-6 text-indigo-400" /> Tenants
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-400">Workspace directory, lifecycle control, and fleet overview — suspension reason required, audit preserved.</p>
        </div>
        <button onClick={handleRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-[13px] font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white transition disabled:opacity-50">
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh
        </button>
      </section>

      {notice && (
        <div role="status" className="flex items-start gap-3 rounded-[12px] border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-[13px] text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{notice}</span>
          <button onClick={() => setNotice(null)} className="ml-auto rounded p-0.5 text-emerald-300/70 hover:bg-emerald-500/10 hover:text-emerald-200"><X className="h-4 w-4" /></button>
        </div>
      )}
      {error && <div role="alert" className="flex items-start gap-3 rounded-[12px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] text-red-300"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by tenant name or ID…" aria-label="Search tenants" className="w-full rounded-[12px] border border-white/[0.08] bg-[#12141f] py-2.5 pl-10 pr-4 text-[13px] text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-500/30 focus:ring-2 focus:ring-indigo-500/15" />
      </div>

      <div className="overflow-hidden rounded-[14px] border border-white/[0.06] bg-[#12141f]">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div><h2 className="text-[13px] font-semibold text-white">Workspace directory</h2><p className="mt-0.5 text-[11px] text-slate-500">{filtered.length} {filtered.length === 1 ? "tenant" : "tenants"} • {tenants.filter(t => t.lifecycle === "active").length} active • {tenants.filter(t => t.lifecycle === "suspended").length} suspended</p></div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-[13px] text-slate-300">
            <thead className="border-b border-white/[0.06] bg-[#0c0e1a] text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr><th className="px-5 py-3">Tenant</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Plan</th><th className="px-5 py-3">Members</th><th className="px-5 py-3">Fleet</th><th className="px-5 py-3">Created</th><th className="px-5 py-3 text-right">Action</th></tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-16 text-center"><div className="mx-auto flex max-w-sm flex-col items-center"><div className="mb-3 flex h-10 w-10 items-center justify-center rounded-[10px] border border-white/[0.06] bg-white/[0.02] text-slate-600"><Building2 className="h-4 w-4" /></div><div className="text-[13px] font-medium text-slate-300">No tenants found</div><div className="mt-1 text-[11px] text-slate-500">Try a different name or ID.</div></div></td></tr>
              ) : filtered.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-white/[0.02] transition">
                  <td className="px-5 py-4"><div className="font-semibold text-white text-[13px]">{tenant.name}</div><div className="mt-1 font-mono text-[11px] text-slate-500">{tenant.id}</div></td>
                  <td className="px-5 py-4">
                    {tenant.lifecycle === "active" ? <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300"><CheckCircle2 className="h-3 w-3" /> Active</span> : tenant.lifecycle === "suspended" ? <div className="max-w-[200px]"><span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-300"><AlertOctagon className="h-3 w-3" /> Suspended</span>{tenant.lifecycleReason && <div title={tenant.lifecycleReason} className="mt-1 truncate text-[11px] text-slate-500">{tenant.lifecycleReason}</div>}</div> : <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300">Deleted</span>}
                  </td>
                  <td className="px-5 py-4 text-[12px] text-slate-300">{tenant.planName || "No plan"}</td>
                  <td className="px-5 py-4 text-[12px] font-medium tabular-nums">{tenant.memberCount}</td>
                  <td className="px-5 py-4 text-[11px] text-slate-400"><div>{tenant.agentCount} agents</div><div>{tenant.printerCount} printers</div></td>
                  <td className="px-5 py-4 text-[11px] text-slate-500">{new Date(tenant.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-4 text-right">
                    {tenant.lifecycle === "active" ? <button onClick={() => openSuspend(tenant)} disabled={actionLoading} className="rounded-[8px] border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/15 transition disabled:opacity-50">Suspend</button> : tenant.lifecycle === "suspended" ? <button onClick={() => openReactivate(tenant)} disabled={actionLoading} className="rounded-[8px] border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/15 transition disabled:opacity-50">Reactivate</button> : <span className="text-[11px] text-slate-600">No actions</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedTenant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-[480px] overflow-hidden rounded-[16px] border border-white/[0.10] bg-[#12141f] shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-6 py-5">
              <div className="flex gap-3"><div className={dialogMode === "suspend" ? "flex h-10 w-10 items-center justify-center rounded-[10px] bg-amber-500/10 border border-amber-500/20 text-amber-300" : "flex h-10 w-10 items-center justify-center rounded-[10px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"}>{dialogMode === "suspend" ? <AlertOctagon className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}</div><div><h2 className="text-[15px] font-semibold text-white">{dialogMode === "suspend" ? "Suspend tenant" : "Reactivate tenant"}</h2><p className="mt-1 text-[12px] text-slate-400">{dialogMode === "suspend" ? "Pause workspace until reactivated." : "Restore workspace to active."}</p></div></div>
              <button onClick={closeDialog} disabled={actionLoading} className="rounded-lg p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <div className="rounded-[10px] border border-white/[0.06] bg-[#0c0e1a] px-4 py-3"><div className="text-[13px] font-semibold text-white">{selectedTenant.name}</div><div className="mt-1 font-mono text-[11px] text-slate-500">{selectedTenant.id}</div></div>
              {dialogMode === "suspend" && <><div className="rounded-[10px] border border-amber-500/15 bg-amber-500/[0.06] px-4 py-3 text-[12px] leading-relaxed text-amber-200/80">Members lose sessions, agents stop syncing, new print ops blocked until reactivation.</div><div className="space-y-2"><div className="flex justify-between"><label htmlFor="suspension-reason" className="text-[13px] font-medium text-slate-200">Reason</label><span className="text-[11px] text-slate-500">{suspendReason.length}/500</span></div><textarea id="suspension-reason" value={suspendReason} onChange={(e) => setSuspendReason(e.target.value.slice(0, 500))} placeholder="e.g. Billing overdue, security review…" rows={4} autoFocus disabled={actionLoading} className="w-full resize-none rounded-[10px] border border-white/[0.08] bg-[#0c0e1a] px-3.5 py-3 text-[13px] text-slate-100 placeholder-slate-600 outline-none focus:border-amber-500/30 focus:ring-2 focus:ring-amber-500/10 disabled:opacity-60" /></div></>}
              {dialogMode === "reactivate" && <div className="rounded-[10px] border border-emerald-500/15 bg-emerald-500/[0.06] px-4 py-3 text-[12px] leading-relaxed text-emerald-200/80">Active sessions and print operations can resume after this action.</div>}
              {actionError && <div role="alert" className="flex items-start gap-2.5 rounded-[10px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[12px] text-red-300"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{actionError}</span></div>}
            </div>
            <div className="flex justify-end gap-2 border-t border-white/[0.06] bg-[#0c0e1a]/50 px-6 py-4">
              <button onClick={closeDialog} disabled={actionLoading} className="rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-4 py-2.5 text-[13px] font-medium text-slate-300 hover:bg-white/[0.06] hover:text-white disabled:opacity-50">Cancel</button>
              <button onClick={() => void handleLifecycleAction()} disabled={actionLoading || (dialogMode === "suspend" && !suspendReason.trim())} className={`inline-flex items-center gap-2 rounded-[10px] px-4 py-2.5 text-[13px] font-semibold text-white transition disabled:opacity-50 ${dialogMode === "suspend" ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"}`}>{actionLoading ? <><Loader2 className="h-4 w-4 animate-spin" />{dialogMode === "suspend" ? "Suspending…" : "Reactivating…"}</> : dialogMode === "suspend" ? <><AlertOctagon className="h-4 w-4" /> Suspend tenant</> : <><CheckCircle2 className="h-4 w-4" /> Reactivate tenant</>}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
