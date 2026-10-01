"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTableShell,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Select,
  StatusBadge,
  TableScroll,
  TableSkeleton,
  Textarea,
} from "../../../components/ui";

type EntitlementKey = "max_agents" | "max_printers" | "max_jobs_per_minute" | "max_concurrent_jobs" | "max_prints_per_period";
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

const EMPTY_ENTITLEMENTS: Entitlements = { max_agents: 1, max_printers: 1, max_jobs_per_minute: 60, max_concurrent_jobs: 8, max_prints_per_period: "unlimited" };
const ENTITLEMENT_LABELS: Record<EntitlementKey, string> = { max_agents: "Agents", max_printers: "Printers", max_jobs_per_minute: "Jobs / min", max_concurrent_jobs: "Concurrent", max_prints_per_period: "Print jobs / period" };

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
  const [archiving, setArchiving] = useState<Plan | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

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
    setArchiveBusy(true);
    try {
      const res = await fetch(`/api/platform/plans/${plan.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: false }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to archive plan.");
      setNotice(`Plan "${plan.name}" archived. Existing subscriptions unchanged.`);
      setArchiving(null);
      refresh(false);
    } catch (err) { setError(err instanceof Error ? err.message : "Failed to archive plan."); }
    finally { setArchiveBusy(false); }
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
    <div className="space-y-6">
      <PageHeader
        variant="inline"
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            Commercial catalog
          </span>
        }
        title="Plans"
        description="Entitlements, Stripe linkage and catalog visibility for every subscription tier."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => refresh()}
              disabled={loading}
              icon={<RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />}
            >
              Refresh
            </Button>
            <Button variant="primary" onClick={openCreate} icon={<Plus className="h-4 w-4" aria-hidden />}>
              New plan
            </Button>
          </div>
        }
      />

      {notice && (
        <Callout tone="ok" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />}>
          <span role="status">{notice}</span>
        </Callout>
      )}
      {error && !loading && (
        <ErrorState message={error} retry={() => refresh(false)} />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="Plan catalog"
          subtitle={loading ? "Loading catalog…" : `${filtered.length} of ${plans.length} plan${plans.length === 1 ? "" : "s"}`}
          icon={<ShieldAlert className="h-4 w-4" aria-hidden />}
          actions={
            <div className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, ID or Stripe Price ID…"
                aria-label="Search plans"
                className="ps-9"
              />
            </div>
          }
        />

        {loading ? (
          <TableSkeleton rows={5} columns={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="h-5 w-5" aria-hidden />}
            title={plans.length === 0 ? "No plans in the catalog" : "No matching plans"}
            description={
              plans.length === 0
                ? "Create the first plan to define what a tenant can print, run and connect."
                : "No plan matches this search. Try a plan name, ID, or Stripe Price ID."
            }
            action={
              <Button variant="primary" onClick={openCreate} icon={<Plus className="h-4 w-4" aria-hidden />}>
                New plan
              </Button>
            }
          />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Visibility</th>
                <th scope="col">Limits</th>
                <th scope="col">Subscribers</th>
                <th scope="col">Stripe price</th>
                <th scope="col" className="text-end">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((plan) => (
                <tr key={plan.id}>
                  <td>
                    <div className="text-base font-[600] text-ink">{plan.name}</div>
                    <Mono className="mt-0.5 block">{plan.id}</Mono>
                    {plan.description && (
                      <div className="mt-1 line-clamp-2 max-w-xs text-xs text-ink-4">{plan.description}</div>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1.5">
                      {plan.isActive ? (
                        <StatusBadge size="sm" tone="ok" label="Active" />
                      ) : (
                        <StatusBadge size="sm" tone="neutral" label="Archived" icon={<Archive className="h-3 w-3" aria-hidden />} />
                      )}
                      <StatusBadge
                        size="sm"
                        tone={plan.isPublic ? "brand" : "neutral"}
                        label={plan.isPublic ? "Public" : "Private"}
                        icon={plan.isPublic ? <Eye className="h-3 w-3" aria-hidden /> : <EyeOff className="h-3 w-3" aria-hidden />}
                      />
                    </div>
                  </td>
                  <td>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      {(Object.entries(plan.entitlements) as Array<[EntitlementKey, number | "unlimited"]>).map(([k, v]) => (
                        <div key={k} className="flex items-baseline gap-1.5">
                          <dt className="text-ink-4">{ENTITLEMENT_LABELS[k]}</dt>
                          <dd className="font-[550] tabular-nums text-ink">{v === "unlimited" ? "Unlimited" : v}</dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                  <td>
                    <div className="text-base font-[550] tabular-nums text-ink">{plan.activeSubscriberCount} active</div>
                    <div className="mt-0.5 text-xs text-ink-4">{plan.subscriberCount} total</div>
                  </td>
                  <td>
                    <Mono className="block">{plan.stripePriceId || "Not linked"}</Mono>
                    <div className="mt-0.5 text-xs text-ink-4">
                      {(plan.currency ?? "usd").toUpperCase()}
                      {plan.interval ? ` · per ${plan.interval}` : ""}
                    </div>
                  </td>
                  <td className="text-end">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEdit(plan)}
                        icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
                      >
                        Edit
                      </Button>
                      {plan.isActive && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => { setArchiving(plan); setError(null); }}
                          icon={<Archive className="h-3.5 w-3.5" aria-hidden />}
                        >
                          Archive
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Card>

      {(creating || editing) && (
        <PlanEditor initial={editing ? { id: editing.id, name: editing.name, description: editing.description, stripePriceId: editing.stripePriceId || "", stripeProductId: editing.stripeProductId || "", currency: editing.currency || "usd", interval: editing.interval || "month", displayOrder: editing.displayOrder, isActive: editing.isActive, isPublic: editing.isPublic, entitlements: editing.entitlements } : emptyForm()} isNew={creating} onClose={closeEditor} onSave={save} />
      )}

      <ConfirmDialog
        open={archiving !== null}
        onClose={() => { if (!archiveBusy) setArchiving(null); }}
        onConfirm={() => { if (archiving) void archivePlan(archiving); }}
        busy={archiveBusy}
        tone="primary"
        title={archiving ? `Archive “${archiving.name}”?` : "Archive plan"}
        description="The plan is removed from new sales. Existing subscriptions keep their entitlements."
        confirmLabel="Archive plan"
        cancelLabel="Keep plan"
      >
        {archiving && (
          <div className="flex items-start gap-3 rounded-sg border border-edge bg-surface-2 p-3.5">
            <ArchiveRestore className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <p className="text-sm leading-relaxed text-ink-2">
              <span className="font-[600] text-ink">{archiving.activeSubscriberCount} active</span>{" "}
              {archiving.activeSubscriberCount === 1 ? "subscription" : "subscriptions"} will stay on{" "}
              <span className="font-[550] text-ink">{archiving.name}</span> until they change plans.
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

function PlanEditor({ initial, isNew, onClose, onSave }: { initial: ReturnType<typeof emptyForm>; isNew: boolean; onClose: () => void; onSave: (form: ReturnType<typeof emptyForm>, isNew: boolean) => Promise<void>; }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={isNew ? "Create plan" : "Edit plan"}
      description={isNew ? "Define entitlements and Stripe linkage for a new tier." : `Editing ${form.name || "plan"} — changes apply to new checkouts.`}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving} loading={saving}>
            {saving ? "Saving…" : isNew ? "Create plan" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {isNew && (
          <Field label="Plan ID" hint="Lowercase identifier used in API payloads. Cannot be changed later." required>
            <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} placeholder="business" className="font-mono" />
          </Field>
        )}
        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Business" />
        </Field>
        <Field label="Stripe Price ID" hint="Required — checkouts reference this price object." required>
          <Input value={form.stripePriceId} onChange={(e) => setForm({ ...form, stripePriceId: e.target.value })} placeholder="price_…" className="font-mono" />
        </Field>
        <Field label="Stripe Product ID" hint="Optional — groups prices for the same product." optional>
          <Input value={form.stripeProductId} onChange={(e) => setForm({ ...form, stripeProductId: e.target.value })} placeholder="prod_…" className="font-mono" />
        </Field>
        <Field label="Currency">
          <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toLowerCase() })} maxLength={3} className="font-mono uppercase" />
        </Field>
        <Field label="Billing interval">
          <Select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })}>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
            <option value="year">Yearly</option>
          </Select>
        </Field>
        <Field label="Display order" hint="Lower numbers appear first in the public catalog.">
          <Input type="number" min={0} value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: Number(e.target.value) })} className="tabular-nums" />
        </Field>
        <Field label="Description" className="sm:col-span-2" hint="Shown in the public pricing catalog." optional>
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Short description shown in public catalog." className="resize-none" />
        </Field>

        <div className="sm:col-span-2 rounded-sg border border-edge bg-surface-2 p-4">
          <div className="mb-1 text-base font-[600] text-ink">Runtime entitlements</div>
          <p className="mb-4 text-sm leading-relaxed text-ink-3">
            Hard limits enforced by the gateway for every tenant on this plan.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(Object.keys(ENTITLEMENT_LABELS) as EntitlementKey[]).map((key) => (
              <Field
                key={key}
                label={ENTITLEMENT_LABELS[key]}
                hint={key === "max_prints_per_period" ? "1 admitted Gateway print job = 1 print credit. Same idempotent retry does not consume another credit." : undefined}
              >
                <Input value={String(form.entitlements[key])} onChange={(e) => updateEntitlement(key, e.target.value)} placeholder="Unlimited or number" className="tabular-nums" />
              </Field>
            ))}
          </div>
        </div>

        <label className="flex items-start justify-between gap-4 rounded-sg border border-edge bg-surface-2 px-4 py-3">
          <span className="min-w-0">
            <span className="block text-base font-[550] text-ink">Active for new sales</span>
            <span className="mt-0.5 block text-sm text-ink-3">Archived stays valid for existing subscribers.</span>
          </span>
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
        </label>
        <label className="flex items-start justify-between gap-4 rounded-sg border border-edge bg-surface-2 px-4 py-3">
          <span className="min-w-0">
            <span className="block text-base font-[550] text-ink">Public in pricing</span>
            <span className="mt-0.5 block text-sm text-ink-3">Hide private plans from the public catalog.</span>
          </span>
          <input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand" />
        </label>
      </div>

      {localError && (
        <Callout tone="bad" className="mt-4" icon={<CircleAlert className="h-4 w-4" aria-hidden />}>
          <span role="alert">{localError}</span>
        </Callout>
      )}
    </Modal>
  );
}
