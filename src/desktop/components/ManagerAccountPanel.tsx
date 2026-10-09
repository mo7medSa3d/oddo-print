import React, { useState } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const active = account.origin === gatewayUrl && account.status === "authenticated" && account.session?.authenticated === true;
  const unavailable = account.origin === gatewayUrl && account.status === "unavailable";
  const checking = account.origin === gatewayUrl && account.status === "checking";

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !gatewayUrl || !username.trim() || !password) return;
    setBusy(true); setError(null);
    try {
      await login(username.trim(), password);
      setPassword("");
    } catch {
      // Generic copy: never render upstream auth responses or credentials.
      setError(t("desktop.manager.loginFailed"));
    } finally {
      setPassword("");
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
            <Input id="manager-user" type="email" value={username} autoComplete="username" onChange={e => setUsername(e.target.value)} disabled={!gatewayUrl || busy} required />
          </Field>
          <Field label={t("desktop.manager.password")} htmlFor="manager-password">
            <Input id="manager-password" type="password" value={password} autoComplete="current-password" onChange={e => setPassword(e.target.value)} disabled={!gatewayUrl || busy} required />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy} disabled={!gatewayUrl || checking || !username.trim() || !password}>{t("desktop.manager.signIn")}</Button>
            {unavailable && <Button type="button" variant="ghost" onClick={refresh}>{t("common.retry")}</Button>}
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}
