"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Copy, Database, RefreshCw, Search, ShieldCheck, Table2, X } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, TableSkeleton } from "../../../components/ui";
import { copyTextToClipboard } from "../../../lib/clipboard";
import { fetchWithTimeout } from "../../../lib/fetch-timeout";
import { useI18n } from "../../../i18n/react";

type TableMeta = { name: string; columns: string[]; primaryKey: string | null };
type RecordRow = Record<string, unknown>;
type Result = { tables: TableMeta[]; selected: string | null; columns: string[]; rows: RecordRow[]; hasMore: boolean };
const PAGE_SIZE = 25;

export default function PlatformDatabasePage() {
  const { locale, formatNumber, formatDateTime } = useI18n();
  const router = useRouter();
  const ar = locale === "ar";
  const names: Record<string, [string, string]> = {
    id: ["المعرّف", "ID"], name: ["الاسم", "Name"], description: ["الوصف", "Description"],
    is_active: ["الحالة", "Status"], is_public: ["ظهور الباقة", "Visibility"],
    created_at: ["تاريخ الإنشاء", "Created"], updated_at: ["آخر تحديث", "Updated"],
  };
  const label = (key: string) => names[key]?.[ar ? 0 : 1] ?? key.replaceAll("_", " ");
  const display = (key: string, val: unknown): string => {
    if (val == null || val === "") return "—";
    if (typeof val === "boolean") return val ? (ar ? "نعم" : "Yes") : (ar ? "لا" : "No");
    if ((key === "created_at" || key === "updated_at") && typeof val === "string") return formatDateTime(val);
    return String(val);
  };
  const [tableFilter, setTableFilter] = useState("");
  // Capture the record and query, never its position in a mutable result set.
  const [expanded, setExpanded] = useState<{ requestKey: string; row: RecordRow } | null>(null);
  const [copyResult, setCopyResult] = useState<{ ok: boolean; value: string } | null>(null);
  const [table, setTable] = useState("");
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState(false);
  const [loadedKey, setLoadedKey] = useState("");
  const [version, setVersion] = useState(0);
  const requestKey = JSON.stringify([table, search, offset, version]);
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const params = new URLSearchParams({ offset: String(offset) });
    if (table) params.set("table", table);
    if (search) params.set("q", search);
    fetchWithTimeout(`/api/platform/database?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (active && response.status === 401) router.replace("/platform/login");
        if (!response.ok) throw new Error(String(response.status));
        return await response.json() as Result;
      })
      .then((result) => { if (active) { setData(result); setError(false); } })
      .catch(() => { if (active) { setData(null); setExpanded(null); setCopyResult(null); setError(true); } })
      .finally(() => { if (active) setLoadedKey(requestKey); });
    return () => { active = false; controller.abort(); };
  }, [table, search, offset, version, requestKey, router]);

  const visibleData = loading ? null : data?.selected === table ? data : null;
  const tables = (data?.tables ?? []).filter((item) => item.name.toLowerCase().includes(tableFilter.trim().toLowerCase()));
  const selectedMeta = visibleData?.tables.find((item) => item.name === table);
  const visibleRecord = !loading && expanded?.requestKey === requestKey ? expanded.row : null;
  const columns = visibleData?.columns.slice(0, 6) ?? [];

  function resetDetails() {
    setExpanded(null);
    setCopyResult(null);
  }

  function refresh() {
    resetDetails();
    setVersion((current) => current + 1);
  }

  function chooseTable(name: string) {
    resetDetails();
    setTable(name);
    setOffset(0);
    setSearch("");
    setInput("");
  }

  async function copyRecordId(value: unknown, trigger: HTMLButtonElement) {
    if (value === null || value === undefined) return;
    const text = String(value);
    const ok = await copyTextToClipboard(text);
    setCopyResult({ ok, value: text });
    // The legacy clipboard fallback briefly focuses a temporary textarea.
    if (trigger.isConnected) trigger.focus();
  }

  return (
    <div className="space-y-5 pb-10">
      <PageHeader variant="inline"
        title={ar ? "مستكشف قاعدة البيانات" : "Database Explorer"} 
        icon={<Database className="h-5 w-5" />} 
        actions={<Button variant="secondary" size="sm" loading={loading} onClick={refresh} icon={<RefreshCw className="h-4 w-4" />}>{ar ? "تحديث" : "Refresh"}</Button>}
      />
      <div className="flex items-center gap-2 rounded-xl border border-edge bg-surface p-4 text-sm text-ink-3">
        <ShieldCheck className="h-5 w-5 shrink-0 text-ok" aria-hidden />
        {ar ? "مالك المنصة فقط · نتائج محدودة · بدون استعلامات SQL أو أسرار" : "Platform Owner only · bounded records · no arbitrary SQL or credential secrets"}
      </div>
      {!loading && error && <ErrorState title={ar ? "تعذر قراءة البيانات" : "Database read failed"} message={ar ? "تعذر تحميل البيانات. راجع الاتصال وأعد المحاولة." : "Could not load records. Check the connection and retry."} retry={refresh} />}

      {!table && <>
        <label className="block">
          <span className="sr-only">{ar ? "ابحث عن جدول" : "Find a table"}</span>
          <Input value={tableFilter} onChange={(event) => setTableFilter(event.target.value)} placeholder={ar ? "ابحث عن جدول مثل printers أو tenants" : "Search tables, e.g. printers or tenants"} />
        </label>
        {loading ? <div role="status" aria-live="polite"><p className="mb-3 text-sm text-ink-3">{ar ? "جارٍ تحميل الجداول" : "Loading tables"}</p><LoadingState rows={3} /></div>
          : !error && tables.length === 0 ? <EmptyState
            icon={<Table2 className="h-6 w-6" />}
            title={tableFilter.trim() ? (ar ? "لا توجد جداول مطابقة" : "No matching tables") : (ar ? "لا توجد جداول متاحة" : "No available tables")}
            description={tableFilter.trim() ? (ar ? "غيّر اسم البحث أو امسحه لعرض الجداول المتاحة." : "Try another table name or clear the search to see available tables.") : undefined}
            action={tableFilter.trim() ? <Button onClick={() => setTableFilter("")}>{ar ? "مسح البحث" : "Clear search"}</Button> : undefined}
          />
          : !error && <section aria-label={ar ? "الجداول المتاحة" : "Available tables"} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {tables.map((item) => <button key={item.name} type="button" onClick={() => chooseTable(item.name)} className="rounded-xl border border-edge bg-surface p-5 text-start transition-colors hover:border-brand/50 focus-visible:outline-2 focus-visible:outline-brand">
              <span className="flex items-center gap-3"><span className="rounded-lg bg-surface-2 p-3"><Table2 className="h-5 w-5 text-brand" aria-hidden /></span><span className="min-w-0"><span className="block break-all text-sm font-semibold text-ink" dir="ltr">{item.name}</span><span className="mt-1 block text-xs tabular-nums text-ink-3">{formatNumber(item.columns.length)} {ar ? "عمود متاح" : "visible columns"}</span></span></span>
            </button>)}
          </section>}
      </>}

      {table && <Card className="overflow-hidden p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => chooseTable("")} icon={<ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />}>{ar ? "كل الجداول" : "All tables"}</Button>
          <h2 className="break-all text-base font-medium text-ink" dir="ltr">{table}</h2>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); resetDetails(); setSearch(input.trim()); setOffset(0); }} className="mb-4 flex flex-wrap gap-2">
          <label className="min-w-[160px] flex-1">
            <span className="sr-only">{ar ? "البحث بالاسم أو الحالة أو المعرّف" : "Search by name, status or ID"}</span>
            <Input maxLength={100} value={input} onChange={(event) => setInput(event.target.value)} placeholder={ar ? "ابحث بالاسم أو الحالة أو جزء من ID" : "Search by name, status or partial ID"} />
          </label>
          <Button type="submit" icon={<Search className="h-4 w-4" />}>{ar ? "بحث" : "Search"}</Button>
          <Button variant="secondary" onClick={() => { resetDetails(); setInput(""); setSearch(""); setOffset(0); }}>{ar ? "مسح البحث" : "Clear"}</Button>
        </form>

        <div className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" role="region" aria-label={ar ? `سجلات ${table}` : `${table} records`} aria-busy={loading} tabIndex={0}>
          <table role="table" className="data-table operational-table md:min-w-[720px]">
            <caption className="sr-only">{ar ? `سجلات ${table}` : `${table} records`}</caption>
            <thead><tr>{columns.map((column) => <th scope="col" key={column}>{label(column)}</th>)}<th scope="col">{ar ? "الإجراءات" : "Actions"}</th></tr></thead>
            <tbody>{loading ? <tr><td colSpan={columns.length + 1}><TableSkeleton rows={5} /></td></tr> : (visibleData?.rows ?? []).map((row, index) => <tr key={selectedMeta?.primaryKey ? String(row[selectedMeta.primaryKey]) : index}>
              {columns.map((column) => <td key={column} className="max-w-72 break-all font-mono text-xs tabular-nums" dir="auto"><span className="data-table-label font-sans" aria-hidden>{label(column)}</span>{display(column, row[column])}</td>)}
              <td className="whitespace-nowrap"><span className="data-table-label" aria-hidden>{ar ? "الإجراءات" : "Actions"}</span><div className="flex gap-2">
                <Button size="xs" variant="secondary" aria-expanded={visibleRecord === row} aria-controls={visibleRecord === row ? "database-record-details" : undefined} onClick={() => setExpanded(visibleRecord === row ? null : { requestKey, row })}>{ar ? "تفاصيل" : "Details"}</Button>
                {selectedMeta?.primaryKey && <Button size="xs" variant="secondary" icon={<Copy className="h-3 w-3" />} onClick={(event) => void copyRecordId(row[selectedMeta.primaryKey!], event.currentTarget)}>{ar ? "نسخ ID" : "Copy ID"}</Button>}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>

        {visibleRecord && <section id="database-record-details" aria-label={ar ? "تفاصيل السجل" : "Record details"} className="mt-4 rounded-xl border border-edge bg-surface-2 p-4">
          <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-ink">{ar ? "تفاصيل السجل" : "Record details"}</h3><Button size="xs" variant="secondary" onClick={() => setExpanded(null)} icon={<X className="h-4 w-4" />}>{ar ? "إغلاق" : "Close"}</Button></div>
          <dl className="grid gap-3 sm:grid-cols-2">{Object.entries(visibleRecord).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-xs text-ink-3">{label(key)}</dt><dd className="mt-1 break-all text-sm text-ink" dir="auto">{display(key, value)}</dd></div>)}</dl>
        </section>}
        {copyResult && <p role={copyResult.ok ? "status" : "alert"} className={`mt-3 flex flex-wrap items-center gap-2 text-xs ${copyResult.ok ? "text-ok" : "text-bad"}`}>
          {copyResult.ok && <Check className="h-4 w-4" aria-hidden />}
          {copyResult.ok ? (ar ? "تم نسخ المعرّف" : "ID copied") : (ar ? "تعذر النسخ. حدّد المعرّف وانسخه يدويًا:" : "Copy failed. Select and copy the ID manually:")}
          <code className="select-all break-all" dir="ltr">{copyResult.value}</code>
        </p>}
        {!loading && !error && visibleData?.rows.length === 0 && <EmptyState icon={<Search className="h-8 w-8" />} title={ar ? "لا توجد سجلات مطابقة" : "No matching records"} description={ar ? "غيّر البحث أو امسحه لعرض السجلات المتاحة." : "Change or clear the search to see available records."} />}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-3">
          <span role="status" aria-live="polite" className="tabular-nums">{loading ? (ar ? "جارٍ التحميل" : "Loading records") : `${formatNumber(visibleData?.rows.length ?? 0)} ${ar ? "سجل في هذه الصفحة" : "records on this page"}`}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" aria-label={ar ? "الصفحة السابقة" : "Previous page"} disabled={offset === 0 || loading} onClick={() => { resetDetails(); setOffset((current) => Math.max(0, current - PAGE_SIZE)); }}><ArrowLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden />{ar ? "السابق" : "Previous"}</Button>
            <Button size="sm" variant="secondary" aria-label={ar ? "الصفحة التالية" : "Next page"} disabled={!visibleData?.hasMore || loading} onClick={() => { resetDetails(); setOffset((current) => current + PAGE_SIZE); }}>{ar ? "التالي" : "Next"}<ArrowRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden /></Button>
          </div>
        </div>
      </Card>}
    </div>
  );
}
