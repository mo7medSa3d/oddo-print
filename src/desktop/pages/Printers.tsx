import React from "react";
import { Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, Play, Power, Archive, ShieldCheck } from "lucide-react";
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, LoadingState, Mono, Select, StatusBadge, StatusDot } from "../../components/ui";
import { Toolbar, PrinterAvatar } from "../ui";
import type { DesktopState } from "../types";
import { humanConnection, humanType, isProductionPrinter, labelPrinter, printerEndpoint, printerTone } from "../lib/printers";

export function PrintersPage({ s }: { s: DesktopState }) {
  const rows = s.filteredPrinters.filter(isProductionPrinter);
  const total = s.printers.filter(isProductionPrinter).length;

  return (
    <div className="space-y-5">
      <Toolbar>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={s.printersFilter} onChange={(e) => s.setPrintersFilter(e.target.value)} placeholder="Search by name, type or address…" className="pl-10 h-10 rounded-[10px]" aria-label="Search printers" />
        </div>
        <Select value={s.statusFilter} onChange={(e) => s.setStatusFilter(e.target.value as typeof s.statusFilter)} className="lg:w-44 h-10 rounded-[10px]" aria-label="Filter by status">
          <option value="all">All statuses</option><option value="online">Online</option><option value="busy">Busy</option><option value="offline">Offline</option><option value="error">Error</option><option value="unknown">Unknown</option>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />} className="h-10 rounded-[10px]">Add printer</Button>
          <Button variant="secondary" onClick={s.handleDiscover} loading={s.printersLoading} icon={<RefreshCw className="h-4 w-4" />} className="h-10 rounded-[10px]">Discover</Button>
          <Button variant="ghost" onClick={s.refreshPrinters} icon={<RefreshCw className="h-4 w-4" />} className="h-10">Refresh</Button>
        </div>
      </Toolbar>

      {s.printersError && !s.printersLoading && <ErrorState title="Could not load printers" message={s.printersError} retry={s.refreshPrinters} />}

      <Card className="overflow-hidden">
        <CardHeader title={<span className="flex items-center gap-2.5">Printers<span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink-3 border border-edge">{total} total</span></span>} subtitle="Physical print devices this agent can reach" icon={<PrinterIcon className="h-4 w-4 text-brand" />} />
        {s.printersLoading ? <div className="p-5"><LoadingState rows={5} /></div> : rows.length === 0 ? (
          <EmptyState icon={<PrinterIcon className="h-8 w-8" />} title={total === 0 ? "No printers connected" : "No matches"} description={total === 0 ? "Connect a physical printer, then run Discovery or add manually." : "Try different search or filter."} action={total === 0 ? <><Button variant="primary" onClick={s.handleDiscover} icon={<RefreshCw className="h-4 w-4" />}>Discover printers</Button><Button variant="secondary" onClick={() => s.setShowAdd(true)} icon={<Plus className="h-4 w-4" />}>Add printer</Button></> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="border-y border-edge bg-surface-2 text-left text-[11px] uppercase tracking-wide text-ink-3"><th className="px-5 py-2.5">Printer</th><th className="px-4 py-2.5">Type</th><th className="px-4 py-2.5">Connection</th><th className="px-4 py-2.5">Endpoint</th><th className="px-4 py-2.5">Connectivity</th><th className="px-4 py-2.5">Lifecycle</th><th className="px-4 py-2.5">Config</th><th className="px-5 py-2.5 text-right">Actions</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id} className="border-b border-edge last:border-0 hover:bg-surface-2/50 transition-colors">
                  <td className="px-5 py-3"><div className="flex items-center gap-3"><PrinterAvatar name={p.name} size="lg" tone={printerTone(p.status) === "neutral" ? "brand" : printerTone(p.status)} /><div className="min-w-0"><div className="truncate text-[13px] font-semibold text-ink">{p.name}</div><div className="truncate text-[11px] text-ink-4"><Mono>{p.id}</Mono></div></div></div></td>
                  <td className="px-4 py-3 text-ink-2">{humanType(p)}</td>
                  <td className="px-4 py-3 text-ink-2">{humanConnection(p)}</td>
                  <td className="px-4 py-3 text-[11px] text-ink-3"><Mono>{printerEndpoint(p)}</Mono></td>
                  <td className="px-4 py-3"><div className="space-y-1"><StatusBadge tone={printerTone(p.status)} label={labelPrinter(p.status)} /><div className="text-[10px] text-ink-4">{p.agentName || p.agentId || "Unassigned"} • {p.agentStatus || "unknown"}</div></div></td>
                  <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium border ${p.lifecycle === "retired" ? "bg-slate-100 border-slate-200 text-slate-600" : p.lifecycle === "disabled" ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-emerald-50 border-emerald-200 text-emerald-700"}`}>{p.lifecycle || "active"}</span></td>
                  <td className="px-4 py-3 text-[11px] text-ink-2">{p.managementSource === "manager" ? `${p.appliedDesiredRevision ?? 0} / ${p.desiredRevision ?? 0} ${p.configurationConverged ? "• Applied" : "• Pending"}` : "Agent-owned"}</td>
                  <td className="px-5 py-3"><div className="flex items-center justify-end gap-1.5"><Button size="sm" variant="secondary" onClick={() => s.handleTest(p.id)} icon={<Play className="h-3.5 w-3.5" />}>Test</Button>{p.managementSource === "manager" && (p.lifecycle || "active") === "active" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "disabled")} disabled={s.busy} icon={<Power className="h-3.5 w-3.5" />}>Disable</Button>}{p.managementSource === "manager" && p.lifecycle === "disabled" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "active")} disabled={s.busy} icon={<Power className="h-3.5 w-3.5" />}>Enable</Button>}{p.managementSource === "manager" && p.lifecycle !== "retired" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "retired")} disabled={s.busy} icon={<Archive className="h-3.5 w-3.5" />}>Retire</Button>}<Button size="sm" variant="ghost" onClick={() => s.setSelectedPrinter(p)} icon={<Eye className="h-3.5 w-3.5" />}>Details</Button></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {!s.printersLoading && rows.length > 0 && <div className="flex items-center gap-5 border-t border-edge px-5 py-3 text-[12px] text-ink-3"><span className="inline-flex items-center gap-1.5"><StatusDot tone="ok" /> {s.onlinePrinters} online</span><span className="inline-flex items-center gap-1.5"><StatusDot tone="bad" /> {s.offlinePrinters} need attention</span><span className="ml-auto inline-flex items-center gap-1.5 text-[11px]"><ShieldCheck className="h-3.5 w-3.5" /> Encrypted local transport</span></div>}
      </Card>
    </div>
  );
}
