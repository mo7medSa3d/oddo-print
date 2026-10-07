"use client";

import { fetchWithTimeout } from "../../lib/fetch-timeout";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n/react";
import { statusMessageKey } from "../../lib/api-error-keys";
import type { Translator } from "../../i18n/translate";
import type { MessageKey } from "../../i18n/messages/en";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  CircleSlash,
  HelpCircle,
  RefreshCw,
  Gauge,
  Route,
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  Callout,
  ErrorState,
  PageSkeleton,
  StatusBadge,
  type Tone,
} from "../../components/ui";

type HealthState = "ok" | "warn" | "error" | "unknown";
type HealthCheck = {
  name: string;
  state: HealthState;
  message: string;
  /** Translation key for the detail line; `message` is the raw fallback. */
  messageKey?: string;
  messageVars?: Record<string, string | number>;
  latencyMs?: number;
  details?: Record<string, unknown>;
};

/** Health check cards come from the server with English names. */
const CHECK_NAME_KEYS: Record<string, MessageKey> = {
  Database: "health.check.database",
  Queue: "health.check.queue",
  Agents: "health.check.agents",
  Printers: "health.check.printers",
  Gateway: "health.check.gateway",
  Odoo: "health.check.odoo",
  Billing: "health.check.billing",
};
type SystemHealth = {
  overall: HealthState;
  timestamp: string;
  gateway: HealthCheck;
  database: HealthCheck;
  queue: HealthCheck;
  agents: HealthCheck;
  printers: HealthCheck;
  odoo: HealthCheck;
  billing: HealthCheck;
  version: { gateway: string; schema: number };
  checks: HealthCheck[];
};

const STATE_TONE: Record<HealthState, Tone> = {
  ok: "ok",
  warn: "warn",
  error: "bad",
  unknown: "neutral",
};

/** Built per render so status names follow the active language. */
function stateLabel(state: HealthState, t: Translator): string {
  if (state === "ok") return t("health.state.ok");
  if (state === "warn") return t("health.state.warn");
  if (state === "error") return t("health.state.error");
  return t("health.state.unknown");
}

function StateIcon({ state, className = "h-4 w-4" }: { state: HealthState; className?: string }) {
  if (state === "ok") return <CheckCircle2 className={className} aria-hidden />;
  if (state === "warn") return <AlertTriangle className={className} aria-hidden />;
  if (state === "error") return <CircleSlash className={className} aria-hidden />;
  return <HelpCircle className={className} aria-hidden />;
}

