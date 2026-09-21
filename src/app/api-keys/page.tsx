"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Copy, KeyRound, Shield, Trash2, X, CheckCircle2, Network, Lock, Clock } from "lucide-react";
import { Button, Card, CardHeader, Input, Field, Modal, StatusBadge } from "../../components/ui";
import { copyTextToClipboard } from "../../lib/clipboard";

type ApiKey = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

type GatewayConfigurationState = {
  enabled: boolean;
  revision: number;
  updatedAt: string | null;
};

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("Odoo Production");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gatewayConfig, setGatewayConfig] = useState<GatewayConfigurationState | null>(null);
  const [gatewayConfigError, setGatewayConfigError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: "revoke" | "remove"; id: string; name: string } | null>(null);

  async function load() {
    const response = await fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (!response.ok) throw new Error("Unable to load API keys.");
    return await response.json() as ApiKey[];
  }

  useEffect(() => {
    let cancelled = false;
    async function loadGatewayConfiguration() {
      try {
        const response = await fetch("/api/odoo/configuration", { cache: "no-store", credentials: "include" });
        if (!response.ok) throw new Error(response.status === 403 ? "No permission to view Gateway config status." : "Unable to load Odoo Gateway configuration status.");
        const data = await response.json() as GatewayConfigurationState;
        if (cancelled) return;
        if (typeof data.enabled !== "boolean" || !Number.isInteger(data.revision) || data.revision < -1) throw new Error("Gateway returned invalid configuration status.");
        setGatewayConfig({ enabled: data.enabled, revision: data.revision, updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null });
        setGatewayConfigError(null);
      } catch (err) {
        if (!cancelled) setGatewayConfigError(err instanceof Error ? err.message : String(err));
      }
    }
    void loadGatewayConfiguration();
    const interval = window.setInterval(loadGatewayConfiguration, 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load API keys. Check Gateway connection and try again.");
        const data = await response.json() as ApiKey[];
        if (!cancelled) setKeys(data);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function retryLoad() {
    setError(null);
    setLoading(true);
    void fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load API keys. Check Gateway connection and try again.");
        setKeys(await response.json() as ApiKey[]);
      })
      .catch((err) => { setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { setLoading(false); });
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setRawKey(null);
    setCopied(false);
    try {
      const response = await fetch("/api/odoo/keys", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ name: name.trim() || "Odoo" }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to generate API key.");
      setRawKey(body.apiKey);
      setKeys(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction() {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/odoo/keys", { method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(action.kind === "revoke" ? { id: action.id } : { id: action.id, remove: true }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? (action.kind === "revoke" ? "Unable to revoke API key." : "Unable to remove API key."));
      setRawKey(null);
      setKeys(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyRawKey() {
    if (!rawKey) return;
    if (await copyTextToClipboard(rawKey)) setCopied(true);
    else setError("Browser blocked clipboard. Select text and press Ctrl+C.");
  }

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            <KeyRound className="h-3.5 w-3.5" /> Odoo Gateway
          </div>
          <h1 className="mt-4 text-[26px] font-bold tracking-[-0.02em] text-ink">API Keys & Integration</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">Create, rotate, and revoke credentials for Odoo. Odoo controls whether printing is enabled. API credentials are managed separately.</p>
        </div>
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 rounded-[9px] border border-edge bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink-2 hover:bg-surface-2">
          Back to Console
        </Link>
      </header>

      {error && (
        <div role="alert" className="mb-6 flex items-start justify-between gap-3 rounded-[12px] border border-bad-edge bg-bad-bg px-4 py-3 text-[13px] text-bad">
          <div className="flex items-start gap-2.5"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
          <Button type="button" variant="secondary" size="sm" onClick={retryLoad} disabled={loading}>{loading ? "Retrying…" : "Retry"}</Button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {/* Integration status — distinct states */}
          <Card>
            <CardHeader title="Odoo Integration Health" subtitle="Activation state synchronized from Odoo — distinct from credential state" icon={<Network className="h-4 w-4 text-brand" />} />
            <div className="px-6 pb-6 space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Credential</div>
                  <div className="mt-2 flex items-center gap-2">
                    {keys.filter(k => !k.revokedAt).length > 0 ? <StatusBadge tone="ok" label="Valid credential" /> : <StatusBadge tone="warn" label="No valid credential" />}
                  </div>
                  <div className="mt-2 text-[11px] text-ink-3">{keys.filter(k => !k.revokedAt).length} active • {keys.filter(k => k.revokedAt).length} revoked</div>
                </div>
                <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Odoo Activation</div>
                  <div className="mt-2">
                    {gatewayConfigError ? <StatusBadge tone="warn" label="Status unavailable" /> : gatewayConfig ? <StatusBadge tone={gatewayConfig.enabled ? "ok" : "neutral"} label={gatewayConfig.enabled ? "Enabled in Odoo" : "Disabled in Odoo"} /> : <StatusBadge tone="neutral" label="Checking…" />}
                  </div>
                  <div className="mt-2 text-[11px] text-ink-3">Revision {gatewayConfig?.revision ?? "—"} • Controlled by Odoo</div>
                </div>
                <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Connection</div>
                  <div className="mt-2">
                    {gatewayConfigError ? <StatusBadge tone="bad" label="Sync failed" /> : <StatusBadge tone="ok" label="Gateway reachable" />}
                  </div>
                  <div className="mt-2 text-[11px] text-ink-3">{gatewayConfig?.updatedAt ? `Updated ${new Date(gatewayConfig.updatedAt).toLocaleString()}` : "Live polling every 5s"}</div>
                </div>
              </div>
              <div className="rounded-[10px] bg-surface-2 border border-edge p-4 text-[12px] leading-relaxed text-ink-3">
                <div className="font-semibold text-ink flex items-center gap-2"><Shield className="h-4 w-4 text-brand" /> Security boundary</div>
                <p className="mt-1">Credential validity, Odoo activation, and connection health are never merged into one badge. Each reflects backend truth independently.</p>
              </div>
            </div>
          </Card>

          {rawKey && (
            <div className="relative overflow-hidden rounded-[14px] border border-edge-accent bg-gradient-to-br from-white to-[#f0f7ff] p-6 shadow-card">
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-brand to-transparent opacity-60" />
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-subtle border border-edge-accent text-brand"><Lock className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-ink">New API Key — copy now</div>
                  <div className="mt-1 text-[12px] text-ink-3">It will not be displayed again. Store it securely in Odoo Gateway Configuration.</div>
                  <div className="mt-4 flex gap-2">
                    <Input readOnly value={rawKey} className="font-mono text-[12px] h-10" aria-label="New raw API key" />
                    <Button type="button" variant="primary" onClick={copyRawKey} icon={<Copy className="h-4 w-4" />}>{copied ? "Copied" : "Copy"}</Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <Card>
            <CardHeader title="Generate API Key" subtitle="Used in Odoo Gateway Configuration" icon={<KeyRound className="h-4 w-4 text-brand" />} />
            <form onSubmit={(e) => { e.preventDefault(); generate(); }} className="px-6 pb-6 space-y-4">
              <Field label="Key name" hint="Descriptive name for audit logs">
                <Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Odoo Production" />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={busy} disabled={busy} icon={<KeyRound className="h-4 w-4" />}>Generate API Key</Button>
              </div>
            </form>
          </Card>

          <Card>
            <CardHeader title="Existing Keys" subtitle="Metadata only — raw secrets never recoverable" icon={<Shield className="h-4 w-4 text-brand" />} />
            <div className="divide-y divide-edge">
              {loading ? (
                <div className="px-6 py-10 text-center text-[13px] text-ink-3">Loading API keys…</div>
              ) : keys.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-2 text-ink-3"><KeyRound className="h-5 w-5" /></div>
                  <div className="mt-3 text-[13px] font-medium text-ink">No keys configured</div>
                  <div className="mt-1 text-[12px] text-ink-3">Generate one above to connect Odoo.</div>
                </div>
              ) : keys.map((item) => (
                <div key={item.id} className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between hover:bg-surface-2/40 transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-[14px] font-semibold text-ink">{item.name}</span>
                      <StatusBadge tone={item.revokedAt ? "bad" : "ok"} label={item.revokedAt ? "Revoked" : "Valid"} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-ink-3">
                      <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> Created {new Date(item.createdAt).toLocaleDateString()}</span>
                      <span>Last used {item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleDateString() : "Never"}</span>
                    </div>
                  </div>
                  {!item.revokedAt ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setPendingAction({ kind: "revoke", id: item.id, name: item.name })} disabled={busy} icon={<Ban className="h-4 w-4" />}>Revoke</Button>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPendingAction({ kind: "remove", id: item.id, name: item.name })} disabled={busy} icon={<Trash2 className="h-4 w-4" />} className="text-bad hover:bg-bad-bg hover:text-bad">Remove</Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="p-5">
              <div className="text-[13px] font-semibold text-ink flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-ok" /> How it works</div>
              <ol className="mt-3 space-y-2.5 text-[12px] leading-relaxed text-ink-3">
                <li className="flex gap-2"><span className="font-mono text-[11px] font-bold text-brand">01</span><span>Odoo sends print intent via Gateway API using this key.</span></li>
                <li className="flex gap-2"><span className="font-mono text-[11px] font-bold text-brand">02</span><span>Gateway validates tenant, entitlement, and key.</span></li>
                <li className="flex gap-2"><span className="font-mono text-[11px] font-bold text-brand">03</span><span>Job queued → agent claims → printer executes.</span></li>
                <li className="flex gap-2"><span className="font-mono text-[11px] font-bold text-brand">04</span><span>Odoo activation flag controls whether routing is enabled.</span></li>
              </ol>
            </div>
          </Card>
          <Card>
            <div className="p-5">
              <div className="text-[13px] font-semibold text-ink">State separation</div>
              <div className="mt-3 space-y-2">
                <div className="rounded-[8px] border border-ok-edge bg-ok-bg px-3 py-2 text-[11px]"><span className="font-semibold text-ok">VALID CREDENTIAL</span><span className="text-ink-2"> — API key is active and usable</span></div>
                <div className="rounded-[8px] border border-edge bg-surface-2 px-3 py-2 text-[11px]"><span className="font-semibold text-ink">ENABLED IN ODOO</span><span className="text-ink-2"> — Odoo flag allows printing</span></div>
                <div className="rounded-[8px] border border-warn-edge bg-warn-bg px-3 py-2 text-[11px]"><span className="font-semibold text-warn">SYNC PENDING</span><span className="text-ink-2"> — Odoo has not pushed latest config</span></div>
                <div className="rounded-[8px] border border-bad-edge bg-bad-bg px-3 py-2 text-[11px]"><span className="font-semibold text-bad">INVALID CREDENTIAL</span><span className="text-ink-2"> — Key revoked or missing</span></div>
                 <div className="rounded-[8px] border border-bad-edge bg-bad-bg px-3 py-2 text-[11px]"><span className="font-semibold text-bad">Revoked credential</span><span className="text-ink-2"> — Credential was explicitly revoked and cannot be used.</span></div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Modal open={pendingAction !== null} onClose={() => { if (!busy) setPendingAction(null); }} title={pendingAction?.kind === "revoke" ? "Revoke API key?" : "Remove revoked API key?"} description={pendingAction?.kind === "revoke" ? "Odoo will lose access immediately. Key stays in audit history as revoked." : "Permanently removes already-revoked credential. History may prevent removal if referenced."}>
        <div className="rounded-[12px] border border-edge bg-surface-2 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warn-bg text-warn"><AlertTriangle className="h-5 w-5" /></div>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-ink">{pendingAction?.name}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{pendingAction?.kind === "revoke" ? "Only credential affected. Odoo integration setting remains controlled by Odoo." : "Cannot be undone and is separate from Odoo enabled/disabled state."}</p>
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setPendingAction(null)} disabled={busy} icon={<X className="h-4 w-4" />}>Cancel</Button>
          <Button type="button" variant={pendingAction?.kind === "revoke" ? "secondary" : "danger"} onClick={() => void confirmAction()} loading={busy} disabled={busy} icon={pendingAction?.kind === "revoke" ? <Ban className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}>{pendingAction?.kind === "revoke" ? "Revoke key" : "Remove key"}</Button>
        </div>
      </Modal>
    </div>
  );
}
