"use client";

import { useEffect, useState } from "react";

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

export default function PrinterCapabilityMatrix() {
  const [rows, setRows] = useState<Capability[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/printers/capabilities", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setRows(data);
      } catch (e: any) {
        setError(e.message ?? "Failed");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <div className="text-xs text-ink-3">Loading capability matrix…</div>;
  if (error) return <div className="text-xs text-bad">{error}</div>;
  if (!rows || rows.length === 0) return <div className="text-xs text-ink-3">No printers.</div>;

  return (
    <div className="overflow-auto rounded-xl border border-edge">
      <table className="min-w-full text-[12px]">
        <thead className="bg-zinc-50 text-[11px] uppercase text-zinc-500">
          <tr>
            <th className="px-3 py-2 text-left">Printer</th>
            <th className="px-3 py-2 text-left">Transport</th>
            <th className="px-3 py-2 text-left">Protocol</th>
            <th className="px-3 py-2 text-left">Document</th>
            <th className="px-3 py-2 text-left">Duplex</th>
            <th className="px-3 py-2 text-left">Color</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Driver</th>
            <th className="px-3 py-2 text-left">Spooler</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.printerId} className="border-t border-edge">
              <td className="px-3 py-2">
                <div className="font-semibold">{r.name}</div>
                <div className="font-mono text-[10px] text-zinc-400">{r.printerId.slice(0,12)}</div>
                <div className="text-[10px] text-zinc-500">{r.deviceClass}</div>
              </td>
              <td className="px-3 py-2">{r.transport}</td>
              <td className="px-3 py-2">{r.protocol}</td>
              <td className="px-3 py-2">{r.documentTypes.join(", ")}</td>
              <td className="px-3 py-2">{r.duplexCapable === null ? "?" : r.duplexCapable ? "Yes" : "No"}</td>
              <td className="px-3 py-2">{r.colorCapable === null ? "?" : r.colorCapable ? "Yes" : "No"}</td>
              <td className="px-3 py-2">
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${r.status === "ONLINE" || r.status === "IDLE" ? "bg-ok-bg text-ok border-ok-edge" : r.status === "OFFLINE" ? "bg-zinc-100" : "bg-bad-bg text-bad border-bad-edge"}`}>{r.status}</span>
                <div className="mt-1 max-w-[200px] text-[10px] text-zinc-500">{r.statusEvidence}</div>
              </td>
              <td className="px-3 py-2">
                <div className="text-[11px]">{r.driver.name ?? "unknown"}</div>
                <div className={`text-[10px] ${r.driver.health === "ok" ? "text-ok" : r.driver.health === "error" ? "text-bad" : "text-zinc-500"}`}>{r.driver.message}</div>
              </td>
              <td className="px-3 py-2">
                <div className="text-[11px]">{r.spooler.name ?? "—"}</div>
                <div className="text-[10px] text-zinc-500">{r.spooler.message}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
