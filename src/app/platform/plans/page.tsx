"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  CheckCircle2,
  CircleAlert,
  CreditCard,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

type EntitlementKey = "max_agents" | "max_printers" | "max_jobs_per_minute" | "max_concurrent_jobs";
type Entitlements = Record<EntitlementKey, number | "unlimited">;

type Plan = {
  id: string;
  name: string;
  description: string;
  entitlements: Entitlements;
  stripePriceId: string | null;
  stripeProductId: string | null;
  currency: string | null;
  interval: string | null;
  isActive: boolean;
  isPublic: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  subscriberCount: number;
  activeSubscriberCount: number;
};

const EMPTY_ENTITLEMENTS: Entitlements = {
  max_agents: 1,
  max_printers: 1,
  max_jobs_per_minute: 60,
  max_concurrent_jobs: 8,
};

const ENTITLEMENT_LABELS: Record<EntitlementKey, string> = {
  max_agents: "Agents",
  max_printers: "Printers",
  max_jobs_per_minute: "Jobs / minute",
  max_concurrent_jobs: "Concurrent jobs",
};

function emptyForm() {
  return {
    id: "",
    name: "",
    description: "",
    stripePriceId: "",
    stripeProductId: "",
    currency: "usd",
    interval: "month",
    displayOrder: 0,
    isActive: true,
    isPublic: true,
    entitlements: { ...EMPTY_ENTITLEMENTS },
  };
}

