"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Printer as PrinterIcon } from "lucide-react";
import { getProtocolDisplayName, getTransportDisplayName, type ProtocolType, type TransportType } from "../lib/printer-capability";
import { EmptyState, Skeleton, StatusBadge, type Tone } from "./ui";

/**
 * One row of the /api/printers/capabilities contract (see
 * src/lib/printer-health.ts — `PrinterCapabilityMatrix`). The backend is
 * evidence-based: status, driver and spooler health are derived from agent
 * observations, never assumed from stale database state. This component only
 * renders the distilled, human-readable projections of that evidence; it
 * never dumps raw diagnostic JSON.
 */
type Row = {
  printerId: string;
  name: string;
  transport?: string;
  protocol?: string;
  documentTypes?: string[];
  duplexCapable?: boolean | null;
  colorCapable?: boolean | null;
  paperWidths?: number[] | null;
  status: string;
  driver?: { name?: string; health?: string };
  spooler?: { name?: string; status?: string };
};

const STATUS_LABELS: Record<string, string> = {
  ONLINE: "Online",
  IDLE: "Idle",
  PRINTING: "Printing",
  PAPER_OUT: "Paper out",
  OFFLINE: "Offline",
  ERROR: "Error",
  DRIVER_ERROR: "Driver error",
  SPOOLER_ERROR: "Spooler error",
  UNREACHABLE: "Unreachable",
  UNKNOWN: "Unknown",
};

function shortStatus(status: string) {
  return STATUS_LABELS[status] ?? (status || "Unknown");
}

/** Tone mapping shared with the printer vocabulary used across the console. */
function statusTone(status: string): Tone {
  if (status === "ONLINE" || status === "IDLE") return "ok";
  if (status === "PRINTING") return "info";
  if (status === "OFFLINE" || status === "UNREACHABLE") return "neutral";
  if (status === "UNKNOWN") return "neutral";
  return "warn";
}

function featureChips(documentTypes: string[] | undefined, duplex: boolean | null | undefined, color: boolean | null | undefined) {
  const chips: string[] = [];
  for (const t of (documentTypes ?? []).slice(0, 3)) {
    chips.push(t === "escpos" ? "ESC/POS" : t.toUpperCase().slice(0, 6));
  }
  if (duplex) chips.push("Duplex");
  if (color) chips.push("Color");
  return chips;
}

export default function PrinterCapabilityMatrix() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/printers/capabilities", { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-2.5" role="status" aria-label="Loading printer capabilities">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}
        <span className="sr-only">Loading printer capabilities…</span>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        icon={<PrinterIcon className="h-5 w-5" aria-hidden />}
        title="No printers connected"
        description="Printers appear here once an agent on this workspace registers them."
        size="sm"
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
      <div className="grid min-w-[720px] grid-cols-[1.4fr_0.7fr_0.9fr_1.2fr_0.7fr_0.7fr_0.9fr] gap-0 border-b border-edge-subtle bg-surface-2 px-5 py-2.5">
        <div className="label-caps">Printer</div>
        <div className="label-caps">Link</div>
        <div className="label-caps">Protocol</div>
        <div className="label-caps">Print features</div>
        <div className="label-caps">Status</div>
        <div className="label-caps">Driver</div>
        <div className="label-caps">Spooler</div>
      </div>
      {rows.map(r => {
        const tone = statusTone(r.status);
        const chips = featureChips(r.documentTypes, r.duplexCapable, r.colorCapable);
        const driverName = r.driver?.name;
        const driverHealth = r.driver?.health;
        const spoolerName = r.spooler?.name;
        const spoolerStatus = r.spooler?.status;
        return (
          <div key={r.printerId} className="row-hover grid min-w-[720px] grid-cols-[1.4fr_0.7fr_0.9fr_1.2fr_0.7fr_0.7fr_0.9fr] items-center gap-0 border-b border-edge-subtle px-5 py-3.5 last:border-0">
            <div className="min-w-0">
              <div className="truncate text-base font-[550] text-ink">{r.name}</div>
              <div className="truncate font-mono text-xs text-ink-4">{r.printerId.slice(0, 12)}</div>
            </div>
            <div className="text-xs font-[550] text-ink-2">
              {r.transport ? getTransportDisplayName(r.transport as TransportType) : "—"}
            </div>
            <div className="text-xs font-[550] text-ink-2">
              {r.protocol ? getProtocolDisplayName(r.protocol as ProtocolType) : "—"}
            </div>
            <div className="flex flex-wrap gap-1">
              {chips.length === 0 ? (
                <span className="text-xs text-ink-4">—</span>
              ) : (
                chips.map(t => (
                  <span key={t} className="rounded-xs border border-edge bg-surface-2 px-1.5 py-0.5 text-2xs font-[550] text-ink-2">{t}</span>
                ))
              )}
            </div>
            <div className="flex items-center">
              <StatusBadge size="sm" tone={tone} label={shortStatus(r.status)} />
            </div>
            <div className="truncate text-xs text-ink-3">
              {driverName || "Auto"}
              {driverHealth === "error" && (
                <span className="ml-1.5 inline-flex items-center gap-1 text-warn">
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  <span className="sr-only">driver error</span>
                </span>
              )}
            </div>
            <div className="truncate text-xs text-ink-3">
              {spoolerName || (r.transport === "spooler" ? "Windows Spooler" : "—")}
              {spoolerStatus === "error" && (
                <span className="ml-1.5 inline-flex items-center gap-1 text-warn">
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  <span className="sr-only">spooler error</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
