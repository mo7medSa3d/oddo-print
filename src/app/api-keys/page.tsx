"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Shield } from "lucide-react";
import { Button, Card, CardHeader, Input, Field, Modal, Select, StatusBadge } from "../../components/ui";
import { copyTextToClipboard } from "../../lib/clipboard";

type ApiKey = {
  id: string;
  name: string;
  scope?: string | null;
  allowedDocumentTypes?: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
type Gw = { enabled: boolean; revision: number; updatedAt: string | null };

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("Odoo Production");
  const [scope, setScope] = useState<"standard" | "read_only">("standard");
  const [typesInput, setTypesInput] = useState("");
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
    // Guard r.ok before parsing: on an expired/revoked session the route
    // returns 401 with an error body (not an array), and setting that into
    // `keys` crashes `keys.filter(...)` during render.
    fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load API keys");
        return (await r.json()) as ApiKey[];
      })
      .then((d) => setKeys(d))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function generate() {
    setBusy(true); setError(null); setRawKey(null);
    try {
      // allowedDocumentTypes is only meaningful with the key's scope: a
      // read_only key can list/read its scoped types, a standard key writes.
      // Send the list only when it is populated (schema treats empty/omitted
      // as "all document types").
      const types = typesInput.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
      const r = await fetch("/api/odoo/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: name.trim() || "Odoo",
          scope,
          ...(types.length ? { allowedDocumentTypes: types } : {}),
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

  return (
    <div className="mx-auto w-full max-w-[1520px] px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
      <header className="mb-8 flex flex-col gap-4 border-b border-edge pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-brand"><KeyRound className="h-3.5 w-3.5" /> Odoo Gateway</div>
          <h1 className="text-[32px] font-bold tracking-[-0.03em] text-ink">API Keys &amp; Integration</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">Create, rotate, and revoke credentials for Odoo. Credential security, Odoo activation, and Gateway connectivity are tracked independently.</p>
        </div>
        {active > 0 ? (
          <span className="text-[12px] font-semibold text-ink-3">{active} active</span>
        ) : null}
      </header>

      {error && <div className="mb-6 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] font-medium text-bad">{error}</div>}

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-edge bg-surface px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-ink-4">Credential</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${active ? "bg-ink" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">{active ? `${active} Active` : "None"}</span>
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-surface px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-ink-4">Odoo</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${gw?.enabled ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">{gw ? (gw.enabled ? "Enabled" : "Disabled") : "—"}</span>
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-surface px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-ink-4">Gateway</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${gw ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">
              {gw ? "Serving workspace" : "—"}
            </span>
          </div>
        </div>
      </div>

      {rawKey && (
        <div className="mb-6 rounded-xl border border-ink bg-ink p-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[12px] font-bold uppercase tracking-widest text-ink-4">New key — copy once</div>
              <div className="mt-2 font-mono text-[13px] break-all">{rawKey}</div>
            </div>
            <Button variant="secondary" size="sm" onClick={async () => { if (await copyTextToClipboard(rawKey)) setCopied(true); }} icon={<Copy className="h-4 w-4" />}>{copied ? "Copied" : "Copy"}</Button>
          </div>
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.75fr)]">
        <div className="space-y-6">
      <Card>
        <CardHeader title="Generate API Key" subtitle="Used in Odoo Gateway Configuration" icon={<KeyRound className="h-4 w-4 text-brand" />} />
        <form onSubmit={e => { e.preventDefault(); void generate(); }} className="px-5 pb-5 space-y-4">
          <div className="flex gap-3">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Odoo Production" className="h-9 flex-1" aria-label="Key name" />
            <Button type="submit" variant="primary" loading={busy} disabled={busy} size="sm">Generate</Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Scope" htmlFor="key-scope" hint="A read-only key cannot create print jobs; it can only read status and list jobs.">
              <Select id="key-scope" value={scope} onChange={(e) => setScope(e.target.value as "standard" | "read_only")} disabled={busy}>
                <option value="standard">Standard (read + print)</option>
                <option value="read_only">Read only</option>
              </Select>
            </Field>
            <Field label="Document types (optional)" htmlFor="key-types" hint="Comma-separated, e.g. receipt,kitchen. Leave empty to allow all document types.">
              <Input id="key-types" value={typesInput} onChange={(e) => setTypesInput(e.target.value)} placeholder="receipt,kitchen" disabled={busy} autoComplete="off" />
            </Field>
          </div>
        </form>
      </Card>

      <div className="mt-6 overflow-hidden rounded-xl border border-edge bg-surface">
        <div className="border-b border-edge-subtle bg-surface-2 px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-ink-4">Keys • {keys.length}</div>
        {loading ? <div className="p-10 text-center text-[13px] text-ink-3">Loading…</div> : keys.length === 0 ? <div className="p-12 text-center text-[13px] font-medium text-ink-3">No keys.</div> : (
          <div className="divide-y divide-edge-subtle">
            {keys.map(k => (
              <div key={k.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-surface-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{k.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${k.revokedAt ? "bg-surface-3 text-ink-3" : "bg-ink text-white"}`}>{k.revokedAt ? "Revoked" : "Active"}</span>
                    {!k.revokedAt ? (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${k.scope === "read_only" ? "bg-bad-bg text-bad" : "bg-surface-3 text-ink-3"}`} title={k.scope === "read_only" ? "This key cannot create print jobs" : "This key can read and print"}>
                        {k.scope === "read_only" ? "Read only" : "Standard"}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-[11px] text-ink-3">
                    {new Date(k.createdAt).toLocaleDateString()} • Last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}
                    {!k.revokedAt && Array.isArray(k.allowedDocumentTypes) && k.allowedDocumentTypes.length > 0 ? (
                      <span title={`Allowed document types: ${k.allowedDocumentTypes.join(", ")}`}> • {k.allowedDocumentTypes.length} type{k.allowedDocumentTypes.length === 1 ? "" : "s"}</span>
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
            <CardHeader title="How it works" icon={<Shield className="h-4 w-4 text-ok" />} />
            <div className="space-y-4 px-5 pb-5 text-[13px] text-ink-2">
              {[
                ["01", "Odoo sends print intent", "Odoo uses this key when it calls the Gateway API."],
                ["02", "Gateway validates access", "The key is checked for tenant, scope, and entitlement."],
                ["03", "Agent executes locally", "Jobs are queued safely, then claimed by the right agent."],
                ["04", "Rotate without downtime", "Create a replacement key before revoking the old one."],
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
