"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleOff,
  FileText,
  Gauge,
  Loader2,
  Printer,
  Settings2,
  Usb,
  Wifi,
} from "lucide-react";

type Capability = {
  printerId: string;
  name: string;
  transport: string;
  protocol: string;
  deviceClass: string;
  documentTypes: string[];
  duplexCapable: boolean | null;
  colorCapable: boolean | null;
  paperWidths: number[] | null;
  driver: { name?: string; health: string; message: string };
  spooler: { name?: string; status: string; message: string };
  status: string;
  statusEvidence: string;
  lastSeenAt?: string;
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
};

function relativeTime(value?: string) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function pretty(value: string) {
  const normalized = value.toLowerCase().replace(/[_-]+/g, " ");
  const labels: Record<string, string> = {
    network: "Network",
    usb: "USB",
    spooler: "Windows Spooler",
    ipp: "IPP",
    ipps: "Secure IPP",
    raw: "Raw TCP",
    escpos: "ESC/POS",
    windows spooler: "Windows Spooler",
    thermal: "Thermal",
    laser: "Laser",
    inkjet: "Inkjet",
    label: "Label printer",
    physical: "Physical",
    online: "Online",
    idle: "Ready",
    busy: "Busy",
    offline: "Offline",
    error: "Error",
    unknown: "Unknown",
  };
  return labels[normalized] ?? value.replace(/[_-]+/g, " ");
}

function statusInfo(status: string) {
  switch (status.toLowerCase()) {
    case "online":
    case "idle":
      return { label: status.toLowerCase() === "idle" ? "Ready" : "Online", tone: "ok", icon: CheckCircle2 };
    case "busy":
      return { label: "Busy", tone: "warn", icon: Gauge };
    case "offline":
      return { label: "Offline", tone: "neutral", icon: CircleOff };
    case "error":
      return { label: "Error", tone: "bad", icon: CircleAlert };
    default:
      return { label: "Unknown", tone: "neutral", icon: AlertTriangle };
  }
}

function toneClasses(tone: string) {
  switch (tone) {
    case "ok": return "border-ok-edge bg-ok-bg text-ok";
    case "warn": return "border-warn-edge bg-warn-bg text-warn";
    case "bad": return "border-bad-edge bg-bad-bg text-bad";
    default: return "border-edge bg-surface-2 text-ink-3";
  }
}

function capabilityLabel(value: boolean | null, yes: string, no: string) {
  return value === null ? "Unknown" : value ? yes : no;
}

function PrinterCard({ printer }: { printer: Capability }) {
  const state = statusInfo(printer.status);
  const StatusIcon = state.icon;
  return (
    <article className="rounded-[14px] border border-edge bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-2 text-ink-2">
              <Printer className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-[13px] font-semibold text-ink">{printer.name}</h3>
              <div className="font-mono text-[10px] text-ink-3">{printer.printerId.slice(0, 12)}</div>
            </div>
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[9px] font-bold ${toneClasses(state.tone)}`}>
          <StatusIcon className="h-3 w-3" />
          {state.label}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-[9px] bg-surface-2 p-3">
          <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wide text-ink-3">
            {printer.transport.toLowerCase() === "usb" ? <Usb className="h-3 w-3" /> : <Wifi className="h-3 w-3" />}
            Connection
          </div>
          <div className="mt-1 text-[11px] font-semibold text-ink">{pretty(printer.transport)}</div>
        </div>
        <div className="rounded-[9px] bg-surface-2 p-3">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Protocol</div>
          <div className="mt-1 text-[11px] font-semibold text-ink">{pretty(printer.protocol)}</div>
        </div>
        <div className="rounded-[9px] bg-surface-2 p-3">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Printer type</div>
          <div className="mt-1 text-[11px] font-semibold text-ink">{pretty(printer.deviceClass)}</div>
        </div>
        <div className="rounded-[9px] bg-surface-2 p-3">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Last seen</div>
          <div className="mt-1 text-[11px] font-semibold text-ink">{relativeTime(printer.lastSeenAt)}</div>
        </div>
      </div>

      <div className="mt-3 rounded-[10px] border border-edge p-3">
        <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wide text-ink-3">
          <FileText className="h-3 w-3" /> Print features
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {printer.documentTypes.length > 0
            ? printer.documentTypes.map((type) => (
                <span key={type} className="rounded-full border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-2">{pretty(type)}</span>
              ))
            : <span className="text-[10px] text-ink-3">Document types not reported</span>}
          <span className="rounded-full border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-2">
            {capabilityLabel(printer.duplexCapable, "Duplex supported", "Single-sided only")}
          </span>
          <span className="rounded-full border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-2">
            {capabilityLabel(printer.colorCapable, "Color supported", "Monochrome")}
          </span>
          {printer.paperWidths?.length ? (
            <span className="rounded-full border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-2">
              Paper {printer.paperWidths.join(", ")}mm
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className={`rounded-[10px] border p-3 ${printer.driver.health === "ok" ? "border-ok-edge bg-ok-bg" : printer.driver.health === "error" ? "border-bad-edge bg-bad-bg" : "border-edge bg-surface-2"}`}>
          <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wide text-ink-3"><Settings2 className="h-3 w-3" /> Driver</div>
          <div className="mt-1 truncate text-[11px] font-semibold text-ink">{printer.driver.name ?? "Not reported"}</div>
          <div className="mt-1 text-[10px] leading-relaxed text-ink-2">{printer.driver.message}</div>
        </div>
        <div className="rounded-[10px] border border-edge bg-surface-2 p-3">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">Windows Spooler</div>
          <div className="mt-1 truncate text-[11px] font-semibold text-ink">{printer.spooler.name ?? "Not reported"}</div>
          <div className="mt-1 text-[10px] leading-relaxed text-ink-2">{printer.spooler.message}</div>
        </div>
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-ink-3">{printer.statusEvidence}</p>
    </article>
  );
}

export default function PrinterCapabilityMatrix() {
  const [rows, setRows] = useState<Capability[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/printers/capabilities", { cache: "no-store" });
        if (!res.ok) throw new Error(`Unable to load printer status (HTTP ${res.status}).`);
        const data = await res.json();
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unable to load printer status.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-[12px] border border-edge bg-surface p-4 text-xs text-ink-3">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading printer status…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-[12px] border border-bad-edge bg-bad-bg p-4 text-xs text-bad">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-[12px] border border-dashed border-edge bg-surface p-8 text-center">
        <Printer className="mx-auto h-5 w-5 text-ink-3" />
        <div className="mt-2 text-[13px] font-semibold text-ink">No printers connected</div>
        <p className="mt-1 text-[11px] text-ink-3">Register a printer with a connected Agent to see its capabilities here.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {rows.map((printer) => <PrinterCard key={printer.printerId} printer={printer} />)}
    </div>
  );
}
