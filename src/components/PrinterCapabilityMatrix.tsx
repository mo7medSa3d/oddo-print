"use client";

import { useEffect, useState } from "react";
import { getProtocolDisplayName, getTransportDisplayName, type ProtocolType, type TransportType } from "../lib/printer-capability";

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

function shortStatus(s: string) {
  switch (s) {
    case "ONLINE": return "Online";
    case "IDLE": return "Idle";
    case "PRINTING": return "Printing";
    case "PAPER_OUT": return "Paper out";
    case "OFFLINE": return "Offline";
    case "ERROR": return "Error";
    case "DRIVER_ERROR": return "Driver error";
    case "SPOOLER_ERROR": return "Spooler error";
    case "UNREACHABLE": return "Unreachable";
    case "UNKNOWN": return "Unknown";
    default: return s || "Unknown";
  }
}

function statusTone(s: string) {
  if (s === "ONLINE" || s === "IDLE") return "bg-ok-solid";
  if (s === "PRINTING") return "bg-info-solid";
  if (s === "OFFLINE") return "bg-ink-4";
  return "bg-warn-bg0";
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

  if (loading) return <div className="h-24 animate-pulse rounded-xl bg-surface-3" />;
  if (!rows || rows.length === 0) return <div className="rounded-xl border border-dashed border-edge bg-surface p-12 text-center text-[13px] font-medium text-ink-3">No printers connected.</div>;

  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
      <div className="grid min-w-[720px] grid-cols-[1.4fr_0.7fr_0.9fr_1.2fr_0.7fr_0.7fr_0.9fr] gap-0 border-b border-edge-subtle bg-surface-2 px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-ink-4">
        <div>Printer</div>
        <div>Link</div>
        <div>Protocol</div>
        <div>Print features</div>
        <div>Status</div>
        <div>Driver</div>
        <div>Spooler</div>
      </div>
      {rows.map(r => {
        const tone = statusTone(r.status);
        const chips = featureChips(r.documentTypes, r.duplexCapable, r.colorCapable);
        const driverName = r.driver?.name;
        const driverHealth = r.driver?.health;
        const spoolerName = r.spooler?.name;
        const spoolerStatus = r.spooler?.status;
        return (
          <div key={r.printerId} className="grid min-w-[720px] grid-cols-[1.4fr_0.7fr_0.9fr_1.2fr_0.7fr_0.7fr_0.9fr] items-center gap-0 border-b border-edge-subtle px-5 py-3.5 last:border-0 hover:bg-surface-2/70 transition">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-ink">{r.name}</div>
              <div className="font-mono text-[10px] text-ink-4">{r.printerId.slice(0, 12)}</div>
            </div>
            <div className="text-[11px] font-medium text-ink-2">
              {r.transport ? getTransportDisplayName(r.transport as TransportType) : "—"}
            </div>
            <div className="text-[11px] font-medium text-ink-2">
              {r.protocol ? getProtocolDisplayName(r.protocol as ProtocolType) : "—"}
            </div>
            <div className="flex flex-wrap gap-1">
              {chips.length === 0 ? (
                <span className="text-[11px] text-ink-4">—</span>
              ) : (
                chips.map(t => (
                  <span key={t} className="rounded bg-ink px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">{t}</span>
                ))
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`inline-flex h-1.5 w-1.5 rounded-full ${tone}`} />
              <span className="text-[11px] font-semibold text-ink-2">{shortStatus(r.status)}</span>
            </div>
            <div className="text-[11px] text-ink-3 truncate">
              {driverName || "Auto"}
              {driverHealth === "error" && <span className="ml-1 text-warn">⚠</span>}
            </div>
            <div className="text-[11px] text-ink-3 truncate">
              {spoolerName || (r.transport === "spooler" ? "Windows Spooler" : "—")}
              {spoolerStatus === "error" && <span className="ml-1 text-warn">⚠</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
