"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Building2, KeyRound, LockKeyhole, RefreshCw, Search, ShieldCheck, ShieldOff } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, SegmentedControl, StatusBadge, TableSkeleton, Textarea } from "../../../components/ui";
import { fetchWithTimeout } from "../../../lib/fetch-timeout";
import { useI18n } from "../../../i18n/react";
import { apiMessageKey } from "../../../lib/api-error-keys";

const PAGE_SIZE = 40;
type KeyRecord = {
  id: string; tenantId: string; tenantName: string; name: string; description: string | null;
  odooEnabled: boolean; revokedAt: string | null; readOnlyUntil: string | null; graceActive: boolean;
  createdAt: string; lastUsedAt: string | null;
  installationId: string | null; installationName: string | null; installationCount: number;
};
type InstallationRecord = {
  id: string; tenantId: string; tenantName: string; name: string; enabled: boolean;
  disabledAt: string | null; createdAt: string; credentialCount: number;
};
type RecordItem = KeyRecord | InstallationRecord;
type Action = { item: RecordItem; kind: "keys" | "installations"; operation?: "remove" };
const wording = {
  en: {
    title: "Integration control", eyebrow: "Gateway / Security operations", subtitle: "Inspect Odoo installations and API credentials across workspaces. Emergency actions revoke license access; they never expose secrets.",
    readOnlyGrace: "Rotation read-only grace", keys: "API credentials", installations: "Odoo installations", search: "Search name, ID, workspace", workspace: "Workspace ID (optional)", all: "All", active: "Active", inactive: "Inactive", refresh: "Refresh", integration: "Integration", owner: "Workspace", state: "Access", activity: "Last used / created", operation: "Control", revoke: "Revoke key", remove: "Delete key", quarantine: "Quarantine", reason: "Incident / change reason (optional)", cancel: "Cancel", confirm: "Apply security action", confirmTitle: "Confirm an irreversible access change", confirmed: "Gateway change saved and written to the audit trail.", unconfirmed: "The result could not be confirmed. Refresh inventory before repeating this action.", error: "Integration inventory unavailable", empty: "No matching integrations", page: "records", previous: "Previous", next: "Next", audit: "Audit log", safety: "Revoking an API key immediately ends its authorization, including read-only grace. Quarantining an Odoo installation blocks new v2 admissions; legacy v1 credentials may still work until separately revoked. Neither operation deletes audit history. Recovery needs an authenticated integration process.", denied: "Platform Owner access is required. No secrets are visible in this page.", role: "Platform Owner access only", never: "Secret values are never retrieved by this page.", credentials: "Credential bindings", issued: "Created", neverUsed: "Never used", noData: "—",
  },
  ar: {
    title: "التحكم في التكاملات", eyebrow: "الجيتواي / أمان التشغيل", subtitle: "جرد تثبيتات Odoo ومفاتيح API لكل العملاء. إجراءات الطوارئ توقف صلاحية الترخيص دون عرض أي أسرار.",
    readOnlyGrace: "فترة سماح للقراءة بعد التدوير", keys: "مفاتيح API", installations: "تثبيتات Odoo", search: "البحث بالاسم أو المعرّف أو العميل", workspace: "معرّف العميل (اختياري)", all: "الكل", active: "نشط", inactive: "معطّل", refresh: "تحديث", integration: "التكامل", owner: "العميل", state: "صلاحية الوصول", activity: "آخر استخدام / الإنشاء", operation: "التحكم", revoke: "إلغاء المفتاح", remove: "حذف المفتاح نهائيًا", quarantine: "حجر التثبيت", reason: "سبب الحادث أو الإجراء (اختياري)", cancel: "إلغاء", confirm: "تنفيذ إجراء الأمان", confirmTitle: "تأكيد تغيير مؤثر على صلاحيات الاتصال", confirmed: "تم تنفيذ الإجراء وتسجيله في سجل التدقيق.", unconfirmed: "تعذر تأكيد نتيجة الإجراء. حدّث قائمة التكاملات قبل تكراره.", error: "تعذر تحميل جرد التكاملات", empty: "لا توجد تكاملات مطابقة", page: "سجل", previous: "السابق", next: "التالي", audit: "سجل التدقيق", safety: "إلغاء مفتاح API يوقف استخدامه فورًا حتى لو كان في فترة سماح للقراءة. حجز تثبيت Odoo يمنع عمليات v2 الجديدة، لكن مفاتيح v1 القديم قد تظل فعالة ما لم تُلغَ منفصلةً. لا يتم حذف سجلات التدقيق. استعادة الاتصال تحتاج إجراء تكامل موثّق.", denied: "الصفحة متاحة فقط لمالك المنصة. لا تظهر الأسرار هنا.", role: "مالك المنصة فقط", never: "لا يتم تحميل بيانات المفاتيح السرية في هذه الصفحة.", credentials: "عدد بيانات الاتصال", issued: "أُنشئ", neverUsed: "لم يُستخدم", noData: "—",
  },
} as const;

