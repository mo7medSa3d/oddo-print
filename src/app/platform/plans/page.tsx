"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, CircleAlert, CreditCard, Eye, EyeOff, Loader2, Pencil, Plus, RefreshCw, Search, ShieldAlert, X } from "lucide-react";

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

const EMPTY_ENTITLEMENTS: Entitlements = { max_agents: 1, max_printers: 1, max_jobs_per_minute: 60, max_concurrent_jobs: 8 };
const ENTITLEMENT_LABELS: Record<EntitlementKey, string> = { max_agents: "Agents", max_printers: "Printers", max_jobs_per_minute: "Jobs / min", max_concurrent_jobs: "Concurrent" };

function emptyForm() {
  return { id: "", name: "", description: "", stripePriceId: "", stripeProductId: "", currency: "usd", interval: "month", displayOrder: 0, isActive: true, isPublic: true, entitlements: { ...EMPTY_ENTITLEMENTS } };
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
      } catch (err) { if (!ignore) setError(err instanceof Error ? err.message : "Failed to load plans."); }
      finally { if (!ignore) setLoading(false); }
    }
    void load();
    return () => { ignore = true; };
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return plans;
    return plans.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.stripePriceId ?? "").toLowerCase().includes(q));
  }, [plans, search]);

  function refresh(clearNotice = true) { setLoading(true); setError(null); if (clearNotice) setNotice(null); setReloadKey((k) => k + 1); }
  function openCreate() { setCreating(true); setEditing(null); setError(null); }
  function openEdit(plan: Plan) { setEditing(plan); setCreating(false); setError(null); }
  function closeEditor() { setCreating(false); setEditing(null); }

  async function archivePlan(plan: Plan) {
    setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/platform/plans/${plan.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: false }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to archive plan.");
      setNotice(`Plan "${plan.name}" archived. Existing subscriptions unchanged.`);
      refresh(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to archive plan."); }
  }

  async function save(form: ReturnType<typeof emptyForm>, isNew: boolean) {
    setError(null); setNotice(null);
    const url = isNew ? "/api/platform/plans" : `/api/platform/plans/${form.id}`;
    const payload = { id: form.id, name: form.name, description: form.description, stripePriceId: form.stripePriceId, stripeProductId: form.stripeProductId || undefined, currency: form.currency, interval: form.interval, displayOrder: form.displayOrder, isActive: form.isActive, isPublic: form.isPublic, entitlements: form.entitlements };
    try {
      const res = await fetch(url, { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to save plan.");
      closeEditor();
      setNotice(isNew ? `Plan "${form.name}" created.` : `Plan "${form.name}" updated.`);
      refresh(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to save plan."); }
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-edge-strong bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            <ShieldAlert className="h-3.5 w-3.5" /> Commercial Catalog
          </div>
          <h1 className="mt-4 text-[26px] font-bold tracking-[-0.02em] text-ink leading-tight">Plans</h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-3">Manage what customers buy and runtime limits enforced by Gateway. Stripe is billing source of truth.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-full border border-edge-strong bg-surface-2 px-4 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-50">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh
          </button>
          <button onClick={openCreate} className="inline-flex items-center gap-2 rounded-full bg-brand text-white px-4 py-2.5 text-[13px] font-semibold hover:bg-brand-hover transition">
            <Plus className="h-4 w-4" /> New plan
          </button>
        </div>
      </section>

      {notice && <div role="status" className="flex items-start gap-3 rounded-[12px] border border-ok-edge bg-ok-bg px-4 py-3 text-[13px] text-ok"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{notice}</span></div>}
      {error && <div role="alert" className="flex items-start gap-3 rounded-[12px] border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] text-bad"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by plan name, ID, or Stripe Price ID…" className="w-full rounded-[12px] border border-edge-strong bg-surface py-2.5 pl-10 pr-4 text-[13px] text-ink placeholder-ink-4 outline-none focus:border-brand focus:ring-2 focus:ring-brand/15" />
      </div>

      <div className="overflow-hidden rounded-[14px] border border-edge bg-surface">
        <div className="border-b border-edge px-5 py-4"><h2 className="text-[13px] font-semibold text-ink">Plan catalog • {filtered.length}</h2><p className="mt-0.5 text-[11px] text-ink-4">Entitlements enforced server-side • Stripe Price ID required</p></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-[13px]">
            <thead className="border-b border-edge bg-surface-2 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
              <tr><th className="px-5 py-3">Plan</th><th className="px-5 py-3">Visibility</th><th className="px-5 py-3">Limits</th><th className="px-5 py-3">Subscribers</th><th className="px-5 py-3">Stripe Price</th><th className="px-5 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {filtered.map((plan) => (
                <tr key={plan.id} className="hover:bg-surface-hover transition">
                  <td className="px-5 py-4"><div className="font-semibold text-ink text-[13px]">{plan.name}</div><div className="mt-1 font-mono text-[11px] text-ink-4">{plan.id}</div>{plan.description && <div className="mt-1 max-w-xs truncate text-[11px] text-ink-4">{plan.description}</div>}</td>
                  <td className="px-5 py-4"><div className="flex flex-wrap gap-1.5"><span className={plan.isActive ? "rounded-full border border-ok-edge bg-ok-bg px-2 py-0.5 text-[11px] font-medium text-ok" : "rounded-full border border-edge-strong bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3"}>{plan.isActive ? "Active" : "Archived"}</span><span className={plan.isPublic ? "inline-flex items-center gap-1 rounded-full border border-edge-accent bg-brand-subtle px-2 py-0.5 text-[11px] font-medium text-brand-subtle-text" : "inline-flex items-center gap-1 rounded-full border border-edge-strong bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-3"}>{plan.isPublic ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}{plan.isPublic ? "Public" : "Private"}</span></div></td>
                  <td className="px-5 py-4"><div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-3">{Object.entries(plan.entitlements).map(([k, v]) => (<span key={k}><span className="text-ink-4">{ENTITLEMENT_LABELS[k as EntitlementKey]}:</span> <span className="font-medium text-ink tabular-nums">{v === "unlimited" ? "Unlimited" : v}</span></span>))}</div></td>
                  <td className="px-5 py-4 text-[11px]"><div className="text-ink font-medium tabular-nums">{plan.activeSubscriberCount} active</div><div className="mt-1 text-ink-4">{plan.subscriberCount} total</div></td>
                  <td className="px-5 py-4"><div className="font-mono text-[11px] text-ink-3">{plan.stripePriceId || "Not linked"}</div><div className="mt-1 text-[11px] text-ink-4">{plan.currency?.toUpperCase() || "—"}{plan.interval ? ` / ${plan.interval}` : ""}</div></td>
                  <td className="px-5 py-4 text-right"><div className="flex justify-end gap-2"><button onClick={() => openEdit(plan)} className="inline-flex items-center gap-1.5 rounded-full border border-edge-strong bg-surface-2 px-3 py-1.5 text-[11px] font-semibold text-ink-2 hover:bg-surface-3 hover:text-ink"><Pencil className="h-3 w-3" /> Edit</button>{plan.isActive && <button onClick={() => void archivePlan(plan)} className="inline-flex items-center gap-1.5 rounded-full border border-warn-edge bg-warn-bg px-3 py-1.5 text-[11px] font-semibold text-warn hover:brightness-95"><Archive className="h-3 w-3" /> Archive</button>}</div></td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && <tr><td colSpan={6} className="px-5 py-16 text-center text-[13px] text-ink-4">No plans found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {(creating || editing) && (
        <PlanEditor initial={editing ? { id: editing.id, name: editing.name, description: editing.description, stripePriceId: editing.stripePriceId || "", stripeProductId: editing.stripeProductId || "", currency: editing.currency || "usd", interval: editing.interval || "month", displayOrder: editing.displayOrder, isActive: editing.isActive, isPublic: editing.isPublic, entitlements: editing.entitlements } : emptyForm()} isNew={creating} onClose={closeEditor} onSave={save} />
      )}
    </div>
  );
}

function PlanEditor({ initial, isNew, onClose, onSave }: { initial: ReturnType<typeof emptyForm>; isNew: boolean; onClose: () => void; onSave: (form: ReturnType<typeof emptyForm>, isNew: boolean) => Promise<void>; }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => { function onKeyDown(e: KeyboardEvent) { if (e.key === "Escape" && !saving) onClose(); } window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [onClose, saving]);

  function updateEntitlement(key: EntitlementKey, value: string) { setForm((c) => ({ ...c, entitlements: { ...c.entitlements, [key]: value.trim().toLowerCase() === "unlimited" ? "unlimited" : Number(value) } })); }

  async function submit() {
    setLocalError(null);
    if (isNew && !form.id.trim()) return setLocalError("Plan ID is required.");
    if (!form.name.trim()) return setLocalError("Plan name is required.");
    if (!/^price_[A-Za-z0-9_]+$/.test(form.stripePriceId.trim())) return setLocalError("Enter a valid Stripe Price ID.");
    for (const key of Object.keys(ENTITLEMENT_LABELS) as EntitlementKey[]) { const v = form.entitlements[key]; if (v !== "unlimited" && (!Number.isSafeInteger(v) || v <= 0)) return setLocalError(`${ENTITLEMENT_LABELS[key]} must be positive integer or unlimited.`); }
    setSaving(true);
    try { await onSave(form, isNew); } catch (err) { setLocalError(err instanceof Error ? err.message : "Failed to save plan."); } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[2px]">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[16px] border border-edge-strong bg-surface shadow-2xl">
        <div className="flex items-start justify-between border-b border-edge px-6 py-5">
          <div><p className="text-[11px] font-semibold uppercase tracking-wide text-brand-subtle-text">Plan catalog</p><h2 className="mt-1 text-[16px] font-semibold text-ink">{isNew ? "Create plan" : "Edit plan"}</h2><p className="mt-1 text-[12px] text-ink-3">Stripe Price ID points to price customers are charged through.</p></div>
          <button onClick={onClose} disabled={saving} className="rounded-full p-1.5 text-ink-4 hover:bg-surface-3 hover:text-ink"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
          {isNew && <Field label="Plan ID"><input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="business" className={INPUT} /></Field>}
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Business" className={INPUT} /></Field>
          <Field label="Stripe Price ID"><input value={form.stripePriceId} onChange={(e) => setForm({ ...form, stripePriceId: e.target.value })} placeholder="price_..." className={`${INPUT} font-mono`} /></Field>
          <Field label="Stripe Product ID (optional)"><input value={form.stripeProductId} onChange={(e) => setForm({ ...form, stripeProductId: e.target.value })} placeholder="prod_..." className={`${INPUT} font-mono`} /></Field>
          <Field label="Currency"><input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toLowerCase() })} maxLength={3} className={INPUT} /></Field>
          <Field label="Billing interval"><select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })} className={INPUT}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></Field>
          <Field label="Display order"><input type="number" min={0} value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })} className={INPUT} /></Field>
          <Field label="Description" full><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Short description shown in public catalog." className={`${INPUT} resize-none`} /></Field>
          <div className="sm:col-span-2 rounded-[12px] border border-edge bg-surface-2 p-4">
            <div className="mb-3"><div className="text-[13px] font-semibold text-ink">Runtime entitlements</div><p className="mt-1 text-[11px] text-ink-4">Enforced server-side for tenant using this plan.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">{(Object.keys(ENTITLEMENT_LABELS) as EntitlementKey[]).map((key) => (<Field key={key} label={ENTITLEMENT_LABELS[key]}><input value={String(form.entitlements[key])} onChange={(e) => updateEntitlement(key, e.target.value)} placeholder="Unlimited or number" className={INPUT} /></Field>))}</div>
          </div>
          <label className="flex items-center justify-between gap-4 rounded-[12px] border border-edge bg-surface-2 px-4 py-3"><span><span className="block text-[13px] font-medium text-ink">Active for new sales</span><span className="mt-0.5 block text-[11px] text-ink-4">Archived stays valid for existing subscribers.</span></span><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="h-4 w-4 accent-brand" /></label>
          <label className="flex items-center justify-between gap-4 rounded-[12px] border border-edge bg-surface-2 px-4 py-3"><span><span className="block text-[13px] font-medium text-ink">Public in pricing</span><span className="mt-0.5 block text-[11px] text-ink-4">Hide private plans from public catalog.</span></span><input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} className="h-4 w-4 accent-brand" /></label>
        </div>
        {localError && <div role="alert" className="mx-6 mb-5 flex items-start gap-2.5 rounded-[12px] border border-bad-edge bg-bad-bg px-4 py-3 text-[12px] text-bad"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{localError}</span></div>}
        <div className="flex justify-end gap-2 border-t border-edge bg-surface-2/50 px-6 py-4">
          <button onClick={onClose} disabled={saving} className="rounded-full border border-edge-strong bg-surface-2 px-4 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-50">Cancel</button>
          <button onClick={() => void submit()} disabled={saving} className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-brand-hover disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}{saving ? "Saving…" : isNew ? "Create plan" : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}

const INPUT = "w-full rounded-xl border border-edge-strong bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink placeholder:text-ink-4 outline-none focus:border-brand focus:ring-2 focus:ring-brand/15";

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return <label className={full ? "sm:col-span-2 space-y-2" : "space-y-2"}><span className="block text-[12px] font-medium text-ink-2">{label}</span>{children}</label>;
}
