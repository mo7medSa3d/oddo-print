import React from "react";
import { Activity, Cpu, HardDrive, Play, RefreshCw, RotateCcw, Server, Settings, ShieldCheck, Square, Lock } from "lucide-react";
import { Button, Card, CardHeader, CopyButton, EmptyState, ErrorState, Mono, StatusBadge, StatusDot } from "../../components/ui";
import { DetailList, StatItem, StatStrip } from "../ui";
import type { DesktopState } from "../types";
import { useI18n } from "../../i18n/react";
import { agentStatusNoteKey, friendlyAgentError, friendlyGatewayError, isProductionPrinter } from "../lib/printers";

export function AgentsPage({ s }: { s: DesktopState }) {
  const { t, locale, formatDateTime } = useI18n();
  const anyStatus = s.agentStatus as Record<string, unknown> | null;
  const physical = s.printers.filter(isProductionPrinter);
  const online = physical.filter((p) => p.status === "online").length;
  const attention = physical.filter((p) => p.status === "offline" || p.status === "error").length;

  return (
    <div className="space-y-5">
      <StatStrip columns={3}>
        <StatItem label={t("desktop.agents.statLocalAgent")} value={s.isOnline ? t("desktop.status.online") : t("desktop.status.offline")} sub={String(anyStatus?.hostname || t("desktop.agents.thisPc"))} tone={s.isOnline ? "ok" : "bad"} icon={<Cpu className="h-4 w-4" />} />
        <StatItem label={t("desktop.agents.statPrinters")} value={`${online} / ${physical.length}`} sub={attention > 0 ? t("desktop.agents.needAttentionCount", { count: attention }) : t("desktop.status.online")} tone={physical.length > 0 && attention === 0 ? "ok" : physical.length === 0 ? "neutral" : "warn"} icon={<HardDrive className="h-4 w-4" />} />
        <StatItem label={t("desktop.agents.statFleet")} value={s.gatewayUrl && s.fleetOnline !== null ? `${s.fleetOnline} / ${s.fleetTotal}` : "—"} sub={s.gatewayUrl ? t("desktop.agents.agentsOnline") : t("desktop.agents.notConfigured")} tone={s.gatewayUrl && s.fleetOnline !== null && s.fleetOnline > 0 ? "ok" : "neutral"} icon={<Server className="h-4 w-4" />} />
      </StatStrip>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title={t("desktop.agents.cardThisPc")} subtitle={t("desktop.agents.cardThisPcSubtitle")} icon={<Cpu className="h-4 w-4 text-brand" />} actions={<Button size="sm" variant="secondary" onClick={s.refreshStatus} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.agents.refresh")}</Button>} />
          <div className="space-y-4 px-5 pb-5">
            <div className="flex items-center gap-3 rounded-sg border border-edge-accent bg-surface-accent p-4">
              <StatusDot tone={s.isOnline ? "ok" : "bad"} pulse={s.isOnline} />
              <div className="min-w-0 flex-1"><div className="text-base font-semibold text-ink">{s.isOnline ? t("desktop.status.agentRunning") : t("desktop.status.agentStopped")}</div><div className="truncate text-xs text-ink-3">{String(anyStatus?.hostname || t("desktop.agents.thisPc"))}</div></div>
              <StatusBadge tone={s.isOnline ? "ok" : "bad"} label={s.isOnline ? t("desktop.status.online") : t("desktop.status.offline")} />
            </div>
            <div className="flex flex-wrap gap-2"><Button variant="primary" onClick={s.startAgent} disabled={s.busy} icon={<Play className="h-4 w-4" />} className="h-9 rounded-md">{t("desktop.agents.start")}</Button><Button variant="secondary" onClick={s.requestStopAgent} disabled={s.busy} icon={<Square className="h-4 w-4" />} className="h-9 rounded-md">{t("desktop.agents.stop")}</Button><Button variant="ghost" onClick={s.restartAgent} disabled={s.busy} icon={<RotateCcw className="h-4 w-4" />} className="h-9">{t("desktop.agents.restart")}</Button></div>
            <DetailList rows={[
              { label: t("desktop.agents.lastCheck"), value: <Mono>{s.lastStatusCheck ? formatDateTime(s.lastStatusCheck) : "—"}</Mono> },
              { label: t("desktop.agents.service"), value: String(anyStatus?.service || t("desktop.agents.windowsService")) },
              { label: t("desktop.agents.version"), value: <Mono>{String(anyStatus?.version || s.version || "—")}</Mono> },
              { label: t("desktop.agents.hostname"), value: <Mono>{String(anyStatus?.hostname || "—")}</Mono> },
              { label: t("desktop.overview.statPrinters"), value: t("desktop.agents.printersRow", { online, total: physical.length, attention }) },
            ]} />
            {anyStatus ? <p className="rounded-md border border-edge bg-surface-2 px-3 py-2.5 text-xs text-ink-2">{t(agentStatusNoteKey(anyStatus))}</p> : null}
            {anyStatus?.error ? <ErrorState title={t("desktop.agents.statusUnavailable")} message={friendlyAgentError(String(anyStatus.error), locale)} retry={s.refreshStatus} /> : null}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title={t("desktop.agents.statFleet")} subtitle={t("desktop.agents.fleetSubtitle", { target: s.gatewayUrl ? t("desktop.agents.fleetSubtitleGateway") : t("desktop.agents.fleetSubtitleNone") })} icon={<Server className="h-4 w-4 text-brand" />} actions={s.gatewayUrl ? <Button size="sm" variant="secondary" onClick={s.checkHealth} icon={<Activity className="h-4 w-4" />}>{t("desktop.agents.check")}</Button> : undefined} />
          <div className="px-5 pb-5">
            {!s.gatewayUrl ? <EmptyState icon={<Server className="h-8 w-8" />} title={t("desktop.agents.notConfigured")} description={t("desktop.agents.notConfiguredBody")} action={<Button variant="primary" onClick={() => s.navigate("settings")} icon={<Settings className="h-4 w-4" />}>{t("desktop.agents.openSettings")}</Button>} /> : s.healthError ? <ErrorState title={t("desktop.agents.checkFailed")} message={friendlyGatewayError(s.healthError, locale)} retry={s.checkHealth} /> : s.fleetTotal !== null && s.fleetTotal > 0 ? (
              <div className="space-y-4">
                {/* The fleet counts repeat what the metric row above already
                    states, so the card shows them once as data, not as two
                    more tiles. */}
                <DetailList
                  rows={[
                    {
                      label: t("desktop.agents.online"),
                      value: (
                        <span className="inline-flex items-center gap-2">
                          <StatusDot tone={(s.fleetOnline ?? 0) > 0 ? "ok" : "bad"} />
                          {t("desktop.agents.ofTotal", { count: s.fleetTotal })}
                        </span>
                      ),
                    },
                    { label: t("desktop.agents.totalAgents"), value: s.fleetTotal },
                  ]}
                />
                <p className="text-xs leading-relaxed text-ink-3">{t("desktop.agents.livenessNote")}</p>
                <div className="flex items-center gap-2 rounded-md border border-edge bg-surface-2 px-3 py-2"><span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-3">{s.gatewayUrl}</span><CopyButton value={s.gatewayUrl} label={t("desktop.agents.copy")} onCopied={() => s.setMsg({ text: t("desktop.agents.urlCopied"), type: "success" })} /></div>
              </div>
            ) : <EmptyState icon={<Server className="h-8 w-8" />} title={t("desktop.agents.fleetEmpty")} description={t("desktop.agents.fleetEmptyBody")} action={<Button variant="secondary" onClick={s.checkHealth} icon={<RefreshCw className="h-4 w-4" />}>{t("desktop.agents.checkAgain")}</Button>} />}
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title={t("desktop.agents.howTitle")} subtitle={t("desktop.agents.howSubtitle")} icon={<ShieldCheck className="h-4 w-4 text-brand" />} />
        <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
          {[
            { title: t("desktop.agents.how1Title"), body: t("desktop.agents.how1Body"), icon: Lock },
            { title: t("desktop.agents.how2Title"), body: t("desktop.agents.how2Body"), icon: HardDrive },
            { title: t("desktop.agents.how3Title"), body: t("desktop.agents.how3Body"), icon: Activity },
          ].map((c) => {
            const Ic = c.icon;
            return <div key={c.title} className="rounded-sg border border-edge p-4"><div className="flex items-center gap-2 text-sm font-semibold text-ink"><span className="flex h-7 w-7 items-center justify-center rounded-sm bg-brand-subtle text-brand border border-edge-accent"><Ic className="h-4 w-4" /></span>{c.title}</div><p className="mt-2 text-xs leading-relaxed text-ink-2">{c.body}</p></div>;
          })}
        </div>
      </Card>
    </div>
  );
}
