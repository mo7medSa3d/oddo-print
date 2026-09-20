"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Copy, KeyRound, Shield, Trash2, X } from "lucide-react";
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
  const [name, setName] = useState("Odoo");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gatewayConfig, setGatewayConfig] = useState<GatewayConfigurationState | null>(null);
  const [gatewayConfigError, setGatewayConfigError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    { kind: "revoke" | "remove"; id: string; name: string } | null
  >(null);

  async function load() {
    const response = await fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (!response.ok) throw new Error("Unable to load API keys.");
    return await response.json() as ApiKey[];
  }

  useEffect(() => {
    let cancelled = false;

    async function loadGatewayConfiguration() {
      try {
        const response = await fetch("/api/odoo/configuration", {
          cache: "no-store",
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error(
            response.status === 403
              ? "You do not have permission to view Gateway configuration status."
              : "Unable to load Odoo Gateway configuration status.",
          );
        }
        const data = await response.json() as GatewayConfigurationState;
        if (cancelled) return;
        if (
          typeof data.enabled !== "boolean" ||
          !Number.isInteger(data.revision) ||
          data.revision < -1
        ) {
          throw new Error("Gateway returned an invalid configuration status.");
        }
        setGatewayConfig({
          enabled: data.enabled,
          revision: data.revision,
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
        });
        setGatewayConfigError(null);
      } catch (err) {
        if (!cancelled) {
          setGatewayConfigError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void loadGatewayConfiguration();
    const interval = window.setInterval(loadGatewayConfiguration, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load API keys. Check the Gateway connection and try again.");
        const data = await response.json() as ApiKey[];
        if (!cancelled) setKeys(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function retryLoad() {
    setError(null);
    setLoading(true);
    void fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load API keys. Check the Gateway connection and try again.");
        setKeys(await response.json() as ApiKey[]);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setRawKey(null);
    setCopied(false);
    try {
      const response = await fetch("/api/odoo/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() || "Odoo" }),
      });
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
      const response = await fetch("/api/odoo/keys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          action.kind === "revoke"
            ? { id: action.id }
            : { id: action.id, remove: true },
        ),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.error ??
            (action.kind === "revoke"
              ? "Unable to revoke API key."
              : "Unable to remove API key."),
        );
      }
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
    if (await copyTextToClipboard(rawKey)) {
      setCopied(true);
    } else {
      setError("The browser blocked clipboard access. Select the key text and press Ctrl+C.");
    }
  }

  return (
    <main className="mx-auto max-w-[1100px] px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-brand"><KeyRound className="h-4 w-4" /> Gateway API Keys</div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Generate, revoke, and remove Odoo access</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-3">Keys are shown only once. The Gateway stores only a cryptographic hash; there is no branch or document-type scope here.</p>
        </div>
        <Link href="/dashboard" className="text-sm font-semibold text-brand hover:underline">Back to Console</Link>
      </div>

      {error && (
        <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bad-edge bg-bad-bg px-4 py-3 text-sm text-bad">
          <span>{error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={retryLoad} disabled={loading}>
            {loading ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader
          title="Odoo integration"
          subtitle="This status reflects the activation state synchronized from Odoo."
          icon={<Shield className="h-5 w-5 text-brand" />}
        />
        <div className="flex flex-col gap-3 px-6 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              {gatewayConfigError ? (
                <StatusBadge tone="warn" label="Status unavailable" />
              ) : gatewayConfig ? (
                <StatusBadge
                  tone={gatewayConfig.enabled ? "ok" : "neutral"}
                  label={gatewayConfig.enabled ? "Enabled in Odoo" : "Disabled in Odoo"}
                />
              ) : (
                <StatusBadge tone="neutral" label="Checking Odoo state…" />
              )}
            </div>
            <p className="mt-2 text-sm text-ink-3">
              Odoo controls whether printing is enabled. API credentials are managed separately.
            </p>
            {gatewayConfigError && (
              <p className="mt-1 text-xs text-bad" role="status">
                We could not refresh the Odoo integration status. Try again.
              </p>
            )}
          </div>
        </div>
      </Card>

      {rawKey && (
        <Card className="mb-6 border-edge-accent bg-surface-2">
          <CardHeader title="New API Key" subtitle="Copy it now. It will not be displayed again." icon={<Shield className="h-5 w-5 text-brand" />} />
          <div className="px-6 pb-6">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={rawKey} className="font-mono text-xs" aria-label="New raw API key" />
              <Button type="button" variant="primary" onClick={copyRawKey} icon={<Copy className="h-4 w-4" />}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader title="Generate API Key" subtitle="Use this key in Odoo Gateway Configuration." icon={<KeyRound className="h-5 w-5 text-brand" />} />
        <form onSubmit={(e) => { e.preventDefault(); generate(); }} className="grid gap-4 px-6 pb-6 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Key name" htmlFor="key-name">
            <Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </Field>
          <Button type="submit" variant="primary" loading={busy} disabled={busy} icon={<KeyRound className="h-4 w-4" />}>Generate API Key</Button>
        </form>
      </Card>

      <Card>
        <CardHeader title="Existing Keys" subtitle="Metadata only. Raw secrets are never recoverable." icon={<Shield className="h-5 w-5 text-brand" />} />
        <div className="divide-y divide-edge">
          {loading ? (
            <div className="px-6 py-8 text-sm text-ink-3" role="status">Loading API keys…</div>
          ) : keys.length === 0 ? (
            <div className="px-6 py-8 text-sm text-ink-3">No API keys configured. Generate one above to connect Odoo.</div>
          ) : keys.map((item) => (
            <div key={item.id} className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-ink">{item.name}</span>
                  <StatusBadge
                    tone={item.revokedAt ? "bad" : "ok"}
                    label={item.revokedAt ? "Revoked credential" : "Valid credential"}
                  />
                </div>
                <div className="mt-1 text-xs text-ink-3">Created {new Date(item.createdAt).toLocaleString()} · Last used {item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : "Never"}</div>
                <div className="mt-1 font-mono text-[11px] text-ink-3">{item.id}</div>
              </div>
              {!item.revokedAt ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setPendingAction({ kind: "revoke", id: item.id, name: item.name })}
                  disabled={busy}
                  icon={<Ban className="h-4 w-4" />}
                >
                  Revoke
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => setPendingAction({ kind: "remove", id: item.id, name: item.name })}
                  disabled={busy}
                  icon={<Trash2 className="h-4 w-4" />}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
    <Modal
      open={pendingAction !== null}
      onClose={() => {
        if (!busy) setPendingAction(null);
      }}
      title={pendingAction?.kind === "revoke" ? "Revoke API key?" : "Remove revoked API key?"}
      description={
        pendingAction?.kind === "revoke"
          ? "Odoo will lose access immediately. The key stays in the audit history as revoked."
          : "This permanently removes an already-revoked credential. Existing print-job history prevents removal when the key is referenced."
      }
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setPendingAction(null)}
            disabled={busy}
            icon={<X className="h-4 w-4" />}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={pendingAction?.kind === "revoke" ? "secondary" : "danger"}
            onClick={() => void confirmAction()}
            loading={busy}
            disabled={busy}
            icon={
              pendingAction?.kind === "revoke"
                ? <Ban className="h-4 w-4" />
                : <Trash2 className="h-4 w-4" />
            }
          >
            {pendingAction?.kind === "revoke" ? "Revoke key" : "Remove key"}
          </Button>
        </>
      }
    >
      <div className="rounded-xl border border-edge bg-surface-2 px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warn-bg text-warn">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{pendingAction?.name}</p>
            <p className="mt-1 text-sm leading-6 text-ink-3">
              {pendingAction?.kind === "revoke"
                ? "Only the credential is affected. Your Odoo integration setting remains controlled by Odoo."
                : "This action cannot be undone and is separate from the Odoo integration enabled/disabled state."}
            </p>
          </div>
        </div>
      </div>
    </Modal>

    </main>
  );
}
