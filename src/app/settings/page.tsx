"use client";

import { useEffect, useRef, useState } from "react";
import { apiMessageKey } from "../../lib/api-error-keys";
import { fetchWithSessionRetry } from "../../lib/fetch-timeout";
import { useRouter } from "next/navigation";
import { SessionInventory } from "../../components/SessionInventory";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { roleLabel } from "../../lib/roles";
import { useI18n } from "../../i18n/react";
import {
  Building2,
  Crown,
  User,
  Shield,
  Save,
  Settings as SettingsIcon,
  CheckCircle2,
  Palette,
  ChevronDown,
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
  focusFirstError,
  useUnsavedChangesWarning,
} from "../../components/ui";

type SettingsPayload = {
  tenant?: { id?: string; name?: string; createdAt?: string };
  email?: string;
  role?: string;
  platformOwner?: boolean;
};

export default function SettingsPage() {
  const router = useRouter();
  const nameEdited = useRef(false);
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);
  const { t, locale, formatDate } = useI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [tenantCreatedAt, setTenantCreatedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    // Generation guard: a locale-triggered reload must not let an older
    // response overwrite a newer snapshot — or the operator's dirty draft
    // (C063). The fetched name seeds the field only when it is still pristine.
    let cancelled = false;
    const controller = new AbortController();
    // Read: safe to retry once after refresh. A 401 returned here means
    // refresh failed or the family is gone, so the redirect below stands.
    fetchWithSessionRetry("/api/settings", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          if (r.status === 401) router.replace("/login?next=%2Fsettings");
          if (r.status === 401 || r.status === 403) {
            setEmail("");
            setRole("");
            setTenantCreatedAt(null);
            if (!nameEdited.current) setName("");
          }
          throw new Error(t("settings.loadFailed"));
        }
        const d = (await r.json()) as SettingsPayload;
        if (cancelled) return;
        if (!nameEdited.current) { setName(d.tenant?.name ?? ""); setSavedName(d.tenant?.name ?? ""); }
        setEmail(d.email ?? "");
        setRole(d.role ?? "");
        setTenantCreatedAt(d.tenant?.createdAt ?? null);
        setLoadError(false);
      })
      .catch(() => { if (!cancelled) { setLoadError(true); setMessage({ text: t("settings.loadFailed"), type: "err" }); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [t, router, loadTick]);

  const formRef = useRef<HTMLFormElement>(null);
  // Guide form rule: move focus to the first error when saving fails.
  useEffect(() => {
    if (message?.type === "err") focusFirstError(formRef.current);
  }, [message]);
  // Guide form rule: warn on leaving with unsaved changes. Dirty is
  // derived from state only (savedName seeds on load and on save);
  // the nameEdited ref stays reserved for the pristine-seeding guard.
  useUnsavedChangesWarning(savedName !== null && name !== savedName);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // PATCH with the identical payload converges on the same tenant name,
      // so a single replay after refresh cannot create a second effect.
      const r = await fetchWithSessionRetry("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMessage({ text: t(apiMessageKey(d.code, r.status, "settings.saveFailed")), type: "err" }); return; }
      setMessage({ text: t("settings.nameUpdated"), type: "ok" });
      setSavedName(name);
    } catch {
      setMessage({ text: t("settings.saveFailed"), type: "err" });
    } finally {
      setBusy(false);
    }
  }

  const profileLabel = locale === "ar" ? "الملف الشخصي" : "Profile";
  const appearanceLabel = locale === "ar" ? "المظهر" : "Appearance";
  const appearanceSubtitle =
    locale === "ar"
      ? "تخصيص المظهر ولغة الواجهة على هذا الجهاز."
      : "Customize the interface theme and language on this device.";

  return (
    <>
      <PageHeader
        icon={<SettingsIcon className="h-4 w-4" />}
        title={t("nav.settings")}
        width="narrow"
      />

      <PageContainer width="narrow">
        <div className="space-y-8">
          {/* 1. Profile */}
          <section aria-labelledby="settings-profile-heading" className="space-y-3">
            <h2 id="settings-profile-heading" className="px-1 text-xs font-semibold uppercase tracking-wider text-ink-3">
              {profileLabel}
            </h2>

            {loading ? (
              <div className="space-y-4" role="status" aria-busy="true" aria-label={t("settings.loadingAria")}>
                <Skeleton className="h-[220px] rounded-2xl" />
                <Skeleton className="h-[160px] rounded-2xl" />
                <span className="sr-only">{t("settings.loadingShort")}</span>
              </div>
            ) : loadError ? (
              <ErrorState
                title={t("settings.loadFailed")}
                message={t("settings.loadFailed")}
                retry={() => { setLoading(true); setLoadError(false); setMessage(null); setLoadTick((n) => n + 1); }}
              />
            ) : (
              <div className="space-y-4">
                <Card className="overflow-hidden rounded-2xl border border-edge/80 bg-surface">
                  <CardHeader
                    title={t("settings.identityTitle")}
                    subtitle={t("settings.identitySubtitle")}
                    icon={<Building2 className="h-4 w-4" />}
                  />
                  <form ref={formRef} onSubmit={save} className="space-y-5 px-5 py-5">
                    <Field
                      label={t("onboarding.workspaceName")}
                      htmlFor="workspace-name"
                      hint={t("settings.workspaceNameHint")}
                      required
                    >
                      <Input
                        id="workspace-name"
                        autoComplete="organization"
                        value={name}
                        onChange={(e) => { nameEdited.current = true; setName(e.target.value); }}
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

                    <div className="flex items-center justify-end gap-2 border-t border-edge-subtle/80 pt-4">
                      <Button type="submit" variant="primary" disabled={busy || name.trim().length < 2} loading={busy} icon={<Save className="h-4 w-4" />}>
                        {busy ? t("common.saving") : t("common.saveChanges")}
                      </Button>
                    </div>
                  </form>
                </Card>

                <Card className="overflow-hidden rounded-2xl border border-edge/80 bg-surface">
                  <CardHeader
                    title={t("settings.yourAccess")}
                    subtitle={t("settings.yourAccessSubtitle")}
                    icon={<User className="h-4 w-4" />}
                  />
                  <div className="px-5 py-4">
                    <KeyValueList
                      rows={[
                        { label: t("settings.signedInAs"), value: email ? <bdi dir="ltr">{email}</bdi> : "—" },
                        {
                          label: t("settings.role"),
                          value: role === "owner"
                            ? <span className="inline-flex items-center gap-1.5 font-semibold"><Crown className="h-4 w-4 text-warn" aria-hidden />{t("team.role.owner")}</span>
                            : <span>{roleLabel(role, t)}</span>,
                        },
                        {
                          label: t("settings.workspaceCreated"),
                          value: tenantCreatedAt ? <span className="tabular-nums">{formatDate(tenantCreatedAt)}</span> : "—",
                        },
                      ]}
                    />
                    <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-edge-subtle/80 bg-surface-2/70 px-3.5 py-3">
                      <Shield className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                      <p className="text-sm leading-relaxed text-ink-3">
                        {t("settings.roleChangesImmediate")}
                      </p>
                    </div>
                  </div>
                </Card>
              </div>
            )}
          </section>

          {/* 2. Security */}
          <section aria-labelledby="settings-security-heading" className="space-y-3">
            <h2 id="settings-security-heading" className="px-1 text-xs font-semibold uppercase tracking-wider text-ink-3">
              {t("security.title")}
            </h2>
            <details open className="group rounded-2xl border border-edge/80 bg-surface px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg py-0.5 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-surface-2 text-ink-2">
                    <Shield className="h-4 w-4" aria-hidden />
                  </span>
                  <span>{t("v4.experience.settings.security")}</span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-180" aria-hidden />
              </summary>
              <div className="mt-4 border-t border-edge-subtle/80 pt-4">
                <SessionInventory />
              </div>
            </details>
          </section>

          {/* 3. Appearance */}
          <section aria-labelledby="settings-appearance-heading" className="space-y-3">
            <h2 id="settings-appearance-heading" className="px-1 text-xs font-semibold uppercase tracking-wider text-ink-3">
              {appearanceLabel}
            </h2>
            <Card className="overflow-hidden rounded-2xl border border-edge/80 bg-surface">
              <CardHeader
                title={appearanceLabel}
                subtitle={appearanceSubtitle}
                icon={<Palette className="h-4 w-4" />}
              />
              <div className="divide-y divide-edge-subtle/80 px-5">
                <div className="flex items-center justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{t("nav.toggleTheme")}</p>
                  </div>
                  <ThemeToggle />
                </div>
                <div className="flex items-center justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{t("common.language")}</p>
                  </div>
                  <LanguageSwitcher align="end" placement="above" compact />
                </div>
              </div>
            </Card>
          </section>
        </div>
      </PageContainer>
    </>
  );
}