export default function PlatformPlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/platform/plans", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (ignore) return;
        if (!res.ok) throw new Error(data?.error || "Failed to load plans.");
        setPlans(Array.isArray(data.plans) ? data.plans : []);
        setError(null);
      } catch (err) {
        if (!ignore) setError(err instanceof Error ? err.message : "Failed to load plans.");
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    void load();
    return () => { ignore = true; };
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return plans;
    return plans.filter(
      (plan) =>
        plan.name.toLowerCase().includes(query) ||
        plan.id.toLowerCase().includes(query) ||
        (plan.stripePriceId ?? "").toLowerCase().includes(query)
    );
  }, [plans, search]);

  function refresh(clearNotice = true) {
    setLoading(true);
    setError(null);
    if (clearNotice) setNotice(null);
    setReloadKey((key) => key + 1);
  }

  function openCreate() {
    setCreating(true);
    setEditing(null);
    setError(null);
  }

  function openEdit(plan: Plan) {
    setEditing(plan);
    setCreating(false);
    setError(null);
  }

  function closeEditor() {
    setCreating(false);
    setEditing(null);
  }

  async function archivePlan(plan: Plan) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/platform/plans/" + plan.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to archive plan.");
      setNotice('Plan "' + plan.name + '" is now archived. Existing subscriptions are unchanged.');
      refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive plan.");
    }
  }

  async function save(form: ReturnType<typeof emptyForm>, isNew: boolean) {
    setError(null);
    setNotice(null);
    const url = isNew ? "/api/platform/plans" : "/api/platform/plans/" + form.id;
    const payload = {
      id: form.id,
      name: form.name,
      description: form.description,
      stripePriceId: form.stripePriceId,
      stripeProductId: form.stripeProductId || undefined,
      currency: form.currency,
      interval: form.interval,
      displayOrder: form.displayOrder,
      isActive: form.isActive,
      isPublic: form.isPublic,
      entitlements: form.entitlements,
    };

    try {
      const res = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to save plan.");
      closeEditor();
      setNotice(isNew ? 'Plan "' + form.name + '" created.' : 'Plan "' + form.name + '" updated.');
      refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save plan.");
    }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-400/15 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-300">
            <CreditCard className="h-3.5 w-3.5" />
            Commercial Catalog
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Plans</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Manage what customers can buy and the runtime limits enforced by the Gateway. Stripe remains the billing source of truth.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => refresh()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-700 hover:bg-slate-800 hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Refresh
          </button>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
          >
            <Plus className="h-4 w-4" />
            New plan
          </button>
        </div>
      </section>

      {notice && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by plan name, ID, or Stripe Price ID..."
          className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2.5 pl-10 pr-4 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-500/40 focus:ring-2 focus:ring-indigo-500/20"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="text-sm font-semibold text-white">Plan catalog</h2>
          <p className="mt-0.5 text-xs text-slate-500">{filtered.length} plan{filtered.length === 1 ? "" : "s"}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="border-b border-slate-800 bg-slate-950/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3.5">Plan</th>
                <th className="px-5 py-3.5">Visibility</th>
                <th className="px-5 py-3.5">Limits</th>
                <th className="px-5 py-3.5">Subscribers</th>
                <th className="px-5 py-3.5">Stripe Price</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.map((plan) => (
                <tr key={plan.id} className="transition hover:bg-slate-950/40">
                  <td className="px-5 py-4">
                    <div className="font-semibold text-white">{plan.name}</div>
                    <div className="mt-1 font-mono text-[11px] text-slate-500">{plan.id}</div>
                    {plan.description && <div className="mt-1 max-w-xs truncate text-xs text-slate-500">{plan.description}</div>}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap gap-1.5">
                      <span className={plan.isActive ? "rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300" : "rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400"}>
                        {plan.isActive ? "Active" : "Archived"}
                      </span>
                      <span className={plan.isPublic ? "inline-flex items-center gap-1 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-300" : "inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400"}>
                        {plan.isPublic ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        {plan.isPublic ? "Public" : "Private"}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
                      {Object.entries(plan.entitlements).map(([key, value]) => (
                        <span key={key}>
                          <span className="text-slate-600">{ENTITLEMENT_LABELS[key as EntitlementKey]}:</span>{" "}
                          <span className="font-medium text-slate-200">{value === "unlimited" ? "Unlimited" : value}</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-xs text-slate-300">
                    <div>{plan.activeSubscriberCount} active</div>
                    <div className="mt-1 text-slate-600">{plan.subscriberCount} total</div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="font-mono text-xs text-slate-400">{plan.stripePriceId || "Not linked"}</div>
                    <div className="mt-1 text-xs text-slate-600">
                      {plan.currency?.toUpperCase() || "—"}{plan.interval ? " / " + plan.interval : ""}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => openEdit(plan)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-slate-700 hover:bg-slate-800 hover:text-white">
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>
                      {plan.isActive && (
                        <button onClick={() => void archivePlan(plan)} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/15">
                          <Archive className="h-3.5 w-3.5" /> Archive
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-14 text-center text-sm text-slate-500">No plans found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {(creating || editing) && (
        <PlanEditor
          initial={editing ? {
            id: editing.id,
            name: editing.name,
            description: editing.description,
            stripePriceId: editing.stripePriceId || "",
            stripeProductId: editing.stripeProductId || "",
            currency: editing.currency || "usd",
            interval: editing.interval || "month",
            displayOrder: editing.displayOrder,
            isActive: editing.isActive,
            isPublic: editing.isPublic,
            entitlements: editing.entitlements,
          } : emptyForm()}
          isNew={creating}
          onClose={closeEditor}
          onSave={save}
        />
      )}
    </div>
  );
}

function PlanEditor({
  initial,
  isNew,
  onClose,
  onSave,
}: {
  initial: ReturnType<typeof emptyForm>;
  isNew: boolean;
  onClose: () => void;
  onSave: (form: ReturnType<typeof emptyForm>, isNew: boolean) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  function updateEntitlement(key: EntitlementKey, value: string) {
    setForm((current) => ({
      ...current,
      entitlements: {
        ...current.entitlements,
        [key]: value.trim().toLowerCase() === "unlimited" ? "unlimited" : Number(value),
      },
    }));
  }

  async function submit() {
    setLocalError(null);
    if (isNew && !form.id.trim()) return setLocalError("Plan ID is required.");
    if (!form.name.trim()) return setLocalError("Plan name is required.");
    if (!/^price_[A-Za-z0-9_]+$/.test(form.stripePriceId.trim())) return setLocalError("Enter a valid Stripe Price ID.");
    for (const key of Object.keys(ENTITLEMENT_LABELS) as EntitlementKey[]) {
      const value = form.entitlements[key];
      if (value !== "unlimited" && (!Number.isSafeInteger(value) || value <= 0)) {
        return setLocalError(ENTITLEMENT_LABELS[key] + " must be a positive integer or unlimited.");
      }
    }
    setSaving(true);
    try {
      await onSave(form, isNew);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to save plan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between border-b border-slate-800 px-6 py-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-300">Plan catalog</p>
            <h2 className="mt-1 text-lg font-semibold text-white">{isNew ? "Create plan" : "Edit plan"}</h2>
            <p className="mt-1 text-sm text-slate-400">
              The Stripe Price ID points to the price customers are charged through.
            </p>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white disabled:opacity-50">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-5 px-6 py-6 sm:grid-cols-2">
          {isNew && (
            <Field label="Plan ID">
              <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="business" className={INPUT} />
            </Field>
          )}

          <Field label="Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Business" className={INPUT} />
          </Field>

          <Field label="Stripe Price ID">
            <input value={form.stripePriceId} onChange={(e) => setForm({ ...form, stripePriceId: e.target.value })} placeholder="price_..." className={INPUT + " font-mono"} />
          </Field>

          <Field label="Stripe Product ID (optional)">
            <input value={form.stripeProductId} onChange={(e) => setForm({ ...form, stripeProductId: e.target.value })} placeholder="prod_..." className={INPUT + " font-mono"} />
          </Field>

          <Field label="Currency">
            <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toLowerCase() })} maxLength={3} className={INPUT} />
          </Field>

          <Field label="Billing interval">
            <select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} className={INPUT}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </Field>

          <Field label="Display order">
            <input type="number" min={0} value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })} className={INPUT} />
          </Field>

          <Field label="Description" full>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Short description shown in the public catalog." className={INPUT + " resize-none"} />
          </Field>

          <div className="sm:col-span-2 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="mb-3">
              <div className="text-sm font-semibold text-white">Runtime entitlements</div>
              <p className="mt-1 text-xs text-slate-500">These values are enforced server-side for the tenant using this plan.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {(Object.keys(ENTITLEMENT_LABELS) as EntitlementKey[]).map((key) => (
                <Field key={key} label={ENTITLEMENT_LABELS[key]}>
                  <input
                    value={String(form.entitlements[key])}
                    onChange={(e) => updateEntitlement(key, e.target.value)}
                    placeholder="Unlimited or number"
                    className={INPUT}
                  />
                </Field>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-slate-200">Active for new sales</span>
              <span className="mt-0.5 block text-xs text-slate-500">Archived plans stay valid for existing subscribers.</span>
            </span>
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="h-4 w-4 accent-indigo-500" />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-slate-200">Public in pricing</span>
              <span className="mt-0.5 block text-xs text-slate-500">Hide private plans from the public catalog.</span>
            </span>
            <input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} className="h-4 w-4 accent-indigo-500" />
          </label>
        </div>

        {localError && (
          <div role="alert" className="mx-6 mb-5 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{localError}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-800 bg-slate-950/40 px-6 py-4">
          <button onClick={onClose} disabled={saving} className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? "Saving..." : isNew ? "Create plan" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

const INPUT = "w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none transition focus:border-indigo-500/40 focus:ring-2 focus:ring-indigo-500/15";

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={full ? "sm:col-span-2 space-y-2" : "space-y-2"}>
      <span className="block text-sm font-medium text-slate-200">{label}</span>
      {children}
    </label>
  );
}
