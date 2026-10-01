"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Copy,
  KeyRound,
  ShieldCheck,
  Workflow,
  Plus,
  Trash2,
  Ban,
  Info,
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  Callout,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Menu,
  Modal,
  PageContainer,
  PageHeader,
  StatusBadge,
  Skeleton,
  type MenuItemSpec,
  type Tone,
} from "../../components/ui";
import { copyTextToClipboard } from "../../lib/clipboard";

type ApiKey = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  readOnlyUntil: string | null;
  rotationState: "active" | "retiring" | "revoked";
  odooEnabled: boolean;
  odooEnabledRevision: number;
  odooEnabledUpdatedAt: string | null;
};

function rotationMeta(key: ApiKey): { label: string; tone: Tone } {
  // Defensive: older API payloads may omit rotationState — a key that is not
  // revoked is active. Never render an undefined badge.
  if (key.revokedAt || key.rotationState === "revoked") return { label: "Revoked", tone: "neutral" };
  if (key.rotationState === "retiring") return { label: "Retiring", tone: "warn" };
  return { label: "Active", tone: "ok" };
}

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
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function confirm() {
    if (!pending) return;
    const cur = pending; setPending(null); setBusy(true);
    try {
      const r = await fetch("/api/odoo/keys", { method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(cur.kind === "revoke" ? { id: cur.id } : { id: cur.id, remove: true }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setKeys(await loadKeys());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const active = keys.filter(k => !k.revokedAt).length;
  const enabled = keys.filter(k => !k.revokedAt && k.odooEnabled).length;
  const disabled = Math.max(0, active - enabled);

  const keyMenu = (k: ApiKey): MenuItemSpec[] => [
    {
      key: "copy",
      label: "Copy key ID",
      icon: <Copy className="h-4 w-4" />,
      onSelect: () => void copyTextToClipboard(k.id),
    },
    ...(k.revokedAt
      ? [
          {
            key: "remove",
            label: "Remove key…",
            icon: <Trash2 className="h-4 w-4" />,
            tone: "danger" as const,
            separatorBefore: true,
            disabled: busy,
            onSelect: () => setPending({ kind: "remove", id: k.id, name: k.name }),
          },
        ]
      : [
          {
            key: "revoke",
            label: "Revoke key…",
            icon: <Ban className="h-4 w-4" />,
            tone: "danger" as const,
            separatorBefore: true,
            disabled: busy,
            onSelect: () => setPending({ kind: "revoke", id: k.id, name: k.name }),
          },
        ]),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Integration"
        icon={<KeyRound className="h-4 w-4" />}
        title="Odoo integration"
        description="Credentials Odoo uses to submit documents to this Gateway, and the state of that connection."
        meta={
          active > 0 ? (
            <StatusBadge tone={enabled > 0 ? "ok" : "warn"} label={`${active} active`} />
          ) : (
            <StatusBadge tone="neutral" label="Not connected" />
          )
        }
      />

      <PageContainer>
        <div className="space-y-6">
          {error && (
            <ErrorState
              title="Credential operation failed"
              message={error}
              retry={() => {
                setError(null);
                void loadKeys().then(setKeys).catch(() => setError("Failed to load keys"));
              }}
            />
          )}

          {hasSubscription === false && (
            <Callout
              tone="warn"
              title="Choose a plan before connecting Odoo"
              action={
                <Button variant="primary" size="sm" href="/billing">
                  Choose a plan
                </Button>
              }
            >
              Creating credentials is disabled until the workspace has a subscription.
            </Callout>
          )}

          {rawKey && (
            <Callout
              tone="brand"
              title="New API key — copy it now"
              icon={<KeyRound className="h-4 w-4" aria-hidden />}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => { if (await copyTextToClipboard(rawKey)) setCopied(true); }}
                  icon={<Copy className="h-3.5 w-3.5" />}
                >
                  {copied ? "Copied" : "Copy key"}
                </Button>
              }
            >
              <div className="space-y-2">
                <p>
                  This is the only time the full credential is shown. Paste it into the Yaseir
                  module settings in Odoo.
                </p>
                <code className="block select-all break-all rounded-md border border-edge bg-surface px-3 py-2 font-mono text-xs text-ink">
                  {rawKey}
                </code>
              </div>
            </Callout>
          )}

          <section aria-label="Integration summary" className="overflow-hidden rounded-xl border border-edge bg-surface shadow-card">
            <div className="grid grid-cols-1 divide-y divide-edge-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="p-4">
                <div className="label-caps">Active keys</div>
                <div className="mt-1.5 text-2xl font-[640] leading-none tracking-[-0.02em] text-ink tabular">
                  {loading ? "—" : active}
                </div>
                <div className="mt-1.5 text-xs text-ink-3">
                  {active === 0 ? "No credential issued" : "Usable by Odoo right now"}
                </div>
              </div>
              <div className="p-4">
                <div className="label-caps">Odoo connections</div>
                <div className="mt-1.5 text-2xl font-[640] leading-none tracking-[-0.02em] text-ink tabular">
                  {loading ? "—" : enabled}
                </div>
                <div className="mt-1.5 text-xs text-ink-3">
                  {active === 0 ? "Waiting for a key" : `${disabled} disabled at the source`}
                </div>
              </div>
              <div className="p-4">
                <div className="label-caps">Access level</div>
                <div className="mt-1.5 flex items-center gap-2 text-md font-[600] text-ink">
                  {active === 0 ? (
                    <StatusBadge tone="neutral" label="Not connected" />
                  ) : enabled === active ? (
                    <StatusBadge tone="ok" label="Integration read / write · All documents" />
                  ) : (
                    <StatusBadge tone="warn" label="Integration disabled in Odoo" />
                  )}
                </div>
                <div className="mt-1.5 text-xs text-ink-3">Scoped to this workspace only.</div>
              </div>
            </div>
          </section>

          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.85fr)]">
            <div className="space-y-5">
              <Card>
                <CardHeader
                  title="Connect Odoo"
                  subtitle="Generate the credential Odoo uses to reach the Gateway."
                  icon={<KeyRound className="h-4 w-4" />}
                />
                <form
                  onSubmit={(e) => { e.preventDefault(); void generate(); }}
                  className="space-y-4 px-5 py-5"
                >
                  <Field
                    label="Credential name"
                    htmlFor="key-name"
                    hint="Name it after the Odoo environment so revocation is unambiguous."
                  >
                    <Input
                      id="key-name"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Odoo Production"
                      disabled={busy}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-[52ch] text-sm leading-relaxed text-ink-3">
                      Keys carry read/write access to the Odoo integration and every supported
                      document payload.
                    </p>
                    <Button
                      type="submit"
                      variant="primary"
                      loading={busy}
                      disabled={busy || hasSubscription === false}
                      icon={busy ? undefined : <Plus className="h-4 w-4" />}
                      title={hasSubscription === false ? "Choose a plan first" : undefined}
                    >
                      {busy ? "Generating…" : "Generate key"}
                    </Button>
                  </div>
                </form>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader
                  title="Credentials"
                  subtitle={`${keys.length} issued for this workspace`}
                  icon={<ShieldCheck className="h-4 w-4" />}
                />

                {loading ? (
                  <div className="space-y-3 px-5 py-5" role="status" aria-label="Loading credentials">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex items-center justify-between gap-4">
                        <div className="space-y-2">
                          <Skeleton className="h-3.5 w-40" />
                          <Skeleton className="h-2.5 w-56" />
                        </div>
                        <Skeleton className="h-8 w-20" />
                      </div>
                    ))}
                    <span className="sr-only">Loading credentials…</span>
                  </div>
                ) : keys.length === 0 ? (
                  <EmptyState
                    icon={<KeyRound className="h-5 w-5" />}
                    title="No credentials yet"
                    description="Generate a key, then paste it into the Yaseir module settings in Odoo to start submitting documents."
                  />
                ) : (
                  <ul className="divide-y divide-edge-subtle">
                    {keys.map(k => {
                      const rotation = rotationMeta(k);
                      return (
                        <li
                          key={k.id}
                          className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 transition-colors duration-[140ms] hover:bg-surface-hover"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-[600] text-ink">{k.name}</span>
                              <StatusBadge tone={rotation.tone} label={rotation.label} size="sm" />
                              {!k.revokedAt && (
                                <StatusBadge
                                  tone={k.odooEnabled ? "ok" : "warn"}
                                  label={k.odooEnabled ? "Odoo enabled" : "Odoo disabled"}
                                  size="sm"
                                />
                              )}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                              <span>Created {new Date(k.createdAt).toLocaleDateString()}</span>
                              <span aria-hidden>·</span>
                              <span>
                                Last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never"}
                              </span>
                              {k.odooEnabledUpdatedAt && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span>Synced {new Date(k.odooEnabledUpdatedAt).toLocaleString()}</span>
                                </>
                              )}
                            </div>
                          </div>

                          <Menu
                            label={`Actions for ${k.name}`}
                            items={keyMenu(k)}
                            trigger={
                              <span className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-edge px-2.5 text-sm font-[550] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
                                {k.revokedAt ? "Manage" : "Revoke"}
                              </span>
                            }
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </div>

            <aside className="space-y-5">
              <Card>
                <CardHeader
                  title="How the connection works"
                  subtitle="Four steps from Odoo to paper."
                  icon={<Workflow className="h-4 w-4" />}
                />
                <ol className="space-y-4 px-5 py-5">
                  {[
                    ["Odoo connects", "Odoo authenticates to the Gateway with this credential."],
                    ["Gateway validates", "The key is checked against the workspace, subscription and integration state."],
                    ["Agent prints locally", "The job is queued, routed and executed by the Windows agent that owns the printer."],
                    ["Rotate safely", "Create the replacement key first, confirm it works, then revoke this one."],
                  ].map(([title, body], index) => (
                    <li key={title} className="flex gap-3">
                      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-edge bg-surface-2 text-2xs font-[650] text-ink-3 tabular">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-[600] text-ink">{title}</div>
                        <p className="mt-0.5 text-sm leading-relaxed text-ink-3">{body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>

              <Callout tone="info" icon={<Info className="h-4 w-4" />} title="Keys are shown once">
                Yaseir stores only a hash of each credential. If a key is lost, revoke it and issue a
                replacement — the raw value cannot be recovered.
              </Callout>

              <div className="text-sm text-ink-3">
                Need the module?{" "}
                <Link href="/settings" className="font-[550] text-brand hover:underline">
                  Review workspace settings
                </Link>
                .
              </div>
            </aside>
          </div>
        </div>
      </PageContainer>

      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending?.kind === "revoke" ? "Revoke this credential?" : "Remove this credential?"}
        description={pending?.name}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={pending?.kind === "revoke" ? "primary" : "danger"}
              onClick={() => void confirm()}
              loading={busy}
              disabled={busy}
            >
              {pending?.kind === "revoke" ? "Revoke key" : "Remove key"}
            </Button>
          </>
        }
      >
        {pending?.kind === "revoke" ? (
          <Callout tone="warn" title="Odoo loses access immediately">
            Documents submitted with this key stop being accepted. Create a replacement key first if
            you need uninterrupted printing.
          </Callout>
        ) : (
          <Callout tone="bad" title="This cannot be undone">
            The credential record is deleted permanently. Only revoked keys can be removed.
          </Callout>
        )}
      </Modal>
    </>
  );
}