function isKey(row: RecordItem): row is KeyRecord { return "odooEnabled" in row; }

export default function PlatformIntegrationsPage() {
  const { locale, formatDateTime, formatNumber, t: translate } = useI18n();
  const router = useRouter();
  const t = wording[locale];
  const [kind, setKind] = useState<"keys" | "installations">("keys");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [tenant, setTenant] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const [items, setItems] = useState<RecordItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Action | null>(null);
  
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [acting, setActing] = useState(false);
  const query = search.trim();
  const key = JSON.stringify([kind, status, query, tenant.trim(), offset, refresh]);
  const loading = loadedKey !== key;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function load() {
      if (query.length === 1) { setItems([]); setHasMore(false); setError(""); setLoadedKey(key); return; }
      const params = new URLSearchParams({ kind, status, limit: String(PAGE_SIZE), offset: String(offset) });
      if (query) params.set("search", query);
      if (tenant.trim()) params.set("tenantId", tenant.trim());
      try {
        const response = await fetchWithTimeout(`/api/platform/integrations?${params}`, { signal: controller.signal, cache: "no-store" });
        if (cancelled) return;
        if (response.status === 401) {
          setSelected(null); setReason(""); setActionError("");
          router.replace("/platform/login");
        }
        if (!response.ok) throw new Error(`${response.status}`);
        const data = await response.json() as { items?: RecordItem[]; hasMore?: boolean };
        if (cancelled) return;
        setItems(Array.isArray(data.items) ? data.items : []);
        setHasMore(data.hasMore === true);
        setError("");
      } catch { if (!cancelled) { setError(t.error); setItems([]); setHasMore(false); } }
      finally { if (!cancelled) setLoadedKey(key); }
    }
    void load();
    return () => { cancelled = true; controller.abort(); };
  }, [key, kind, status, query, tenant, offset, t.error, router]);

  function close() {
    if (acting) return;
    setSelected(null);
    setReason("");
    
    setActionError("");
  }
  async function applyAction() {
    if (!selected || acting) return;
    setActing(true);
    setActionError("");
    try {
      const endpoint = selected.kind === "keys" ? "revoke" : "quarantine";
      const operationEndpoint = selected.operation === "remove" ? "remove" : endpoint;
      const response = await fetchWithTimeout(`/api/platform/integrations/${operationEndpoint}`, {
        method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: selected.item.tenantId, id: selected.item.id, confirmed: true, reason: reason.trim() }),
      });
      const result = await response.json().catch(() => null) as { code?: string; ok?: boolean; tenantId?: string; id?: string; revoked?: boolean; removed?: boolean; quarantined?: boolean } | null;
      if (!response.ok) {
        if (response.status === 401) {
          setItems([]); setHasMore(false); setSelected(null); setReason(""); router.replace("/platform/login");
        } else if (response.status === 403) {
          setSelected(null); setItems([]); setHasMore(false); setReason(""); setActionError("");
          router.replace("/platform/login");
          return;
        }
        setActionError(translate(apiMessageKey(result?.code, response.status, "errors.operationFailed")));
        return;
      }
      // An HTTP 2xx alone is not evidence that the intended credential or
      // installation was actually changed. Bind the acknowledgement to the
      // exact selected workspace, resource, and security operation.
      const expectedProof = selected.operation === "remove" ? "removed"
        : selected.kind === "keys" ? "revoked" : "quarantined";
      if (result?.ok !== true || result.tenantId !== selected.item.tenantId ||
          result.id !== selected.item.id || result[expectedProof] !== true) {
        setActionError(t.unconfirmed);
        return;
      }
      setNotice(t.confirmed);
      setSelected(null);
      setReason("");
      
      setRefresh(x => x + 1);
    } catch {
      // A lost response does not prove whether revocation/deletion committed.
      // Keep the selected action visible and let the operator refresh first.
      setActionError(t.unconfirmed);
    }
    finally { setActing(false); }
  }

  return (
    <div className="space-y-5 pb-10">
      <PageHeader variant="inline" title={t.title}  icon={<KeyRound className="h-5 w-5" />} 
        actions={<Button variant="secondary" size="sm" disabled={loading} loading={loading} onClick={() => setRefresh(v => v + 1)} icon={<RefreshCw className="h-4 w-4" />}>{t.refresh}</Button>} />
      <div className="rounded-xl border border-edge bg-surface p-4 sm:p-5">
        <div className="mb-4"><SegmentedControl value={kind} label={t.title}
          options={[{ value: "keys", label: t.keys }, { value: "installations", label: t.installations }]}
          onChange={(value) => { setKind(value); setOffset(0); setStatus("all"); }} /></div>
        <div className="grid gap-3 md:grid-cols-[2fr_1fr]">
          <label className="relative"><span className="sr-only">{t.search}</span><Search className="absolute start-3 top-3 h-4 w-4 text-ink-3" aria-hidden /><input value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} maxLength={64} placeholder={t.search} className="h-11 w-full rounded-lg border border-edge bg-surface-2 ps-10 pe-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-brand" /></label>
          <label><span className="sr-only">{t.workspace}</span><input dir="ltr" value={tenant} onChange={e => { setTenant(e.target.value); setOffset(0); }} maxLength={120} placeholder={t.workspace} className="h-11 w-full rounded-lg border border-edge bg-surface-2 px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-brand" /></label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["all", "active", "inactive"] as const).map(value => <button key={value} type="button" aria-pressed={status === value} onClick={() => { setStatus(value); setOffset(0); }} className={`min-h-11 rounded-full border px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-brand ${status === value ? "border-brand bg-brand-subtle text-brand" : "border-edge text-ink-3 hover:bg-surface-2"}`}>{t[value]}</button>)}
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-xl border border-warn-edge bg-warn-bg p-4 text-sm text-ink-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /><span>{t.safety}</span></div>
      {notice && <div role="status" className="rounded-lg border border-ok-edge bg-ok-bg p-3 text-sm text-ok">{notice}</div>}
      {error && <ErrorState title={t.error} message={error} retry={() => setRefresh(v => v + 1)} />}
      {!error && <Card className="overflow-hidden">
        <div className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" role="region" aria-label={t.title} aria-busy={loading} tabIndex={0}><table role="table" className="data-table operational-table md:min-w-[800px]"><caption className="sr-only">{t.title}</caption><thead><tr><th scope="col">{t.integration}</th><th scope="col">{t.owner}</th><th scope="col">{t.state}</th><th scope="col">{t.activity}</th><th scope="col">{t.operation}</th></tr></thead>
          <tbody>{loading ? <tr><td colSpan={5}><TableSkeleton rows={5} /></td></tr> : items.length === 0 ? <tr><td colSpan={5}><EmptyState icon={<Building2 className="h-5 w-5" />} title={t.empty} description={query.length === 1 ? translate("platform.integrations.minChars") : undefined} /></td></tr> : items.map(row => {
            const active = isKey(row) ? (!row.revokedAt || row.graceActive) : row.enabled;
            return <tr key={`${row.tenantId}-${row.id}`}>
              <td><div className="flex items-center gap-2 font-semibold text-ink"><LockKeyhole className="h-4 w-4 text-brand" aria-hidden />{row.name}</div><div className="mt-1 font-mono text-xs text-ink-4" dir="ltr">{row.id}</div>{isKey(row) && row.installationName && <div className="mt-1 text-xs text-ink-3">{row.installationName}{row.installationCount > 1 ? ` (+${formatNumber(row.installationCount - 1)})` : ""}</div>}{!isKey(row) && <div className="mt-1 text-xs text-ink-3">{t.credentials}: {formatNumber(row.credentialCount)}</div>}</td>
              <td><span className="data-table-label" aria-hidden>{t.owner}</span><div className="text-sm text-ink">{row.tenantName}</div><div className="font-mono text-xs text-ink-4" dir="ltr">{row.tenantId}</div></td>
              <td><span className="data-table-label" aria-hidden>{t.state}</span><StatusBadge tone={active ? (isKey(row) && row.graceActive ? "warn" : "ok") : "warn"} label={active ? (isKey(row) && row.graceActive ? t.readOnlyGrace : t.active) : t.inactive} size="sm" />{isKey(row) && row.readOnlyUntil && <div className="mt-1 text-xs tabular-nums text-ink-3">{formatDateTime(row.readOnlyUntil)}</div>}</td>
              <td className="text-xs tabular-nums text-ink-3"><span className="data-table-label" aria-hidden>{t.activity}</span>{isKey(row) && row.lastUsedAt ? formatDateTime(row.lastUsedAt) : isKey(row) ? t.neverUsed : `${t.issued}: ${formatDateTime(row.createdAt)}`}</td>
              <td><span className="data-table-label" aria-hidden>{t.operation}</span><div className="flex flex-wrap gap-2">
                {active && <Button size="xs" variant="secondary" onClick={() => { setSelected({ item: row, kind });  setReason(""); setActionError(""); }}>{kind === "keys" ? t.revoke : t.quarantine}</Button>}
                {kind === "keys" && <Button size="xs" variant="danger" onClick={() => { setSelected({ item: row, kind, operation: "remove" });  setReason(""); setActionError(""); }}>{t.remove}</Button>}
                {!active && kind !== "keys" && <span className="text-xs text-ink-4">{t.inactive}</span>}
              </div></td>
            </tr>;
          })}</tbody></table></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge p-4 text-xs text-ink-3"><span aria-live="polite" className="tabular-nums">{formatNumber(items.length)} {t.page}</span><div className="flex gap-2"><Button size="xs" variant="secondary" disabled={loading || offset === 0} onClick={() => setOffset(n => Math.max(0, n - PAGE_SIZE))}>{t.previous}</Button><Button size="xs" variant="secondary" disabled={loading || !hasMore} onClick={() => setOffset(n => n + PAGE_SIZE)}>{t.next}</Button></div></div>
      </Card>}
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3"><ShieldCheck className="h-4 w-4 text-ok" aria-hidden /><span>{t.never}</span><Link href="/platform/audit" className="font-semibold text-brand underline underline-offset-4">{t.audit}</Link></div>
      <Modal open={selected !== null} onClose={close} title={selected?.operation === "remove" ? t.remove : t.confirmTitle} description={selected?.operation === "remove" ? translate("platform.integrations.removeDescription") : t.safety} footer={<><Button disabled={acting} variant="secondary" onClick={close}>{t.cancel}</Button><Button disabled={acting} loading={acting} variant="danger" onClick={() => void applyAction()}>{t.confirm}</Button></>}>
        <p className="mb-4 text-sm text-ink-2">{selected?.item.name} · {selected?.item.tenantName}</p>
        
        <div className="mt-4"><Field label={t.reason} htmlFor="integration-reason"><Textarea id="integration-reason" disabled={acting} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} rows={3} /></Field></div>
        {actionError && <div role="alert" className="mt-4 flex items-center gap-2 text-sm text-bad"><ShieldOff className="h-4 w-4" aria-hidden />{actionError}</div>}
      </Modal>
    </div>
  );
}
