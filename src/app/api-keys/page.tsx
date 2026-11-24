"use client";

import { fetchWithSessionRetry, isSessionRenewedNotResent } from "../../lib/fetch-timeout";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "../../i18n/react";
import type { Translator } from "../../i18n/translate";
import Link from "next/link";
import {
  Check,
  Copy,
  KeyRound,
  ShieldCheck,
  Plus,
  Trash2,
  Ban,
  RefreshCw,
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
import { codeMessageKey } from "../../lib/api-error-keys";
import { copyTextToClipboard } from "../../lib/clipboard";

type Installation = { id: string; name: string; enabled: boolean; api_key_ids: string[] };

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
  if (key.rotationState === "retiring") return { label: t("apiKeys.retiring"), tone: "warn" };
  if (key.revokedAt || key.rotationState === "revoked") return { label: t("apiKeys.revoked"), tone: "neutral" };
  return { label: t("apiKeys.active"), tone: "ok" };
}

export default function ApiKeysPage() {
  const router = useRouter();
  const mounted = useRef(true);
  const refreshEpoch = useRef(0);
  const mutationInFlight = useRef(false);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canReadBilling, setCanReadBilling] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const { t, tc, formatDate, formatDateTime, formatNumber } = useI18n();
  const [name, setName] = useState(t("apiKeys.defaultName"));
  const [rawKeyId, setRawKeyId] = useState<string | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [pending, setPending] = useState<{ kind: "revoke" | "remove" | "rotate"; id: string; name: string } | null>(null);
  const [hasSubscription, setHasSubscription] = useState<boolean | null>(null);
  const [authorityDenied, setAuthorityDenied] = useState(false);

  const [loadTick, setLoadTick] = useState(0);
  const [initialLoaded, setInitialLoaded] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const denyAccess = useCallback((status: number) => {
    if (!mounted.current) return;
    setAuthorityDenied(true);
    setKeys([]);
    setInstallations([]);
    setCanManage(false);
    setCanReadBilling(false);
    setRawKey(null);
    setRawKeyId(null);
    setCopied(false);
    setCopiedKeyId(null);
    setPending(null);
    setHasSubscription(null);
    router.replace(status === 401 ? "/login?next=%2Fapi-keys" : "/");
  }, [router]);

  const loadKeys = useCallback(async () => {
    if (!(await ensureCustomerSession()).authenticated) {
      denyAccess(401);
      throw new Error("SESSION_EXPIRED");
    }
    const response = await fetchWithSessionRetry("/api/odoo/keys", { cache: "no-store", credentials: "include" });
    if (response.status === 401 || response.status === 403) denyAccess(response.status);
    if (!response.ok) throw new Error("KEYS_UNAVAILABLE");
    const items: unknown = await response.json();
    if (!Array.isArray(items)) throw new Error("INVALID_KEYS_PAYLOAD");
    return items as ApiKey[];
  }, [denyAccess]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let poll: ReturnType<typeof setInterval> | undefined;
    const bootstrap = async () => {
      setLoading(true);
      setError(null);
      try {
        const session = await ensureCustomerSession();
        if (cancelled) return;
        if (!session.authenticated) { denyAccess(401); return; }
        const epoch = refreshEpoch.current;
        const [keysResponse, installsResponse, principalResponse, billingResponse] = await Promise.all([
          fetchWithSessionRetry("/api/odoo/keys", { credentials: "include", cache: "no-store", signal: controller.signal }),
          fetchWithSessionRetry("/api/odoo/installations", { credentials: "include", cache: "no-store", signal: controller.signal }),
          fetchWithSessionRetry("/api/auth/me", { credentials: "include", cache: "no-store", signal: controller.signal }),
          fetchWithSessionRetry("/api/billing/status", { credentials: "include", cache: "no-store", signal: controller.signal }),
        ]);
        if (cancelled) return;
        const deniedResponse = [keysResponse, installsResponse, principalResponse, billingResponse]
          .find(response => response.status === 401 || response.status === 403);
        if (deniedResponse) { denyAccess(deniedResponse.status); return; }
        if (!keysResponse.ok || !installsResponse.ok || !principalResponse.ok || !billingResponse.ok)
          throw new Error("CONNECTION_DATA_UNAVAILABLE");
        const [nextKeys, nextInstalls, principal, billing] = await Promise.all([
          keysResponse.json() as Promise<ApiKey[]>,
          installsResponse.json() as Promise<Installation[]>,
          principalResponse.json() as Promise<{ permissions?: string[] }>,
          billingResponse.json() as Promise<{ hasSubscription?: boolean }>,
        ]);
        if (!Array.isArray(nextKeys) || !Array.isArray(nextInstalls))
          throw new Error("INVALID_CONNECTION_DATA");
        if (cancelled) return;
        if (epoch === refreshEpoch.current) setKeys(nextKeys);
        setInstallations(nextInstalls);
        setCanManage(principal.permissions?.includes("integrations.manage") === true);
        setCanReadBilling(principal.permissions?.includes("billing.read") === true);
        setHasSubscription(billing.hasSubscription === true);
        setGatewayUrl(window.location.origin);
        setInitialLoaded(true);
        poll = setInterval(() => {
          if (cancelled || mutationInFlight.current || document.visibilityState !== "visible") return;
          const observedEpoch = refreshEpoch.current;
          void loadKeys().then((items) => {
            if (!cancelled && observedEpoch === refreshEpoch.current) setKeys(items);
          }).catch(() => {
            if (!cancelled) setError("apiKeys.loadFailed");
          });
        }, 30_000);
      } catch {
        if (!cancelled) setError("apiKeys.loadFailed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
      controller.abort();
      if (poll) clearInterval(poll);
    };
  }, [denyAccess, loadKeys, loadTick]);

  async function generate() {
    if (mutationInFlight.current || !canManage) return;
    mutationInFlight.current = true;
    ++refreshEpoch.current;
    setBusy(true); setError(null); setRawKey(null); setRawKeyId(null); setCopied(false);
    try {
      if (!(await ensureCustomerSession()).authenticated) { denyAccess(401); return; }
      const r = await fetchWithSessionRetry("/api/odoo/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: name.trim() || t("apiKeys.defaultName"),
        }),
      }, { autoRetry: false });
      if (isSessionRenewedNotResent(r)) { setError(t("errors.sessionRenewedRetry")); return; }
      if (r.status === 401 || r.status === 403) { denyAccess(r.status); return; }
      const b = await r.json();
      if (!r.ok) { setError(t(codeMessageKey(b.code) ?? "apiKeys.operationFailed")); return; }
      setRawKey(b.apiKey);
      setRawKeyId(b.id);
      setKeys(await loadKeys());
    } catch { setError(t("apiKeys.operationFailed")); } finally { mutationInFlight.current = false; setBusy(false); }
  }

  async function confirm() {
    if (!pending || mutationInFlight.current || !canManage) return;
    mutationInFlight.current = true;
    ++refreshEpoch.current;
    const cur = pending; setBusy(true); setError(null);
    try {
      if (!(await ensureCustomerSession()).authenticated) { denyAccess(401); return; }
      const r = cur.kind === "rotate"
        ? await fetchWithSessionRetry(`/api/odoo/keys/${encodeURIComponent(cur.id)}/rotate`, { method: "POST", credentials: "include" }, { autoRetry: false })
        : await fetchWithSessionRetry("/api/odoo/keys", { method: "DELETE", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(cur.kind === "revoke" ? { id: cur.id } : { id: cur.id, remove: true }) });
      if (isSessionRenewedNotResent(r)) { setError(t("errors.sessionRenewedRetry")); return; }
      if (r.status === 401 || r.status === 403) { denyAccess(r.status); return; }
      const b = await r.json();
      if (!r.ok) { setError(t(codeMessageKey(b.code) ?? "apiKeys.operationFailed")); return; }
      setPending(null);
      if (cur.kind === "rotate") {
        setRawKey(b.apiKey); setRawKeyId(b.id); setCopied(false);
        try { setKeys(await loadKeys()); } catch { setError(t("apiKeys.loadFailed")); }
        return;
      }
      if (rawKeyId === cur.id) { setRawKey(null); setRawKeyId(null); setCopied(false); }
      setKeys(current => cur.kind === "remove" ? current.filter(key => key.id !== cur.id) : current.map(key => key.id === cur.id ? { ...key, revokedAt: b.revokedAt, rotationState: "revoked", odooEnabled: false } : key));
      try { setKeys(await loadKeys()); } catch { setError(t("apiKeys.loadFailed")); }
    } catch { setError(t("apiKeys.operationFailed")); } finally { mutationInFlight.current = false; setBusy(false); }
  }

  const active = keys.filter(k => !k.revokedAt).length;
  const enabled = keys.filter(k => !k.revokedAt && k.odooEnabled).length;
  const errorMessage = error === "apiKeys.loadFailed" ? t("apiKeys.loadFailed") : error;

  if (authorityDenied) return null;

  if (loading || !initialLoaded) {
    return (
      <>
        <PageHeader icon={<KeyRound className="h-4 w-4" />} title={t("v4.connection.title")} />
        <PageContainer>
          {errorMessage && !loading
            ? <ErrorState title={t("apiKeys.loadFailed")} message={errorMessage} retry={() => setLoadTick(tick => tick + 1)} />
            : <div role="status" aria-label={t("apiKeys.loadingCredentials")} className="space-y-5" aria-busy="true">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-48 w-full" />
                <span className="sr-only">{t("apiKeys.loadingCredentials")}</span>
              </div>}
        </PageContainer>
      </>
    );
  }

  return (
    <>
      <PageHeader
        icon={<KeyRound className="h-4 w-4" />}
        title={t("v4.connection.title")}
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
          {errorMessage && (
            <ErrorState
              title={t("apiKeys.operationFailed")}
              message={errorMessage}
              retry={() => { setError(null); setLoadTick(tick => tick + 1); }}
            />
          )}

          {hasSubscription === false && (
            <Callout
              tone="warn"
              title={t("apiKeys.choosePlanBeforeConnect")}
              action={canReadBilling ? (
                <Button variant="primary" size="sm" href="/billing">
                  {t("apiKeys.choosePlanCta")}
                </Button>
              ) : undefined}
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
                  onClick={async () => { if (await copyTextToClipboard(rawKey)) setCopied(true); else setError(t("v4.connection.copyFailed")); }}
                  icon={<Copy className="h-3.5 w-3.5" />}
                >
                  {copied ? t("success.copied") : t("apiKeys.copyKey")}
                </Button>
              }
            >
              <div className="space-y-2">
                <p>{t("apiKeys.shownOnceBody")}</p>
                <code dir="ltr" className="block select-all break-all rounded-xl border border-edge bg-surface px-3.5 py-2.5 font-mono text-xs text-ink">
                  {rawKey}
                </code>
                <Button variant="ghost" size="sm" onClick={() => { setRawKey(null); setRawKeyId(null); setCopied(false); }}>
                  {t("v4.connection.hideSecret")}
                </Button>
              </div>
            </Callout>
          )}

          {/* Connection status + Gateway URL */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card className="rounded-[22px] border border-edge-subtle shadow-sm">
              <CardHeader title={t("v4.connection.status")} icon={<StatusDot tone={enabled > 0 ? "ok" : "warn"} />} />
              <div className="space-y-4 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-semibold text-ink">
                    {t(enabled > 0 ? "v4.connection.enabled" : active > 0 ? "v4.connection.waiting" : "v4.connection.start")}
                  </h2>
                  {enabled > 0 && (
                    <Button href={canReadBilling ? "/billing" : "/dashboard"} variant="secondary" size="sm">
                      {t(canReadBilling ? "gateway.licenseKeys.openBilling" : "gateway.licenseKeys.openControlPlane")}
                    </Button>
                  )}
                </div>
                {installations.length > 0 && (
                  <ul className="space-y-2">
                    {installations.map(item => (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-edge-subtle bg-surface-2/50 px-4 py-3">
                        <span className="text-sm font-semibold text-ink">{item.name}</span>
                        <StatusBadge
                          size="sm"
                          tone={item.enabled && item.api_key_ids.some(id => keys.some(key => key.id === id && !key.revokedAt && key.odooEnabled)) ? "ok" : "warn"}
                          label={t(item.enabled ? "v4.connection.enrolled" : "v4.connection.disabled")}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {!canManage && <p className="text-sm text-ink-3">{t("v4.connection.readOnly")}</p>}
              </div>
            </Card>

            <Card className="rounded-[22px] border border-edge-subtle shadow-sm">
              <CardHeader title={t("v4.connection.gatewayUrl")} icon={<KeyRound className="h-4 w-4" />} />
              <div className="space-y-3 p-5">
                <div className="flex items-center justify-between gap-2 rounded-xl border border-edge-subtle bg-surface-2 px-3.5 py-2.5">
                  <code dir="ltr" className="min-w-0 break-all font-mono text-xs text-ink">
                    {gatewayUrl || "—"}
                  </code>
                  {gatewayUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={copiedUrl ? t("success.copied") : t("apiKeys.copyKey")}
                      onClick={async () => {
                        if (await copyTextToClipboard(gatewayUrl)) setCopiedUrl(true);
                        else setError(t("v4.connection.copyFailed"));
                      }}
                      icon={copiedUrl ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
                    />
                  )}
                </div>
                <div className="text-xs text-ink-3">
                  <Link href="/settings" className="font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
                    {t("apiKeys.reviewWorkspaceSettings")}
                  </Link>
                </div>
              </div>
            </Card>
          </div>

          {/* Issue credential */}
          <Card className="rounded-[22px] border border-edge-subtle shadow-sm">
            <CardHeader title={t("apiKeys.connectOdoo")} icon={<KeyRound className="h-4 w-4" />} />
            <form
              onSubmit={(e) => { e.preventDefault(); void generate(); }}
              className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
            >
              <Field label={t("apiKeys.credentialName")} htmlFor="key-name">
                <Input
                  id="key-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t("apiKeys.defaultName")}
                  disabled={busy || !canManage}
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={busy || !canManage || hasSubscription !== true}
                icon={busy ? undefined : <Plus className="h-4 w-4" />}
                title={hasSubscription === false ? t("apiKeys.choosePlanFirstCta") : undefined}
              >
                {busy ? t("apiKeys.generating") : t("apiKeys.generateKey")}
              </Button>
            </form>
          </Card>

          {/* Issued credentials list */}
          <Card className="overflow-hidden rounded-[22px] border border-edge-subtle shadow-sm">
            <CardHeader
              title={t("apiKeys.credentials")}
              subtitle={tc("apiKeys.issuedCount", keys.length, { count: formatNumber(keys.length) })}
              icon={<ShieldCheck className="h-4 w-4" />}
            />

            {keys.length === 0 ? (
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
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors duration-150 hover:bg-surface-hover"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-ink">{k.name}</span>
                          <StatusBadge tone={rotation.tone} label={rotation.label} size="sm" />
                          {!k.revokedAt && (
                            <StatusBadge
                              tone={k.odooEnabled ? "ok" : "warn"}
                              label={k.odooEnabled ? t("apiKeys.odooEnabled") : t("apiKeys.odooDisabled")}
                              size="sm"
                            />
                          )}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-ink-3">
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
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={copiedKeyId === k.id ? t("success.copied") : t("apiKeys.copyKeyId")}
                          title={copiedKeyId === k.id ? t("success.copied") : t("apiKeys.copyKeyId")}
                          onClick={async () => {
                            if (await copyTextToClipboard(k.id)) setCopiedKeyId(k.id);
                            else setError(t("v4.connection.copyFailed"));
                          }}
                          icon={copiedKeyId === k.id ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
                        />
                        {!k.revokedAt && (
                          <Button variant="secondary" size="sm" disabled={busy || !canManage} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setPending({ kind: "rotate", id: k.id, name: k.name })}>
                            {t("v4.connection.rotate")}
                          </Button>
                        )}
                        {!k.revokedAt && (
                          <Button variant="secondary" size="sm" disabled={busy || !canManage} icon={<Ban className="h-3.5 w-3.5" />} onClick={() => setPending({ kind: "revoke", id: k.id, name: k.name })}>
                            {t("apiKeys.revokeKey")}
                          </Button>
                        )}
                        <Button variant="danger" size="sm" disabled={busy || !canManage} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setPending({ kind: "remove", id: k.id, name: k.name })}>
                          {t("apiKeys.removeKey")}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <span className="sr-only" aria-live="polite">{copied || copiedKeyId || copiedUrl ? t("success.copied") : ""}</span>
        </div>
      </PageContainer>

      <Modal
        open={!!pending}
        onClose={() => { if (!busy) setPending(null); }}
        title={pending?.kind === "rotate" ? t("v4.connection.rotateTitle") : pending?.kind === "revoke" ? t("apiKeys.revokeCredentialTitle") : t("apiKeys.removeCredentialTitle")}
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
              disabled={busy || !canManage}
            >
              {pending?.kind === "rotate" ? t("v4.connection.rotate") : pending?.kind === "revoke" ? t("apiKeys.revokeConfirm") : t("apiKeys.removeConfirm")}
            </Button>
          </>
        }
      >
        {errorMessage && <ErrorState title={t("errors.operationFailed")} message={errorMessage} />}
        {pending?.kind === "rotate" ? (
          <Callout tone="warn" title={t("v4.connection.rotateTitle")}>{t("v4.connection.rotateBody")}</Callout>
        ) : pending?.kind === "revoke" ? (
          <Callout tone="warn" title={t("apiKeys.odooLosesAccess")}>{t("apiKeys.revokeBody")}</Callout>
        ) : (
          <Callout tone="bad" title={t("common.cannotUndo")}>{t("apiKeys.removeRecordBody")}</Callout>
        )}
      </Modal>
    </>
  );
}
