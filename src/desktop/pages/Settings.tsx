import React from "react";
import { Activity, ChevronRight, KeyRound, Link2, Play, Power, RotateCcw, Server, ShieldCheck, Square, Copy, Lock } from "lucide-react";
import { Button, Card, CopyButton, ErrorState, Field, Input, StatusBadge, StatusDot } from "../../components/ui";
import { SettingsSection } from "../ui";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { LOCALES, LOCALE_LABELS } from "../../i18n/config";
import { friendlyAgentError, friendlyGatewayError, friendlyPrinterError, labelPrinter } from "../lib/printers";
import { getAutostart, setAutostart } from "../lib/ipc";

export function SettingsPage({ s }: { s: DesktopState }) {
  const { t, locale, setLocale } = useI18n();
  const anyStatus = s.agentStatus as Record<string, unknown> | null;
  const [autostartBusy, setAutostartBusy] = React.useState(false);
  const paths: [string, string][] = s.runtimePaths
    ? [
        [t("desktop.settings.managerData"), s.runtimePaths.manager_data],
        [t("desktop.settings.settingsFile"), s.runtimePaths.settings],
        [t("desktop.settings.agentConfig"), s.runtimePaths.agent_config],
        [t("desktop.settings.managerLog"), s.runtimePaths.manager_log],
        [t("desktop.settings.agentData"), s.runtimePaths.agent_data],
      ]
    : [];

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <SettingsSection title={t("desktop.settings.gatewaySection")} description={t("desktop.settings.gatewaySectionBody")} icon={<Link2 className="h-4 w-4" />}>
          <div className="flex items-center gap-3 rounded-sg border border-edge-accent bg-surface-accent p-4">
            <StatusDot tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"} pulse={s.gatewayConnected} />
            <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-ink">{s.gatewayConnected ? t("desktop.settings.connected") : s.gatewayUrl ? t("desktop.settings.unreachable") : t("desktop.settings.notConfigured")}</div><div className="truncate text-2xs text-ink-3">{s.gatewayUrl || t("desktop.settings.enterGatewayUrl")}</div></div>
            <StatusBadge tone={s.gatewayConnected ? "ok" : s.gatewayUrl ? "bad" : "neutral"} label={s.gatewayConnected ? t("desktop.settings.connected") : s.gatewayUrl ? t("desktop.settings.unreachable") : t("desktop.settings.notConfigured")} />
          </div>
          <Field label={t("desktop.settings.gatewayUrlLabel")} htmlFor="gw-url" hint={t("desktop.settings.gatewayUrlHint")}>
            <Input id="gw-url" value={s.gatewayUrl} onChange={(e) => s.setGw(e.target.value)} placeholder="https://gateway.example.com" className="h-10 rounded-md" />
          </Field>
          <div className="flex justify-end"><Button variant="primary" onClick={s.checkHealth} loading={s.gatewayChecking} icon={<Activity className="h-4 w-4" />} className="h-10 rounded-md">{t("desktop.settings.checkConnection")}</Button></div>
          {s.healthError && <ErrorState title={t("desktop.settings.checkFailed")} message={friendlyGatewayError(s.healthError, locale)} retry={s.checkHealth} />}
        </SettingsSection>

        <SettingsSection title={t("desktop.settings.localAgentSection")} description={t("desktop.settings.localAgentSectionBody")} icon={<Server className="h-4 w-4" />}>
          <div className="flex items-center gap-3 rounded-sg border border-edge-accent bg-surface-accent p-4">
            <StatusDot tone={s.isOnline ? "ok" : "bad"} pulse={s.isOnline} />
            <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-ink">{s.isOnline ? t("desktop.settings.agentOnline") : t("desktop.settings.agentStopped")}</div><div className="truncate text-2xs text-ink-3">{String(anyStatus?.hostname || "This PC")}</div></div>
            <StatusBadge tone={s.isOnline ? "ok" : "bad"} label={s.isOnline ? t("desktop.settings.running") : t("desktop.settings.stopped")} />
          </div>
          <div><div className="mb-2 text-xs font-semibold text-ink">{t("desktop.settings.serviceControl")}</div><div className="flex flex-wrap gap-2"><Button variant="primary" onClick={s.startAgent} disabled={s.busy} icon={<Play className="h-4 w-4" />} className="h-9 rounded-md">{t("desktop.agents.start")}</Button><Button variant="secondary" onClick={s.requestStopAgent} disabled={s.busy} icon={<Square className="h-4 w-4" />} className="h-9 rounded-md">{t("desktop.agents.stop")}</Button><Button variant="ghost" onClick={s.restartAgent} disabled={s.busy} icon={<RotateCcw className="h-4 w-4" />} className="h-9">{t("desktop.agents.restart")}</Button></div></div>
          <div className="border-t border-edge pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-2.5"><Power className="mt-0.5 h-4 w-4 text-ink-3" /><div><div className="text-sm font-semibold text-ink">{t("desktop.settings.startWithWindows")}</div><p className="mt-1 text-2xs text-ink-3">{t("desktop.settings.startWithWindowsBody")}</p></div></div>
              <button role="switch" aria-checked={!!s.autostart} aria-busy={s.autostart === null || autostartBusy} disabled={s.autostart === null || autostartBusy} onClick={async () => {
                if (s.autostart === null || autostartBusy) return; const next = !s.autostart; setAutostartBusy(true);
                try { await setAutostart(next); const st = await getAutostart(); s.setAutostartState(st.enabled); s.setMsg({ text: st.enabled ? t("desktop.settings.autostartOn") : t("desktop.settings.autostartOff"), type: "success" }); }
                catch (error) { s.setMsg({ text: friendlyAgentError(error instanceof Error ? error.message : t("desktop.settings.autostartFailed"), locale), type: "error" }); }
                finally { setAutostartBusy(false); }
              }} className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-sm transition-colors ${s.autostart ? "bg-brand" : "bg-surface-3"}`}>
                <span className={`inline-block h-4 w-4 transform rounded-sm bg-white shadow-xs transition-transform ${s.autostart ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
          </div>
        </SettingsSection>
      </div>

      <Card className="overflow-hidden border-brand/20 billing-premium">
        <div className="flex items-start justify-between gap-4 border-b border-edge bg-surface-2/50 px-5 py-4">
          <div className="flex items-start gap-3"><span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-md border border-edge-accent bg-brand-subtle text-brand"><KeyRound className="h-4 w-4" /></span><div className="min-w-0"><h2 className="text-base font-semibold text-ink">{t("desktop.settings.pairTitle")}</h2><p className="mt-1 text-2xs text-ink-3">{t("desktop.settings.pairSubtitle")}</p></div></div>
          <StatusBadge label={s.isOnline ? (s.gatewayConnected ? t("desktop.settings.pairRunning") : t("desktop.settings.pairGatewayUnreachable")) : t("desktop.settings.pairStopped")} tone={s.isOnline ? (s.gatewayConnected ? "ok" : "warn") : "neutral"} />
        </div>
        <div className="grid gap-5 px-5 py-5 lg:grid-cols-[1fr_auto] lg:items-end">
          <ol className="space-y-2.5 text-xs text-ink-2">
            {[t("desktop.settings.pairStep1"), t("desktop.settings.pairStep2"), t("desktop.settings.pairStep3")].map((step, i) => (
              <li key={step} className="flex items-center gap-2.5"><span className="flex h-5 w-5 items-center justify-center rounded-sm bg-brand text-2xs font-bold text-brand-contrast">{i + 1}</span><span>{step}</span></li>
            ))}
          </ol>
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Field label={t("desktop.settings.pairCodeLabel")} htmlFor="pair-code" className="flex-1">
              <div className="flex items-center gap-2"><Input id="pair-code" value={s.pairCode} onChange={(e) => s.setPairCode(e.target.value.toUpperCase())} placeholder="AB12CD" maxLength={6} className="text-center font-mono text-lg font-bold uppercase tracking-[0.3em] h-11 rounded-md" autoComplete="off" /><Button variant="primary" onClick={s.pair} loading={s.busy} disabled={!s.pairCode.trim() || s.pairCode.trim().length !== 6} icon={<ShieldCheck className="h-4 w-4" />} className="h-11 rounded-md">{t("desktop.settings.pair")}</Button></div>
            </Field>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-edge bg-surface-2/30 px-5 py-4">
          <div><h2 className="text-base font-semibold text-ink">{t("desktop.settings.currentStatus")}</h2><p className="mt-1 text-2xs text-ink-3">{t("desktop.settings.currentStatusBody")}</p></div>
          <Button size="sm" variant="secondary" onClick={() => {
            const report = [`=== Yaseir Agent Diagnostic Export ===`, `Generated: ${new Date().toISOString()}`, `Version: ${s.version || "unknown"}`, `Running: ${s.isOnline}`, `Gateway: ${s.gatewayUrl || t("desktop.settings.notConfigured")}`, `Reachable: ${s.gatewayConnected}`, `Printers: ${s.printers.length}`, `Pending: ${s.pendingJobs}, Failed: ${s.failedJobs}`, ``, `=== Printers ===`, ...s.printers.map((p) => ` - ${p.name} [${p.status}]`), ``, `=== Paths ===`, ...paths.map(([k, v]) => ` - ${k}: ${v}`)].join("\n");
            navigator.clipboard.writeText(report).then(() => s.setMsg({ text: t("desktop.settings.statusCopied"), type: "success" })).catch(() => s.setMsg({ text: t("desktop.settings.copyFailed"), type: "error" }));
          }} icon={<Copy className="h-3.5 w-3.5" />} className="h-8 rounded-sm">{t("desktop.settings.copySummary")}</Button>
        </div>
        <div className="p-5 space-y-3">
          <div className="max-h-64 overflow-y-auto rounded-sg border border-edge bg-surface-2 p-3 text-xs space-y-2">
            <div className="flex items-center justify-between"><span className="font-medium text-ink-2">{t("desktop.settings.agentService")}</span><span className={s.isOnline ? "font-semibold text-ok" : "font-semibold text-bad"}>{s.isOnline ? t("desktop.settings.running") : t("desktop.settings.stopped")}</span></div>
            <div className="flex items-center justify-between"><span className="font-medium text-ink-2">{t("desktop.settings.gatewaySection")}</span><span className={s.gatewayConnected ? "font-semibold text-ok" : s.gatewayUrl ? "font-semibold text-bad" : "font-semibold text-warn"}>{s.gatewayConnected ? t("desktop.settings.reachable") : s.gatewayUrl ? t("desktop.settings.failedCheck") : t("desktop.settings.notConfigured")}</span></div>
            {s.healthError && <div className="rounded-sm border border-bad-edge bg-bad-bg px-2.5 py-1.5 text-2xs text-bad">{friendlyGatewayError(s.healthError, locale)}</div>}
            <div className="flex items-center justify-between"><span className="font-medium text-ink-2">{t("desktop.settings.devices")}</span><span className="font-semibold text-ink tabular-nums">{s.printers.length}</span></div>
            {s.printers.map((p) => (<div key={p.id} className="flex items-center justify-between rounded-sm border border-edge bg-surface px-2.5 py-1.5"><span className="truncate text-ink-2">{p.name}</span><span className={`font-semibold text-2xs ${p.status === "online" ? "text-ok" : p.status === "offline" || p.status === "error" ? "text-bad" : "text-warn"}`}>{labelPrinter(p.status, locale)}</span></div>))}
            {s.printers.length === 0 && <p className="text-2xs text-ink-3">{t("desktop.settings.noDevices")}</p>}
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <button onClick={() => s.setAdvancedOpen(!s.advancedOpen)} className="flex w-full items-center justify-between px-5 py-4 text-start hover:bg-surface-2"><span className="text-base font-semibold text-ink">{t("desktop.settings.advanced")}</span><ChevronRight className={`h-4 w-4 text-ink-3 transition-transform ${s.advancedOpen ? "rotate-90" : ""}`} /></button>
        {s.advancedOpen && (
          <div className="grid gap-5 border-t border-edge px-5 py-5 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-3">{t("desktop.settings.language")}</div>
              <p className="text-xs text-ink-2 leading-relaxed">{t("desktop.settings.languageBody")}</p>
              <div className="mt-3 inline-flex rounded-md border border-edge bg-surface-2 p-0.5" role="group" aria-label={t("desktop.settings.languageAria")}>
                {LOCALES.map((code) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={locale === code}
                    onClick={() => setLocale(code)}
                    className={`rounded-sm px-3 py-1.5 text-xs font-medium transition-colors ${locale === code ? "bg-brand text-brand-contrast" : "text-ink-3 hover:text-ink"}`}
                  >
                    {LOCALE_LABELS[code]}
                  </button>
                ))}
              </div>
            </div>
            <div><div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-3">{t("desktop.settings.security")}</div><p className="text-xs text-ink-2 leading-relaxed">{t("desktop.settings.securityBody")}</p><div className="mt-3 inline-flex items-center gap-2 rounded-md border border-ok-edge bg-ok-bg px-3 py-2 text-xs font-medium text-ok"><Lock className="h-4 w-4" />{t("desktop.settings.credentialsLocal")}</div></div>
            <div><div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-3">{t("desktop.settings.dataLocations")}</div>{paths.length > 0 ? <div className="space-y-1.5">{paths.map(([label, path]) => (<div key={label} className="flex items-center gap-2 rounded-md border border-edge bg-surface-2 px-3 py-2"><span className="w-24 text-2xs font-semibold text-ink-2">{label}</span><span className="flex-1 truncate font-mono text-2xs text-ink-3">{path}</span><CopyButton value={path} label={t("desktop.agents.copy")} onCopied={() => s.setMsg({ text: t("desktop.settings.copied"), type: "success" })} /></div>))}</div> : <p className="text-xs text-ink-3">{t("desktop.settings.loadingPaths")}</p>}<p className="mt-4 text-2xs text-ink-3">{t("desktop.settings.footer", { version: s.version || "—" })}</p></div>
          </div>
        )}
      </Card>
    </div>
  );
}