function relativeTime(iso: string, locale: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  try {
    // Arabic keeps Latin digits (ar-u-nu-latn) per the project i18n convention.
    const rtf = new Intl.RelativeTimeFormat(locale === "ar" ? "ar-u-nu-latn" : "en", { numeric: "auto" });
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return rtf.format(-seconds, "second");
    return rtf.format(-Math.round(seconds / 60), "minute");
  } catch {
    // Runtimes without Intl.RelativeTimeFormat fall back to English.
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)}m ago`;
  }
}

export default function SystemHealthClient() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const { t, tc, locale } = useI18n();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchWithTimeout("/api/system/health", { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error(t(statusMessageKey(res.status) ?? "errors.gatewayUnavailable"));
      const data = (await res.json()) as SystemHealth;
      setHealth(data);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // Operator sees a plain explanation; the raw detail stays in the console.
      console.warn("health_check_failed:", detail);
      setError(t("health.refreshFailedBody"));
    } finally {
      clearTimeout(timer);
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchHealth("initial");
  }, [fetchHealth]);

  if (loading) {
    return (
      <div role="status" aria-label={t("health.loading")}>
        <PageSkeleton />
        <span className="sr-only">{t("health.loading")}</span>
      </div>
    );
  }

  if (error && !health) {
    return (
      <ErrorState
        title={t("health.unavailable")}
        message={t("health.unavailableBody")}
        retry={() => void fetchHealth("initial")}
      />
    );
  }

  if (!health) return null;

  const counts = health.checks.reduce<Record<HealthState, number>>(
    (acc, check) => {
      acc[check.state] += 1;
      return acc;
    },
    { ok: 0, warn: 0, error: 0, unknown: 0 },
  );

  const criticalChecks = health.checks.filter((check) => check.state === "error" || check.state === "warn");

  return (
    <div className="space-y-5">
      <section
        aria-label={t("health.overall")}
        className="card overflow-hidden"
      >
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3.5">
            <StateIcon
              state={health.overall}
              className={`mt-0.5 h-5 w-5 shrink-0 ${
                health.overall === "ok" ? "text-ok" : health.overall === "warn" ? "text-warn" : health.overall === "error" ? "text-bad" : "text-ink-3"
              }`}
            />
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 text-md font-[620] tracking-[-0.015em] text-ink">
                {health.overall === "ok" ? t("health.allCriticalHealthy") : stateLabel(health.overall, t)}
                <StatusBadge tone={STATE_TONE[health.overall]} label={stateLabel(health.overall, t)} size="sm" />
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-3">
                {criticalChecks.length === 0
                  ? t("health.sampleSummary")
                  : tc("health.checksNeedAttention", criticalChecks.length)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                <span>{t("health.versionGateway", { version: health.version.gateway })}</span>
                <span aria-hidden>·</span>
                <span>{t("health.versionSchema", { version: health.version.schema })}</span>
                <span aria-hidden>·</span>
                <span>{t("health.sampledAt", { time: relativeTime(health.timestamp, locale) })}</span>
              </div>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void fetchHealth("refresh")}
            loading={refreshing}
            icon={refreshing ? undefined : <RefreshCw className="h-3.5 w-3.5" />}
            className="shrink-0"
          >
            {refreshing ? t("health.running") : t("health.rerunChecks")}
          </Button>
        </div>

        {/* Same reasoning as the fleet summary card: `divide-x`/`divide-y`
            put a border on every child except the LAST, so the 2-column
            layout drew a stray line down the card's right edge in row 1 and
            under its bottom-left cell. 1px grid gaps are column-count safe. */}
        <div className="grid grid-cols-2 gap-px border-t border-edge-subtle bg-edge-subtle sm:grid-cols-4">
          {(["ok", "warn", "error", "unknown"] as HealthState[]).map((state) => (
            <div key={state} className="flex items-center gap-2.5 bg-surface px-5 py-3">
              <StateIcon state={state} className={`h-3.5 w-3.5 ${state === "ok" ? "text-ok" : state === "warn" ? "text-warn" : state === "error" ? "text-bad" : "text-ink-4"}`} />
              <span className="text-xs font-[600] text-ink-3">{stateLabel(state, t)}</span>
              <span className="ms-auto text-sm font-[640] tabular text-ink">{counts[state]}</span>
            </div>
          ))}
        </div>
      </section>

      {error && (
        <Callout tone="warn" title={t("health.refreshFailed")}>
          {t("health.showingLastSample", { error })}
        </Callout>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {health.checks.map((check) => (
          <Card key={check.name} className="flex flex-col">
            <CardHeader
              title={CHECK_NAME_KEYS[check.name] ? t(CHECK_NAME_KEYS[check.name]) : check.name}
              icon={<StateIcon state={check.state} className="h-4 w-4" />}
              actions={<StatusBadge tone={STATE_TONE[check.state]} label={stateLabel(check.state, t)} size="sm" />}
            />
            <div className="flex flex-1 flex-col px-5 py-4">
              <p className="text-sm leading-relaxed text-ink-2">
                {check.messageKey
                  ? t(check.messageKey as MessageKey, check.messageVars)
                  : check.message}
              </p>
              <div className="mt-auto flex flex-wrap items-center gap-3 pt-3 text-xs text-ink-3">
                {check.latencyMs !== undefined && (
                  <span className="inline-flex items-center gap-1.5 tabular">
                    <Gauge className="h-3.5 w-3.5 text-ink-4" aria-hidden />
                    {check.latencyMs} ms
                  </span>
                )}
                {check.details && (
                  <details className="group w-full">
                    <summary className="cursor-pointer select-none text-xs font-[550] text-brand transition-colors hover:text-brand-hover">
                      {t("health.technicalDetails")}
                    </summary>
                    <pre dir="ltr" className="mt-2 max-h-44 overflow-auto rounded-md border border-edge-subtle bg-surface-2 p-2.5 font-mono text-xs leading-relaxed text-ink-2 [unicode-bidi:plaintext]">
                      {JSON.stringify(check.details, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title={t("health.tracing")}
          subtitle={t("health.tracingText")}
          icon={<Route className="h-4 w-4" />}
          actions={
            <StatusBadge tone="info" label="X-Request-Id" />
          }
        />
        <div className="space-y-4 px-5 py-5">
          <p className="max-w-[80ch] text-sm leading-relaxed text-ink-3">
            {t("health.tracingIdsIntro")} <code className="font-mono text-xs">request_id</code>,{" "}
            <code className="font-mono text-xs">job_id</code>,{" "}
            <code className="font-mono text-xs">tenant_id</code>,{" "}
            <code className="font-mono text-xs">agent_id</code>,{" "}
            <code className="font-mono text-xs">printer_id</code>,{" "}
            <code className="font-mono text-xs">attempt_id</code>,{" "}
            <code className="font-mono text-xs">claim_id</code>{" "}
            <code className="font-mono text-xs">spooler_job_id</code>{" "}
            {t("health.tracingIdsTail")}{" "}
            <code className="font-mono text-xs">X-Request-Id</code>{" "}
            {t("health.tracingIdsOutro")}
          </p>
          <pre dir="ltr" className="overflow-x-auto rounded-md border border-edge-subtle bg-surface-2 p-3.5 font-mono text-xs leading-relaxed text-ink-2 [unicode-bidi:plaintext]">
{`{"ts":"…","level":"info","event":"print.job.success","requestId":"req_…","jobId":"job_…","tenantId":"…","agentId":"…","printerId":"…","attemptId":"attempt_…","claimId":"…","spoolerJobId":"…"}`}
          </pre>
          <div className="flex items-start gap-2.5 rounded-md border border-edge-subtle bg-surface-2 px-3.5 py-3">
            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <p className="text-sm leading-relaxed text-ink-3">
              {t("health.unverifiedIntro")}{" "}
              <strong className="font-[600] text-ink">{t("health.unverifiedStrong")}</strong>{" "}
              {t("health.unverifiedTail")}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
