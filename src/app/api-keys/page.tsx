"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Shield } from "lucide-react";
import Link from "next/link";
import { Button, Card, CardHeader, Input, Modal } from "../../components/ui";
import { copyTextToClipboard } from "../../lib/clipboard";

type ApiKey = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  odooEnabled: boolean;
  odooEnabledRevision: number;
  odooEnabledUpdatedAt: string | null;
};

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("Odoo Production");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<{ kind: "revoke" | "remove"; id: string; name: string } | null>(null);
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null);

  async function loadKeys() {
    const r = await fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (!r.ok) throw new Error("Failed to load keys");
    return (await r.json()) as ApiKey[];
  }

  useEffect(() => {
    let cancel = false;

    const tick = async (reportError: boolean) => {
      try {
        const d = await loadKeys();
        if (!cancel) setKeys(d);
      } catch (e) {
        if (!cancel && reportError) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancel && reportError) setLoading(false);
      }
    };

    // One immediate load followed by lightweight refreshes. Keeping both paths
    // behind the same loader avoids duplicate /api/odoo/keys calls on mount.
    void tick(true);
    const id = setInterval(() => void tick(false), 5000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    fetch("/api/billing/status", { cache: "no-store", credentials: "include" })
      .then(async (r) => {
        if (!r.ok) return;
        const b = (await r.json()) as { hasSubscription?: boolean };
        setHasSubscription(b.hasSubscription ?? null);
      })
      .catch(() => {});
  }, []);

  async function generate() {
    setBusy(true); setError(null); setRawKey(null);
    try {
      const r = await fetch("/api/odoo/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: name.trim() || "Odoo",
        }),
      });
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
  const enabled = keys.filter(k => !k.revokedAt && k.odooEnabled).length;
  const disabled = Math.max(0, active - enabled);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-5 py-8 sm:px-7 lg:px-8 lg:py-10">
      <header className="mb-7 flex flex-col gap-4 border-b border-edge/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4"><KeyRound className="h-3.5 w-3.5" /> Odoo Gateway</div>
          <h1 className="text-[28px] font-bold tracking-[-0.04em] text-ink">Odoo integration</h1>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-3">Connect Odoo and manage its access credentials.</p>
        </div>
        {active > 0 ? (
          <span className="text-[12px] font-semibold text-ink-3">{active} active</span>
        ) : null}
      </header>

      {error && <div className="mb-6 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] font-medium text-bad">{error}</div>}

      {hasSubscription === false && (
        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-warn-edge bg-warn-bg px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] font-medium text-warn">
            Choose a plan before connecting Odoo.
          </p>
          <Link
            href="/billing"
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-brand px-4 text-[12.5px] font-semibold text-brand-contrast transition hover:bg-brand-hover"
          >
            Choose a plan
          </Link>
        </div>
      )}

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-[14px] border border-edge bg-surface px-5 py-4 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Active keys</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${active ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">{active ? active : "None"}</span>
          </div>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface px-5 py-4 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Odoo connections</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${enabled > 0 ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">{active ? `${enabled} enabled · ${disabled} disabled` : "None"}</span>
          </div>
          
        </div>
        <div className="rounded-[14px] border border-edge bg-surface px-5 py-4 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">API access</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${enabled > 0 ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">
              {active === 0 ? "Not connected" : enabled === active ? "Read / write · All documents" : "Odoo integration disabled"}
            </span>
          </div>
        </div>
      </div>

      {rawKey && (
        <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-5 text-ink">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-widest text-brand">New API key — copy it now</div>
              <div className="mt-2 rounded-[10px] border border-brand-200 bg-surface px-3 py-3 font-mono text-[13px] font-medium break-all text-ink shadow-sm">{rawKey}</div>
            </div>
            <Button variant="secondary" size="sm" onClick={async () => { if (await copyTextToClipboard(rawKey)) setCopied(true); }} icon={<Copy className="h-4 w-4" />}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.75fr)]">
        <div className="space-y-6">
      <Card>
        <CardHeader title="Connect Odoo" subtitle="Generate the credential used by Odoo to reach the Gateway." icon={<KeyRound className="h-4 w-4 text-brand" />} />
        <form onSubmit={e => { e.preventDefault(); void generate(); }} className="px-5 pb-5 space-y-4">
          <div className="flex gap-3">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Odoo Production" className="h-9 flex-1" aria-label="Key name" />
            <Button type="submit" variant="primary" loading={busy} disabled={busy || hasSubscription === false} size="sm" title={hasSubscription === false ? "Choose a plan first" : undefined}>Generate</Button>
          </div>
          <p className="text-[12px] text-ink-3">This API key has read/write access to the Odoo integration and all supported document payloads.</p>
        </form>
      </Card>

      <div className="mt-6 overflow-hidden rounded-[14px] border border-edge bg-surface">
        <div className="border-b border-edge-subtle bg-surface-2 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Credentials • {keys.length}</div>
        {loading ? <div className="p-10 text-center text-[13px] text-ink-3">Loading…</div> : keys.length === 0 ? <div className="p-12 text-center text-[13px] font-medium text-ink-3">No keys.</div> : (
          <div className="divide-y divide-edge-subtle">
            {keys.map(k => (
              <div key={k.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-surface-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{k.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${k.revokedAt ? "border border-edge bg-surface-3 text-ink-3" : "border border-ok-edge bg-ok-bg text-ok"}`}>{k.revokedAt ? "Revoked" : "Active"}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-ink-3">
                    {new Date(k.createdAt).toLocaleDateString()} • Last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}
                    {!k.revokedAt ? (
                      <div className="mt-2 text-[11px] font-semibold text-ink-3">
                        Odoo access: {k.odooEnabled ? "Enabled" : "Disabled"}
                        {k.odooEnabledUpdatedAt ? ` · Synced ${new Date(k.odooEnabledUpdatedAt).toLocaleString()}` : ""}
                      </div>
                    ) : null}
                  </div>
                </div>
                {!k.revokedAt ? <Button variant="ghost" size="sm" onClick={() => setPending({ kind: "revoke", id: k.id, name: k.name })} disabled={busy}>Revoke</Button> : <Button variant="ghost" size="sm" className="text-ink-4" onClick={() => setPending({ kind: "remove", id: k.id, name: k.name })} disabled={busy}>Remove</Button>}
              </div>
            ))}
          </div>
        )}
      </div>
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader title="Connection flow" icon={<Shield className="h-4 w-4 text-ok" />} />
            <div className="space-y-4 px-5 pb-5 text-[13px] text-ink-2">
              {[
                ["01", "Odoo connects", "Odoo uses this credential to reach the Gateway."],
                ["02", "Gateway checks access", "The credential is checked against workspace and key permissions."],
                ["03", "Agent prints locally", "The job is queued, routed, and executed by the right Windows Agent."],
                ["04", "Rotate safely", "Create a replacement credential before revoking the old one."],
              ].map(([step, title, body]) => <div key={step} className="flex gap-3"><span className="font-mono text-[11px] font-bold text-brand">{step}</span><div><div className="font-semibold text-ink">{title}</div><p className="mt-1 text-[12px] leading-relaxed text-ink-3">{body}</p></div></div>)}
            </div>
          </Card>
        </aside>
      </div>

      <Modal open={!!pending} onClose={() => setPending(null)} title={pending?.kind === "revoke" ? "Revoke key?" : "Remove key?"}>
        <div className="text-[13px] text-ink-2">{pending?.name} — {pending?.kind === "revoke" ? "Odoo will lose access immediately." : "Permanent. Cannot be undone."}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPending(null)}>Cancel</Button>
          <Button variant={pending?.kind === "revoke" ? "secondary" : "danger"} size="sm" onClick={() => void confirm()} loading={busy}>{pending?.kind === "revoke" ? "Revoke" : "Remove"}</Button>
        </div>
      </Modal>
    </div>
  );
}
