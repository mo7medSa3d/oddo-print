"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertOctagon,
  Building2,
  CheckCircle2,
  CircleAlert,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";

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

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || "Failed to load tenants.");
        }

        const data = await res.json();
        if (!ignore) {
          setTenants(Array.isArray(data.tenants) ? data.tenants : []);
          setError(null);
        }
      } catch (err: unknown) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Failed to load tenants.");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedTenant) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !actionLoading) {
        closeDialog();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedTenant, actionLoading, closeDialog]);

  function handleRefresh() {
    setLoading(true);
    setError(null);
    setNotice(null);
    setReloadKey((key) => key + 1);
  }

  function openSuspend(tenant: Tenant) {
    setSelectedTenant(tenant);
    setDialogMode("suspend");
    setSuspendReason("");
    setActionError(null);
  }

  function openReactivate(tenant: Tenant) {
    setSelectedTenant(tenant);
    setDialogMode("reactivate");
    setSuspendReason("");
    setActionError(null);
  }

  function closeDialog() {
    if (actionLoading) return;
    setSelectedTenant(null);
    setSuspendReason("");
    setActionError(null);
  }

  async function handleLifecycleAction() {
    if (!selectedTenant) return;

    const reason = suspendReason.trim();
    if (dialogMode === "suspend" && !reason) {
      setActionError("Enter a reason before suspending this tenant.");
      return;
    }

    setActionLoading(true);
    setActionError(null);
    setNotice(null);

    const nextLifecycle = dialogMode === "suspend" ? "suspended" : "active";

    try {
      const endpoint =
        dialogMode === "suspend"
          ? "/api/platform/tenants/" + selectedTenant.id + "/suspend"
          : "/api/platform/tenants/" + selectedTenant.id + "/reactivate";

      const options: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };

      if (dialogMode === "suspend") {
        options.body = JSON.stringify({ reason });
      }

      const res = await fetch(endpoint, options);
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || "The tenant lifecycle action failed.");
      }

      const actionLabel = nextLifecycle === "suspended" ? "suspended" : "reactivated";
      const tenantName = selectedTenant.name;

      setSelectedTenant(null);
      setSuspendReason("");
      setActionError(null);
      setNotice('Tenant "' + tenantName + '" was ' + actionLabel + " successfully.");
      handleRefresh();
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : "The tenant lifecycle action failed."
      );
    } finally {
      setActionLoading(false);
    }
  }

  const filtered = tenants.filter((tenant) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;

    return (
      tenant.name.toLowerCase().includes(query) ||
      tenant.id.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-400/15 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-300">
            <ShieldAlert className="h-3.5 w-3.5" />
            Control Plane
          </div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-white">
            <Building2 className="h-6 w-6 text-indigo-400" />
            Tenants
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Review every workspace and control its operational lifecycle.
          </p>
        </div>

        <button
          onClick={handleRefresh}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Refresh
        </button>
      </section>

      {notice && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="ml-auto rounded p-0.5 text-emerald-300/70 transition hover:bg-emerald-500/10 hover:text-emerald-200"
            aria-label="Dismiss notification"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by tenant name or ID..."
          aria-label="Search tenants"
          className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2.5 pl-10 pr-4 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-indigo-500/40 focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl shadow-black/10">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Workspace directory</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {filtered.length} {filtered.length === 1 ? "tenant" : "tenants"}
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm text-slate-300">
            <thead className="border-b border-slate-800 bg-slate-950/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3.5">Tenant</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Plan</th>
                <th className="px-5 py-3.5">Members</th>
                <th className="px-5 py-3.5">Fleet</th>
                <th className="px-5 py-3.5">Created</th>
                <th className="px-5 py-3.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center">
                      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-slate-800 bg-slate-950 text-slate-600">
                        <Building2 className="h-4 w-4" />
                      </div>
                      <div className="text-sm font-medium text-slate-300">No tenants found</div>
                      <div className="mt-1 text-xs text-slate-500">
                        Try a different name or tenant ID.
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((tenant) => (
                  <tr key={tenant.id} className="transition hover:bg-slate-950/40">
                    <td className="px-5 py-4">
                      <div className="font-semibold text-white">{tenant.name}</div>
                      <div className="mt-1 font-mono text-[11px] text-slate-500">
                        {tenant.id}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      {tenant.lifecycle === "active" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" />
                          Active
                        </span>
                      ) : tenant.lifecycle === "suspended" ? (
                        <div className="max-w-[220px]">
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300">
                            <AlertOctagon className="h-3 w-3" />
                            Suspended
                          </span>
                          {tenant.lifecycleReason && (
                            <div
                              title={tenant.lifecycleReason}
                              className="mt-1 truncate text-xs text-slate-500"
                            >
                              {tenant.lifecycleReason}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300">
                          Deleted
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <span className="text-xs font-medium text-slate-300">
                        {tenant.planName || "No plan"}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-xs font-medium text-slate-300">
                      {tenant.memberCount}
                    </td>
                    <td className="px-5 py-4 text-xs text-slate-400">
                      <div>{tenant.agentCount} agents</div>
                      <div>{tenant.printerCount} printers</div>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-400">
                      {new Date(tenant.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-4 text-right">
                      {tenant.lifecycle === "active" ? (
                        <button
                          onClick={() => openSuspend(tenant)}
                          disabled={actionLoading}
                          className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-300 transition hover:border-amber-400/30 hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Suspend
                        </button>
                      ) : tenant.lifecycle === "suspended" ? (
                        <button
                          onClick={() => openReactivate(tenant)}
                          disabled={actionLoading}
                          className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:border-emerald-400/30 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Reactivate
                        </button>
                      ) : (
                        <span className="text-xs text-slate-600">No actions</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedTenant && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="tenant-lifecycle-dialog-title"
            className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/40"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
              <div className="flex min-w-0 gap-3">
                <div
                  className={
                    dialogMode === "suspend"
                      ? "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-300"
                      : "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                  }
                >
                  {dialogMode === "suspend" ? (
                    <AlertOctagon className="h-5 w-5" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5" />
                  )}
                </div>

                <div className="min-w-0">
                  <h2 id="tenant-lifecycle-dialog-title" className="text-base font-semibold text-white">
                    {dialogMode === "suspend" ? "Suspend tenant" : "Reactivate tenant"}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    {dialogMode === "suspend"
                      ? "Pause this workspace until it is explicitly reactivated."
                      : "Restore this workspace to an active state."}
                  </p>
                </div>
              </div>

              <button
                onClick={closeDialog}
                disabled={actionLoading}
                aria-label="Close dialog"
                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5 px-6 py-6">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3.5">
                <div className="text-sm font-semibold text-white">{selectedTenant.name}</div>
                <div className="mt-1 font-mono text-[11px] text-slate-500">{selectedTenant.id}</div>
              </div>

              {dialogMode === "suspend" && (
                <>
                  <div className="rounded-xl border border-amber-500/15 bg-amber-500/[0.06] px-4 py-3 text-sm leading-6 text-amber-200/80">
                    Members will lose active sessions, agents will stop synchronizing, and new print operations will be blocked until reactivation.
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <label htmlFor="suspension-reason" className="text-sm font-medium text-slate-200">
                        Reason
                      </label>
                      <span className="text-xs text-slate-500">{suspendReason.length}/500</span>
                    </div>

                    <textarea
                      id="suspension-reason"
                      value={suspendReason}
                      onChange={(event) => setSuspendReason(event.target.value.slice(0, 500))}
                      placeholder="e.g. Billing overdue, security review, contract request..."
                      rows={4}
                      autoFocus
                      disabled={actionLoading}
                      className="w-full resize-none rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-3 text-sm text-slate-100 placeholder-slate-600 outline-none transition focus:border-amber-500/40 focus:ring-2 focus:ring-amber-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                </>
              )}

              {dialogMode === "reactivate" && (
                <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/[0.06] px-4 py-3 text-sm leading-6 text-emerald-200/80">
                  Active sessions and print operations can resume after this action completes.
                </div>
              )}

              {actionError && (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300"
                >
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{actionError}</span>
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-slate-800 bg-slate-950/40 px-6 py-4 sm:flex-row sm:justify-end">
              <button
                onClick={closeDialog}
                disabled={actionLoading}
                className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                onClick={() => void handleLifecycleAction()}
                disabled={actionLoading || (dialogMode === "suspend" && !suspendReason.trim())}
                className={
                  dialogMode === "suspend"
                    ? "inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                    : "inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                }
              >
                {actionLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {dialogMode === "suspend" ? "Suspending..." : "Reactivating..."}
                  </>
                ) : dialogMode === "suspend" ? (
                  <>
                    <AlertOctagon className="h-4 w-4" />
                    Suspend tenant
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Reactivate tenant
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
