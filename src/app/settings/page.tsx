"use client";

import { useEffect, useState } from "react";
import { apiMessageKey } from "../../lib/api-error-keys";
import { fetchWithTimeout } from "../../lib/fetch-timeout";
import { roleLabel } from "../../lib/roles";
import { useI18n } from "../../i18n/react";
import {
  Building2,
  User,
  Shield,
  Save,
  AlertTriangle,
  Settings as SettingsIcon,
  CheckCircle2,
} from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  PageContainer,
  PageHeader,
  Skeleton,
} from "../../components/ui";

type SettingsPayload = {
  tenant?: { id?: string; name?: string; createdAt?: string };
  email?: string;
  role?: string;
};

export default function SettingsPage() {
  const [name, setName] = useState("");
  const { t, formatDate } = useI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [tenantCreatedAt, setTenantCreatedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Generation guard: a locale-triggered reload must not let an older
    // response overwrite a newer snapshot — or the operator's dirty draft
    // (C063). The fetched name seeds the field only when it is still pristine.
    let cancelled = false;
    fetchWithTimeout("/api/settings", { credentials: "include", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(t("settings.loadFailed"));
        const d = (await r.json()) as SettingsPayload;
        if (cancelled) return;
        setName((current) => (current === "" ? (d.tenant?.name ?? "") : current));
        setEmail(d.email ?? "");
        setRole(d.role ?? "");
        setTenantCreatedAt(d.tenant?.createdAt ?? null);
      })
      .catch((e) => { if (!cancelled) setMessage({ text: e instanceof Error ? e.message : t("settings.loadFailed"), type: "err" }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetchWithTimeout("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(t(apiMessageKey(d.code, r.status, "settings.saveFailed")));
      setMessage({ text: t("settings.nameUpdated"), type: "ok" });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : t("settings.saveFailed"), type: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={t("nav.section.administration")}
        icon={<SettingsIcon className="h-4 w-4" />}
        title={t("nav.settings")}
        width="narrow"
        description={t("settings.pageDescription")}
      />

      <PageContainer width="narrow">
        {loading ? (
          <div className="space-y-5" role="status" aria-label={t("settings.loadingAria")}>
            <Skeleton className="h-[240px] rounded-lg" />
            <Skeleton className="h-[160px] rounded-lg" />
            <span className="sr-only">{t("settings.loadingShort")}</span>
          </div>
        ) : (
          <div className="space-y-5">
            <Card>
              <CardHeader
                title={t("settings.identityTitle")}
                subtitle={t("settings.identitySubtitle")}
                icon={<Building2 className="h-4 w-4" />}
              />
              <form onSubmit={save} className="space-y-5 px-5 py-5">
                <Field
                  label={t("onboarding.workspaceName")}
                  htmlFor="workspace-name"
                  hint={t("settings.workspaceNameHint")}
                  required
                >
                  <Input
                    id="workspace-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    minLength={2}
                    maxLength={120}
                    required
                    placeholder={t("settings.namePlaceholder")}
                  />
                </Field>

                {message && (
                  <Callout
                    tone={message.type === "ok" ? "ok" : "bad"}
                    icon={message.type === "ok" ? <CheckCircle2 className="h-4 w-4" /> : undefined}
                    title={message.type === "ok" ? t("settings.saved") : t("settings.saveFailed")}
                  >
                    {message.text}
                  </Callout>
                )}

                <div className="flex items-center justify-end gap-2 border-t border-edge-subtle pt-4">
                  <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2} loading={busy} icon={<Save className="h-4 w-4" />}>
                    {busy ? t("common.saving") : t("common.saveChanges")}
                  </Button>
                </div>
              </form>
            </Card>

            <Card>
              <CardHeader
                title={t("settings.yourAccess")}
                subtitle={t("settings.yourAccessSubtitle")}
                icon={<User className="h-4 w-4" />}
              />
              <div className="px-5 py-4">
                <KeyValueList
                  rows={[
                    { label: t("settings.signedInAs"), value: email || "—" },
                    { label: t("settings.role"), value: <span>{roleLabel(role, t)}</span> },
                    {
                      label: t("settings.workspaceCreated"),
                      value: tenantCreatedAt ? formatDate(tenantCreatedAt) : "—",
                    },
                  ]}
                />
                <div className="mt-3 flex items-start gap-2.5 rounded-md border border-edge-subtle bg-surface-2 px-3.5 py-3">
                  <Shield className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                  <p className="text-sm leading-relaxed text-ink-3">
                    {t("settings.roleChangesImmediate")}
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader
                title={t("settings.dangerZone")}
                subtitle={t("settings.dangerZoneSubtitle")}
                icon={<AlertTriangle className="h-4 w-4" />}
              />
              <div className="px-5 py-4">
                <div className="flex items-start gap-3 rounded-md border border-bad-edge bg-bad-bg px-4 py-3.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden />
                  <div className="min-w-0">
                    <h3 className="text-sm font-[600] text-bad">{t("settings.deleteWorkspaceTitle")}</h3>
                    <p className="mt-0.5 text-sm leading-relaxed text-ink-2">
                      {t("settings.deleteWorkspaceBody")}
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        )}
      </PageContainer>
    </>
  );
}
