"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useI18n } from "../../i18n/react";

export type OverviewHourlyPoint = {
  bucket: string;
  total: number;
  success: number;
  failed: number;
  queued: number;
  inFlight: number;
  expired: number;
};

type Fleet = {
  agents: { total: number; online: number; offline: number };
  printers: { total: number; online: number; offline: number };
};

type Subscriptions = {
  total: number;
  active: number;
  trialing: number;
  attention: number;
  paused: number;
  cancelled: number;
};

function rate(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function linePath(values: number[], width: number, height: number, top: number, bottom: number, max: number) {
  const plotHeight = height - top - bottom;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((value, index) => {
      const x = index * step;
      const y = top + plotHeight - (value / max) * plotHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function areaPath(values: number[], width: number, height: number, top: number, bottom: number, max: number) {
  if (!values.length) return "";
  const plotHeight = height - top - bottom;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => {
    const x = index * step;
    const y = top + plotHeight - (value / max) * plotHeight;
    return [x, y] as const;
  });
  return `M 0 ${height - bottom} L ${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(" L ")} L ${width} ${height - bottom} Z`;
}

export function PrintThroughputChart({
  data,
}: {
  data: OverviewHourlyPoint[];
}) {
  const { t, formatNumber, formatTime } = useI18n();
  const width = 760;
  const height = 270;
  const top = 22;
  const bottom = 34;
  const totals = data.map((point) => point.total);
  const success = data.map((point) => point.success);
  const failed = data.map((point) => point.failed);
  const max = Math.max(1, ...totals);

  const labels = data.map((point) => formatTime(point.bucket));

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-2xs text-ink-3">
        <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-brand-solid" />{t("platform.chart.allPrintJobs")}</span>
        <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-ok-solid" />{t("platform.chart.successful")}</span>
        <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-bad-solid" />{t("platform.chart.failed")}</span>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-edge bg-surface-2 px-2 py-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[260px] w-full"
          role="img"
          aria-label={t("platform.chart.throughputAria")}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const y = top + (height - top - bottom) * (1 - fraction);
            return (
              <line
                key={fraction}
                x1="0"
                x2={width}
                y1={y}
                y2={y}
                className="stroke-edge"
                strokeWidth="1"
              />
            );
          })}
          <path d={areaPath(totals, width, height, top, bottom, max)} className="fill-brand-solid" fillOpacity="0.08" />
          <path d={linePath(totals, width, height, top, bottom, max)} className="fill-none stroke-brand-solid" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          <path d={linePath(success, width, height, top, bottom, max)} className="fill-none stroke-ok-solid" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <path d={linePath(failed, width, height, top, bottom, max)} className="fill-none stroke-bad-solid" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
          {data.map((point, index) => {
            const x = data.length > 1 ? (index / (data.length - 1)) * width : width / 2;
            const y = top + (height - top - bottom) * (1 - point.total / max);
            return (
              <circle key={point.bucket} cx={x} cy={y} r="3" className="fill-brand-solid stroke-surface-2" strokeWidth="2">
                <title>{t("platform.chart.pointTitle", { time: labels[index] ?? "", count: formatNumber(point.total) })}</title>
              </circle>
            );
          })}
          {labels.map((label, index) => {
            if (index % 4 !== 0 && index !== labels.length - 1) return null;
            const x = data.length > 1 ? (index / (data.length - 1)) * width : width / 2;
            return (
              <text key={label} x={x} y={height - 8} textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"} className="fill-ink-4 text-2xs">
                {label}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function AvailabilityRing({
  label,
  online,
  total,
  tone,
}: {
  label: string;
  online: number;
  total: number;
  tone: "brand" | "ok";
}) {
  const { t, formatNumber } = useI18n();
  const percentage = rate(online, total);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[96px] w-[96px] shrink-0">
        <svg viewBox="0 0 96 96" className="h-full w-full -rotate-90" aria-hidden>
          <circle cx="48" cy="48" r={radius} fill="none" className="stroke-surface-3" strokeWidth="8" />
          <circle
            cx="48"
            cy="48"
            r={radius}
            fill="none"
            className={tone === "brand" ? "stroke-brand-solid" : "stroke-ok-solid"}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-xl font-bold tabular-nums text-ink">
          {percentage}%
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-ink">{label}</div>
        <div className="mt-1 text-xs text-ink-3">
          {t("platform.fleet.onlineOfTotal", { online: formatNumber(online), total: formatNumber(total) })}
        </div>
        <div
          className={`mt-2 inline-flex items-center gap-1.5 text-2xs font-[550] ${
            percentage >= 95 ? "text-ok" : percentage >= 80 ? "text-warn" : "text-bad"
          }`}
        >
          {percentage >= 95 ? (
            <CheckCircle2 className="h-3 w-3" aria-hidden />
          ) : (
            <AlertTriangle className="h-3 w-3" aria-hidden />
          )}
          {percentage >= 95 ? t("platform.fleet.healthy") : percentage >= 80 ? t("platform.fleet.attention") : t("platform.fleet.risk")}
        </div>
      </div>
    </div>
  );
}

export function FleetHealthChart({ fleet }: { fleet: Fleet }) {
  const { t } = useI18n();
  return (
    <div className="mt-5 grid gap-5 sm:grid-cols-2">
      <AvailabilityRing label={t("platform.fleet.agents")} online={fleet.agents.online} total={fleet.agents.total} tone="brand" />
      <AvailabilityRing label={t("platform.fleet.printers")} online={fleet.printers.online} total={fleet.printers.total} tone="ok" />
    </div>
  );
}

export function SubscriptionMixChart({ subscriptions }: { subscriptions: Subscriptions }) {
  const { t, formatNumber } = useI18n();
  const segments = [
    { id: "active", label: t("platform.subs.active"), value: subscriptions.active, className: "bg-ok-solid" },
    { id: "trialing", label: t("platform.subs.trialing"), value: subscriptions.trialing, className: "bg-info-solid" },
    { id: "attention", label: t("platform.subs.attention"), value: subscriptions.attention, className: "bg-warn-solid" },
    { id: "paused", label: t("platform.subs.paused"), value: subscriptions.paused, className: "bg-surface-4" },
    { id: "cancelled", label: t("platform.subs.cancelled"), value: subscriptions.cancelled, className: "bg-bad-solid" },
  ];
  const total = Math.max(1, subscriptions.total);

  return (
    <div className="mt-5">
      <div className="flex h-3 overflow-hidden rounded-sm bg-surface-3" aria-hidden>
        {segments.map((segment) => (
          <div
            key={segment.id}
            className={segment.className}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={t("platform.subs.segmentTitle", { label: segment.label, value: formatNumber(segment.value) })}
          />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
        {segments.map((segment) => (
          <div key={segment.id} className="flex items-center justify-between gap-3 text-xs">
            <span className="inline-flex items-center gap-2 text-ink-3">
              <span className={`h-2 w-2 rounded-full ${segment.className}`} />
              {segment.label}
            </span>
            <span className="font-semibold tabular-nums text-ink">{formatNumber(segment.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OperationalSignals({
  jobs,
  agents,
  printers,
  pastDue,
}: {
  jobs: { failed: number; expired: number; queued: number; inFlight: number };
  agents: { offline: number };
  printers: { offline: number };
  pastDue: number;
}) {
  const { t, formatNumber } = useI18n();
  const signals = [
    {
      id: "reliability",
      label: t("platform.signal.reliability"),
      value: jobs.failed + jobs.expired,
      detail: t("platform.signal.reliability.detail"),
      tone: jobs.failed + jobs.expired === 0 ? "ok" : "bad",
    },
    {
      id: "queue",
      label: t("platform.signal.queuePressure"),
      value: jobs.queued + jobs.inFlight,
      detail: t("platform.signal.queuePressure.detail"),
      tone: jobs.queued + jobs.inFlight === 0 ? "ok" : "warn",
    },
    {
      id: "agents",
      label: t("platform.signal.offlineAgents"),
      value: agents.offline,
      detail: t("platform.signal.offlineAgents.detail"),
      tone: agents.offline === 0 ? "ok" : "warn",
    },
    {
      id: "printers",
      label: t("platform.signal.offlinePrinters"),
      value: printers.offline,
      detail: t("platform.signal.offlinePrinters.detail"),
      tone: printers.offline === 0 ? "ok" : "warn",
    },
    {
      id: "billing",
      label: t("platform.signal.billing"),
      value: pastDue,
      detail: t("platform.signal.billing.detail"),
      tone: pastDue === 0 ? "ok" : "warn",
    },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {signals.map((signal) => (
        <div key={signal.id} className="inset-panel p-4">
          <div className="text-sm font-[600] text-ink-2">{signal.label}</div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-2xl font-[660] tabular-nums tracking-[-0.02em] text-ink">
              {formatNumber(signal.value)}
            </span>
            <span
              className={`inline-flex items-center gap-1 text-2xs font-[550] ${
                signal.tone === "ok" ? "text-ok" : signal.tone === "warn" ? "text-warn" : "text-bad"
              }`}
            >
              {signal.tone === "ok" ? (
                <CheckCircle2 className="h-3 w-3" aria-hidden />
              ) : (
                <AlertTriangle className="h-3 w-3" aria-hidden />
              )}
              {signal.tone === "ok" ? t("platform.signal.clear") : signal.tone === "warn" ? t("platform.signal.watch") : t("platform.signal.action")}
            </span>
          </div>
          <div className="mt-1 text-xs text-ink-4">{signal.detail}</div>
        </div>
      ))}
    </div>
  );
}
