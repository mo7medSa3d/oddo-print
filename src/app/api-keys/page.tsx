"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/react";
import type { Translator } from "../../i18n/translate";
import type { MessageKey } from "../../i18n/messages/en";
import Link from "next/link";
import {
  ChevronDown,
  Copy,
  KeyRound,
  ShieldCheck,
  Plus,
  Trash2,
  Ban,
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
  Modal,
  PageContainer,
  PageHeader,
  StatusBadge,
  Skeleton,
  StatusDot,
  type Tone,
} from "../../components/ui";
import { ensureCustomerSession } from "../../lib/session-config";
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

function rotationMeta(key: ApiKey, t: Translator): { label: string; tone: Tone } {
  // Defensive: older API payloads may omit rotationState — a key that is not
  // revoked is active. Never render an undefined badge.
  if (key.rotationState === "retiring") return { label: t("apiKeys.retiring"), tone: "warn" };
  if (key.revokedAt || key.rotationState === "revoked") return { label: t("apiKeys.revoked"), tone: "neutral" };
  return { label: t("apiKeys.active"), tone: "ok" };
}

export default function ApiKeysPage() {
  const refreshEpoch = useRef(0);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const { t, tc, formatDate, formatDateTime, formatNumber } = useI18n();
  const [name, setName] = useState(t("apiKeys.defaultName"));
  const [rawKeyId, setRawKeyId] = useState<string | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<{ kind: "revoke" | "remove"; id: string; name: string } | null>(null);
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null);

  const loadKeys = useCallback(async () => {
    if (!(await ensureCustomerSession()).authenticated) throw new Error(t("errors.sessionExpired"));
    const r = await fetch("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (!r.ok) throw new Error(t("apiKeys.loadFailed"));
    return (await r.json()) as ApiKey[];
  }, [t]);

  useEffect(() => {
    let cancel = false;

    const tick = async (reportError: boolean) => {
      const epoch = refreshEpoch.current;
      try {
        const d = await loadKeys();
        if (!cancel && epoch === refreshEpoch.current) setKeys(d);
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
  }, [loadKeys]);

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
    ++refreshEpoch.current;
    setBusy(true); setError(null); setRawKey(null); setRawKeyId(null); setCopied(false);
    try {
      if (!(await ensureCustomerSession()).authenticated) throw new Error(t("errors.sessionExpired"));
      const r = await fetch("/api/odoo/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: name.trim() || t("apiKeys.defaultName"),
        }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setRawKey(b.apiKey);
      setRawKeyId(b.id);
      setKeys(await loadKeys());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function confirm() {
    if (!pending) return;
    ++refreshEpoch.current;
    const cur = pending; setBusy(true); setError(null);
    try {
      if (!(await ensureCustomerSession()).authenticated) throw new Error(t("errors.sessionExpired"));
      const r = await fetch("/api/odoo/keys", { method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(cur.kind === "revoke" ? { id: cur.id } : { id: cur.id, remove: true }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setPending(null);
      if (rawKeyId === cur.id) { setRawKey(null); setRawKeyId(null); setCopied(false); }
      setKeys(current => cur.kind === "remove" ? current.filter(key => key.id !== cur.id) : current.map(key => key.id === cur.id ? { ...key, revokedAt: b.revokedAt, rotationState: "revoked", odooEnabled: false } : key));
      try { setKeys(await loadKeys()); } catch { setError(t("apiKeys.loadFailed")); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const active = keys.filter(k => !k.revokedAt).length;
  const enabled = keys.filter(k => !k.revokedAt && k.odooEnabled).length;
  const disabled = Math.max(0, active - enabled);


  return (
    <>
      <PageHeader
        eyebrow={t("nav.section.integration")}
        icon={<KeyRound className="h-4 w-4" />}
        title={t("apiKeys.title")}
        description={t("apiKeys.pageDescription")}
        meta={
          active > 0 ? (
            <StatusBadge tone={enabled > 0 ? "ok" : "warn"} label={tc("apiKeys.activeCount", active, { count: formatNumber(active) })} />
          ) : (
            <StatusBadge tone="neutral" label={t("apiKeys.notConnected")} />
          )
        }
      />

      <PageContainer>
        <div className="space-y-6">
          {error && (
            <ErrorState
              title={t("apiKeys.operationFailed")}
              message={error}
              retry={() => {
                setError(null);
                void loadKeys().then(setKeys).catch(() => setError(t("apiKeys.loadFailed")));
              }}
            />
          )}

          {hasSubscription === false && (
            <Callout
              tone="warn"
              title={t("apiKeys.choosePlanBeforeConnect")}
              action={
                <Button variant="primary" size="sm" href="/billing">
                  {t("apiKeys.choosePlanCta")}
                </Button>
              }
            >
              {t("apiKeys.choosePlanBody")}
            </Callout>
          )}

          {rawKey && (
            <Callout
              tone="brand"
              title={t("apiKeys.newKeyTitle")}
              icon={<KeyRound className="h-4 w-4" aria-hidden />}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => { if (await copyTextToClipboard(rawKey)) setCopied(true); }}
                  icon={<Copy className="h-3.5 w-3.5" />}
                >
                  {copied ? t("success.copied") : t("apiKeys.copyKey")}
                </Button>
              }
            >
              <div className="space-y-2">
                <p>{t("apiKeys.shownOnceBody")}</p>
                <code className="block select-all break-all rounded-md border border-edge bg-surface px-3 py-2 font-mono text-xs text-ink">
                  {rawKey}
                </code>
              </div>
            </Callout>
          )}

          {/* The connection state is derived from data the Gateway already
              has: an active key plus the Odoo-side activation flag that Odoo
              itself replicated. "Connected" is only claimed when a live key is
              enabled at the source. */}
          <section
            aria-label={t("apiKeys.connectionState")}
            className="card flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-3">
              <StatusDot
                tone={loading ? "neutral" : active === 0 ? "neutral" : enabled > 0 ? "ok" : "warn"}
                className="mt-1.5"
              />
              <div className="min-w-0">
                <div className="text-sm font-[600] text-ink">
                  {loading
                    ? t("common.loading")
                    : active === 0
                      ? t("apiKeys.stateNotConfigured")
                      : enabled > 0
                        ? t("apiKeys.stateConnected")
                        : t("apiKeys.stateWaitingOdoo")}
                </div>
                <p className="mt-0.5 text-sm leading-snug text-ink-3">
                  {!loading && disabled > 0
                    ? tc("apiKeys.disabledAtSource", disabled, { count: formatNumber(disabled) })
                    : t("apiKeys.workspaceScopeOnly")}
                </p>
              </div>
            </div>
            <dl className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div>
                <dt className="label-caps">{t("apiKeys.activeKeys")}</dt>
                <dd className="mt-1 text-md font-[620] tabular text-ink">{loading ? "—" : active}</dd>
              </div>
              <div>
                <dt className="label-caps">{t("apiKeys.odooConnections")}</dt>
                <dd className="mt-1 text-md font-[620] tabular text-ink">{loading ? "—" : enabled}</dd>
              </div>
              <div>
                <dt className="label-caps">{t("apiKeys.accessLevel")}</dt>
                <dd className="mt-1">
                  {loading ? (
                    <Skeleton className="h-6 w-28" />
                  ) : active === 0 ? (
                    <StatusBadge tone="neutral" label={t("apiKeys.notConnected")} />
                  ) : enabled === active ? (
                    <StatusBadge tone="ok" label={t("apiKeys.scope")} />
                  ) : (
                    <StatusBadge tone="warn" label={t("apiKeys.disabledInOdoo")} />
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.85fr)]">
            <div className="space-y-5">
              <Card>
                <CardHeader
                  title={t("apiKeys.connectOdoo")}
                  subtitle={t("apiKeys.connectDescription")}
                  icon={<KeyRound className="h-4 w-4" />}
                />
                <form
                  onSubmit={(e) => { e.preventDefault(); void generate(); }}
                  className="space-y-4 px-5 py-5"
                >
                  <Field
                    label={t("apiKeys.credentialName")}
                    htmlFor="key-name"
                    hint={t("apiKeys.credentialNameHint")}
                  >
                    <Input
                      id="key-name"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder={t("apiKeys.defaultName")}
                      disabled={busy}
                    />
                  </Field>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-[52ch] text-sm leading-relaxed text-ink-3">
                      {t("apiKeys.scopeNote")}
                    </p>
                    <Button
                      type="submit"
                      variant="primary"
                      loading={busy}
                      disabled={busy || hasSubscription === false}
                      icon={busy ? undefined : <Plus className="h-4 w-4" />}
                      title={hasSubscription === false ? t("apiKeys.choosePlanFirstCta") : undefined}
                    >
                      {busy ? t("apiKeys.generating") : t("apiKeys.generateKey")}
                    </Button>
                  </div>
                </form>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader
                  title={t("apiKeys.credentials")}
                  subtitle={tc("apiKeys.issuedCount", keys.length, { count: formatNumber(keys.length) })}
                  icon={<ShieldCheck className="h-4 w-4" />}
                />

                {loading ? (
                  <div className="space-y-3 px-5 py-5" role="status" aria-label={t("apiKeys.loadingCredentials")}>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex items-center justify-between gap-4">
                        <div className="space-y-2">
                          <Skeleton className="h-3.5 w-40" />
                          <Skeleton className="h-2.5 w-56" />
                        </div>
                        <Skeleton className="h-8 w-20" />
                      </div>
                    ))}
                    <span className="sr-only">{t("apiKeys.loadingCredentials")}</span>
                  </div>
                ) : keys.length === 0 ? (
                  <EmptyState
                    icon={<KeyRound className="h-5 w-5" />}
                    title={t("apiKeys.noCredentials")}
                    description={t("apiKeys.emptyDescription")}
                  />
                ) : (
                  <ul className="divide-y divide-edge-subtle">
                    {keys.map(k => {
                      const rotation = rotationMeta(k, t);
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
                                  label={k.odooEnabled ? t("apiKeys.odooEnabled") : t("apiKeys.odooDisabled")}
                                  size="sm"
                                />
                              )}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                              <span>{t("apiKeys.createdOn", { date: formatDate(k.createdAt) })}</span>
                              <span aria-hidden>·</span>
                              <span>
                                {k.lastUsedAt ? t("apiKeys.lastUsedOn", { date: formatDate(k.lastUsedAt) }) : t("apiKeys.neverUsed")}
                              </span>
                              {k.odooEnabledUpdatedAt && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span>{t("apiKeys.syncedOn", { date: formatDateTime(k.odooEnabledUpdatedAt) })}</span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <Button variant="ghost" size="sm" aria-label={t("apiKeys.copyKeyId")} title={t("apiKeys.copyKeyId")} onClick={() => void copyTextToClipboard(k.id)} icon={<Copy className="h-3.5 w-3.5" />}>
                              <span className="sr-only">{t("apiKeys.copyKeyId")}</span>
                            </Button>
                            {!k.revokedAt && <Button variant="secondary" size="sm" disabled={busy} icon={<Ban className="h-3.5 w-3.5" />} onClick={() => setPending({ kind: "revoke", id: k.id, name: k.name })}>
                              {t("apiKeys.revokeKey")}
                            </Button>}
                            <Button variant="danger" size="sm" disabled={busy} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setPending({ kind: "remove", id: k.id, name: k.name })}>
                              {t("apiKeys.removeKey")}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </div>

            <aside className="space-y-5">
              <details className="card group overflow-hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
                  <span className="min-w-0">
                    <span className="block text-md font-[600] leading-snug text-ink">{t("apiKeys.howItWorks")}</span>
                    <span className="mt-0.5 block text-sm text-ink-3">{t("apiKeys.howItWorksSubtitle")}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <ol className="space-y-4 border-t border-edge-subtle px-5 py-5">
                  {[
                    [t("apiKeys.step1"), t("apiKeys.step1Text")],
                    [t("apiKeys.step2"), t("apiKeys.step2Text")],
                    [t("apiKeys.step3"), t("apiKeys.step3Text")],
                    [t("apiKeys.step4"), t("apiKeys.step4Text")],
                  ].map(([title, body], index) => (
                    <li key={title} className="flex gap-3">
                      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-edge bg-surface-2 text-2xs font-[650] tabular text-ink-3">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-[600] text-ink">{title}</div>
                        <p className="mt-0.5 text-sm leading-relaxed text-ink-3">{body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </details>


              <div className="text-sm text-ink-3">
                {t("apiKeys.needModule")}{" "}
                <Link href="/settings" className="font-[550] text-brand hover:underline">
                  {t("apiKeys.reviewWorkspaceSettings")}
                </Link>
                .
              </div>
            </aside>
          </div>
        </div>
      </PageContainer>

      <Modal
        open={!!pending}
        onClose={() => { if (!busy) setPending(null); }}
        title={pending?.kind === "revoke" ? t("apiKeys.revokeCredentialTitle") : t("apiKeys.removeCredentialTitle")}
        description={pending?.name}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirm()}
              loading={busy}
              disabled={busy}
            >
              {pending?.kind === "revoke" ? t("apiKeys.revokeConfirm") : t("apiKeys.removeConfirm")}
            </Button>
          </>
        }
      >
        {error && <ErrorState title={t("errors.operationFailed")} message={error} />}
        {pending?.kind === "revoke" ? (
          <Callout tone="warn" title={t("apiKeys.odooLosesAccess")}>
            {t("apiKeys.revokeBody")}
          </Callout>
        ) : (
          <Callout tone="bad" title={t("common.cannotUndo")}>
            {t("apiKeys.removeRecordBody")}
          </Callout>
        )}
      </Modal>
    </>
  );
}
