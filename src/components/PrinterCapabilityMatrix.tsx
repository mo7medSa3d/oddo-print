"use client";

import { useEffect, useState } from "react";

type Row = {
  printerId: string;
  name: string;
  transport: string;
  protocol: string;
  deviceClass: string;
  documentTypes: string[];
  status: string;
  driver: { name?: string; health: string };
  spooler: { name?: string; status: string };
};

function shortTransport(t: string) {
  const v = t.toLowerCase();
  if (v.includes("usb")) return "USB";
  if (v.includes("network") || v.includes("tcp")) return "NET";
  if (v.includes("spooler")) return "SPL";
  return t.slice(0, 3).toUpperCase() || "—";
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

  if (loading) return <div className="h-24 animate-pulse rounded-xl bg-zinc-100" />;
  if (!rows || rows.length === 0) return <div className="rounded-xl border border-dashed border-zinc-200 bg-white p-12 text-center text-[13px] font-medium text-zinc-500">No printers connected.</div>;

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="grid grid-cols-[1.5fr_0.6fr_0.8fr_0.6fr_0.6fr] gap-0 border-b border-zinc-100 bg-zinc-50 px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-zinc-400">
        <div>Printer</div>
        <div>Link</div>
        <div>Type</div>
        <div>Status</div>
        <div className="text-right">Driver</div>
      </div>
      {rows.map(r => {
        const online = r.status === "ONLINE" || r.status === "IDLE";
        return (
          <div key={r.printerId} className="grid grid-cols-[1.5fr_0.6fr_0.8fr_0.6fr_0.6fr] items-center gap-0 border-b border-zinc-100 px-5 py-3.5 last:border-0 hover:bg-zinc-50/70 transition">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-zinc-900">{r.name}</div>
              <div className="font-mono text-[10px] text-zinc-400">{r.printerId.slice(0, 12)}</div>
            </div>
            <div className="text-[11px] font-medium text-zinc-600">{shortTransport(r.transport)}</div>
            <div className="flex gap-1">
              {r.documentTypes.slice(0, 2).map(t => (
                <span key={t} className="rounded bg-zinc-900 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">{t.slice(0, 4)}</span>
              ))}
            </div>
            <div>
              <span className={`inline-flex h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-300"}`} />
              <span className="ml-1.5 text-[11px] font-semibold text-zinc-700">{online ? "Ready" : "Off"}</span>
            </div>
            <div className="text-right text-[11px] text-zinc-500 truncate">{r.driver.name || "Auto"}</div>
          </div>
        );
      })}
    </div>
  );
}
