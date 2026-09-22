"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Shield } from "lucide-react";
import Link from "next/link";
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
  odooEnabled: boolean;
  odooEnabledRevision: number;
  odooEnabledUpdatedAt: string | null;
};

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
  const [pending, setPending] = useState<{ kind: "revoke" | "remove"; id: string; name: string } | null>(null);
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null);

  async function loadKeys() {
    const r = await fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (!r.ok) throw new Error("Failed to load keys");
    return (await r.json()) as ApiKey[];
  }

  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      try {
        const d = await loadKeys();
        if (!cancel) setKeys(d);
      } catch { }
    };
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
  const enabled = keys.filter(k => !k.revokedAt && k.odooEnabled).length;
  const disabled = Math.max(0, active - enabled);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-5 py-8 sm:px-7 lg:px-8 lg:py-10">
      <header className="mb-7 flex flex-col gap-4 border-b border-edge/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4"><KeyRound className="h-3.5 w-3.5" /> Odoo Gateway</div>
          <h1 className="text-[28px] font-bold tracking-[-0.04em] text-ink">API Keys &amp; Integration</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">Create, rotate, and revoke credentials for Odoo. Credential security, Odoo activation, and Gateway connectivity are tracked independently.</p>
        </div>
        {active > 0 ? (
          <span className="text-[12px] font-semibold text-ink-3">{active} active</span>
        ) : null}
      </header>

      {error && <div className="mb-6 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] font-medium text-bad">{error}</div>}

      {hasSubscription === false && (
        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-warn-edge bg-warn-bg px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] font-medium text-warn">
            No active subscription on this workspace — pairing agents and configuring a Gateway are paused until you choose a plan.
          </p>
          <Link
            href="/billing"
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-brand px-4 text-[12.5px] font-semibold text-white transition hover:bg-brand-hover"
          >
            Choose a plan
          </Link>
        </div>
      )}

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-[14px] border border-edge bg-surface px-5 py-4 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Credential</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${active ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">{active ? `${active} Active` : "None"}</span>
          </div>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface px-5 py-4 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Odoo</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${enabled > 0 ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">{active ? `${enabled} Enabled · ${disabled} Disabled` : "No active integrations"}</span>
          </div>
          <div className="mt-1 text-[11px] text-ink-3">Activation is tracked independently for each Odoo API key.</div>
        </div>
        <div className="rounded-[14px] border border-edge bg-surface px-5 py-4 shadow-card">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Gateway</div>
          <div className="mt-2 flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${enabled > 0 ? "bg-ok-solid" : "bg-ink-4"}`} />
            <span className="text-[13px] font-semibold text-ink">
              {active === 0 ? "No credential" : enabled === active ? "Ready to print" : "Some integrations off"}
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
        <CardHeader title="Generate API Key" subtitle="Used in Odoo Gateway Configuration" icon={<KeyRound className="h-4 w-4 text-brand" />} />
        <form onSubmit={e => { e.preventDefault(); void generate(); }} className="px-5 pb-5 space-y-4">
          <div className="flex gap-3">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Odoo Production" className="h-9 flex-1" aria-label="Key name" />
            <Button type="submit" variant="primary" loading={busy} disabled={busy || hasSubscription === false} size="sm" title={hasSubscription === false ? "Choose a plan first" : undefined}>Generate</Button>
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

      <div className="mt-6 overflow-hidden rounded-[14px] border border-edge bg-surface">
        <div className="border-b border-edge-subtle bg-surface-2 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Keys • {keys.length}</div>
        {loading ? <div className="p-10 text-center text-[13px] text-ink-3">Loading…</div> : keys.length === 0 ? <div className="p-12 text-center text-[13px] font-medium text-ink-3">No keys.</div> : (
          <div className="divide-y divide-edge-subtle">
            {keys.map(k => (
              <div key={k.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-surface-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{k.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${k.revokedAt ? "border border-edge bg-surface-3 text-ink-3" : "border border-ok-edge bg-ok-bg text-ok"}`}>{k.revokedAt ? "Revoked" : "Active"}</span>
                    {!k.revokedAt ? (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${k.scope === "read_only" ? "bg-bad-bg text-bad" : "bg-surface-3 text-ink-3"}`} title={k.scope === "read_only" ? "This key cannot create print jobs" : "This key can read and print"}>
                        {k.scope === "read_only" ? "Read only" : "Standard"}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-[11px] text-ink-3">
                    {new Date(k.createdAt).toLocaleDateString()} • Last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}
                    {!k.revokedAt ? (
                      <div className="mt-2 text-[11px] font-semibold text-ink-3">
                        Odoo printing: {k.odooEnabled ? "Enabled" : "Disabled"} · Revision {k.odooEnabledRevision}
                        {k.odooEnabledUpdatedAt ? ` · Synced ${new Date(k.odooEnabledUpdatedAt).toLocaleString()}` : ""}
                      </div>
                    ) : null}
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
