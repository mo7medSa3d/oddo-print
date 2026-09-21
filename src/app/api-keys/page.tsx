"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Copy, KeyRound, Shield, Trash2, X, Lock, Clock } from "lucide-react";
import { Button, Card, CardHeader, Input, Field, Modal, StatusBadge } from "../../components/ui";
import { copyTextToClipboard } from "../../lib/clipboard";

type ApiKey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type Gw = { enabled: boolean; revision: number; updatedAt: string | null };

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("Odoo Production");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gw, setGw] = useState<Gw | null>(null);
  const [pending, setPending] = useState<{ kind: "revoke" | "remove"; id: string; name: string } | null>(null);

  async function loadKeys() {
    const r = await fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (!r.ok) throw new Error("Failed to load keys");
    return (await r.json()) as ApiKey[];
  }

  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/odoo/configuration", { cache: "no-store", credentials: "include" });
        if (!r.ok) return;
        const d = (await r.json()) as Gw;
        if (!cancel && typeof d.enabled === "boolean") setGw(d);
      } catch { }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" })
      .then(r => r.json()).then(d => setKeys(d)).catch(e => setError(String(e))).finally(() => setLoading(false));
  }, []);

  async function generate() {
    setBusy(true); setError(null); setRawKey(null);
    try {
      const r = await fetch("/api/odoo/keys", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ name: name.trim() || "Odoo" }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setRawKey(b.apiKey);
      setKeys(await loadKeys());
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function confirm() {
    if (!pending) return;
    const cur = pending; setPending(null); setBusy(true);
    try {
      const r = await fetch("/api/odoo/keys", { method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(cur.kind === "revoke" ? { id: cur.id } : { id: cur.id, remove: true }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setKeys(await loadKeys());
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  const active = keys.filter(k => !k.revokedAt).length;

  return (
    <div className="mx-auto max-w-[960px] px-6 py-10">
      <header className="mb-10 flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-zinc-900">API Keys</h1>
          <p className="mt-1 text-[13px] text-zinc-500">Odoo gateway credentials.</p>
        </div>
        <Link href="/dashboard" className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-[12px] font-semibold text-zinc-600 hover:bg-zinc-50">Console</Link>
      </header>

      {error && <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] font-medium text-red-700">{error}</div>}

      <div className="mb-8 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Credential</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${active ? "bg-zinc-900" : "bg-zinc-300"}`} />
            <span className="text-[13px] font-semibold text-zinc-900">{active ? `${active} Active` : "None"}</span>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Odoo</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${gw?.enabled ? "bg-emerald-500" : "bg-zinc-300"}`} />
            <span className="text-[13px] font-semibold text-zinc-900">{gw ? (gw.enabled ? "Enabled" : "Disabled") : "—"}</span>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Gateway</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-[13px] font-semibold text-zinc-900">Online</span>
          </div>
        </div>
      </div>

      {rawKey && (
        <div className="mb-6 rounded-xl border border-zinc-900 bg-zinc-900 p-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[12px] font-bold uppercase tracking-widest text-zinc-400">New key — copy once</div>
              <div className="mt-2 font-mono text-[13px] break-all">{rawKey}</div>
            </div>
            <Button variant="secondary" size="sm" onClick={async () => { if (await copyTextToClipboard(rawKey)) setCopied(true); }} icon={<Copy className="h-4 w-4" />}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader title="Generate" />
        <form onSubmit={e => { e.preventDefault(); generate(); }} className="flex gap-3 px-5 pb-5">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Odoo Production" className="h-9 flex-1" />
          <Button type="submit" variant="primary" loading={busy} disabled={busy} size="sm">Generate</Button>
        </form>
      </Card>

      <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-100 bg-zinc-50 px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-zinc-400">Keys • {keys.length}</div>
        {loading ? <div className="p-10 text-center text-[13px] text-zinc-500">Loading…</div> : keys.length === 0 ? <div className="p-12 text-center text-[13px] font-medium text-zinc-500">No keys.</div> : (
          <div className="divide-y divide-zinc-100">
            {keys.map(k => (
              <div key={k.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-zinc-50">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-zinc-900">{k.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${k.revokedAt ? "bg-zinc-100 text-zinc-500" : "bg-zinc-900 text-white"}`}>{k.revokedAt ? "Revoked" : "Active"}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">{new Date(k.createdAt).toLocaleDateString()} • Last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}</div>
                </div>
                {!k.revokedAt ? <Button variant="ghost" size="sm" onClick={() => setPending({ kind: "revoke", id: k.id, name: k.name })} disabled={busy}>Revoke</Button> : <Button variant="ghost" size="sm" className="text-zinc-400" onClick={() => setPending({ kind: "remove", id: k.id, name: k.name })} disabled={busy}>Remove</Button>}
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={!!pending} onClose={() => setPending(null)} title={pending?.kind === "revoke" ? "Revoke key?" : "Remove key?"}>
        <div className="text-[13px] text-zinc-600">{pending?.name} — {pending?.kind === "revoke" ? "Odoo will lose access immediately." : "Permanent. Cannot be undone."}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPending(null)}>Cancel</Button>
          <Button variant={pending?.kind === "revoke" ? "secondary" : "danger"} size="sm" onClick={() => void confirm()} loading={busy}>{pending?.kind === "revoke" ? "Revoke" : "Remove"}</Button>
        </div>
      </Modal>
    </div>
  );
}
