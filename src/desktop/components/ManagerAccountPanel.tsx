import React, { useRef, useState } from "react";
import { Button, Field, Input, StatusBadge } from "../../components/ui";
import { useI18n } from "../../i18n/react";
import type { ManagerAccountView } from "../types";

/** Explicit user authentication for Manager-only mutations; credentials never
 * enter localStorage, the Agent service, logs, or app state. */
export function ManagerAccountPanel({
  gatewayUrl, account, login, logout, refresh,
}: {
  gatewayUrl: string;
  account: ManagerAccountView;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // React state does not synchronously fence two form events in one tick.
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const active = account.origin === gatewayUrl && account.status === "authenticated" && account.session?.authenticated === true;
  const unavailable = account.origin === gatewayUrl && account.status === "unavailable";
  const checking = account.origin === gatewayUrl && account.status === "checking";

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current) return;
    if (!gatewayUrl) {
      setError(t("desktop.manager.setGatewayFirst"));
      return;
    }
    if (!username.trim() || !password) {
      setError(t("desktop.manager.missingCredentials"));
      return;
    }
    submitting.current = true;
    setBusy(true); setError(null);
    try {
      await login(username.trim(), password);
      setPassword("");
    } catch (failure) {
      // The Gateway provides structured HTTP status codes. Never render raw
      // server messages, credentials or a stack trace in the Desktop.
      const status = (failure as { status?: unknown } | null)?.status;
      const code = (failure as { code?: unknown } | null)?.code;
      setError(status === 401 ? t("desktop.manager.invalidCredentials") :
        status === 403 ? t("desktop.manager.permissionDenied") :
        status === 429 ? t("desktop.manager.rateLimited") :
        status === 503 || (typeof status === "number" && status >= 500) ? t("desktop.manager.serviceUnavailable") :
        code === "MANAGER_SESSION_UNVERIFIED" ? t("desktop.manager.sessionUnverified") :
        t("desktop.manager.connectionFailed"));
    } finally {
      setPassword("");
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-edge bg-surface px-4 py-4" aria-label={t("desktop.manager.title")}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-ink">{t("desktop.manager.title")}</h3>
        <StatusBadge
          tone={active ? "ok" : unavailable ? "warn" : "neutral"}
          label={active ? t("desktop.manager.signedIn") : checking ? t("desktop.manager.checking") : unavailable ? t("desktop.manager.unavailable") : t("desktop.manager.signedOut")}
        />
      </div>
      <p className="text-sm text-ink-3">{t("desktop.manager.explainer")}</p>
      {!gatewayUrl ? <p className="text-sm text-warn">{t("desktop.manager.setGatewayFirst")}</p> : null}
      {active ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-2" dir="auto">{t("desktop.manager.workspaceRole", {role: account.session?.role ?? "", workspace: account.session?.tenantId ?? ""})}</p>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={busy} onClick={async () => {
              setBusy(true);setError(null);
              try { await logout(); } catch { setError(t("desktop.manager.logoutError")); }
              finally { setBusy(false); setPassword(""); }
            }}>{t("desktop.manager.signOut")}</Button>
            <Button variant="ghost" disabled={busy} onClick={refresh}>{t("common.refresh")}</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label={t("desktop.manager.username")} htmlFor="manager-user">
            <Input id="manager-user" type="text" value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={e => setUsername(e.target.value)} disabled={busy} required />
          </Field>
          <Field label={t("desktop.manager.password")} htmlFor="manager-password">
            <Input id="manager-password" type="password" value={password} autoComplete="current-password" onChange={e => setPassword(e.target.value)} disabled={busy} required />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy} disabled={busy}>{t("desktop.manager.signIn")}</Button>
            {unavailable && <Button type="button" variant="ghost" onClick={refresh}>{t("common.retry")}</Button>}
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}
