"use client";

import { useMemo } from "react";

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
  pastDue: number;
  cancelled: number;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function rate(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function linePath(values: number[], width: number, height: number, top: number, bottom: number) {
  const max = Math.max(1, ...values);
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

function areaPath(values: number[], width: number, height: number, top: number, bottom: number) {
  if (!values.length) return "";
  const max = Math.max(1, ...values);
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
  const width = 760;
  const height = 270;
  const top = 22;
  const bottom = 34;
  const totals = data.map((point) => point.total);
  const success = data.map((point) => point.success);
  const failed = data.map((point) => point.failed);
  const max = Math.max(1, ...totals);

  const labels = useMemo(
    () =>
      data.map((point) =>
        new Date(point.bucket).toLocaleTimeString([], { hour: "2-digit", hour12: false }),
      ),
    [data],
  );

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-ink-3">
        <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-brand-solid" />All print jobs</span>
        <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-ok-solid" />Successful</span>
        <span className="inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-bad-solid" />Failed</span>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-edge bg-surface-2 px-2 py-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[260px] w-full"
          role="img"
          aria-label="Print job volume over the last 24 hours"
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
          <path d={areaPath(totals, width, height, top, bottom)} className="fill-brand-solid" fillOpacity="0.08" />
          <path d={linePath(totals, width, height, top, bottom)} className="fill-none stroke-brand-solid" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          <path d={linePath(success, width, height, top, bottom)} className="fill-none stroke-ok-solid" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <path d={linePath(failed, width, height, top, bottom)} className="fill-none stroke-bad-solid" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
          {data.map((point, index) => {
            const x = data.length > 1 ? (index / (data.length - 1)) * width : width / 2;
            const y = top + (height - top - bottom) * (1 - point.total / max);
            return (
              <circle key={point.bucket} cx={x} cy={y} r="3" className="fill-brand-solid stroke-surface-2" strokeWidth="2">
                <title>{`${labels[index]} — ${formatNumber(point.total)} jobs`}</title>
              </circle>
            );
          })}
          {labels.map((label, index) => {
            if (index % 4 !== 0 && index !== labels.length - 1) return null;
            const x = data.length > 1 ? (index / (data.length - 1)) * width : width / 2;
            return (
              <text key={label} x={x} y={height - 8} textAnchor={index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"} className="fill-ink-4 text-[11px]">
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
  const percentage = rate(online, total);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[96px] w-[96px] shrink-0">
        <svg viewBox="0 0 96 96" className="h-full w-full -rotate-90">
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
        <div className="absolute inset-0 flex items-center justify-center text-[18px] font-bold tabular-nums text-ink">
          {percentage}%
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink">{label}</div>
        <div className="mt-1 text-[12px] text-ink-3">
          {formatNumber(online)} online of {formatNumber(total)}
        </div>
        <div className={`mt-2 text-[11px] font-medium ${percentage >= 95 ? "text-ok" : percentage >= 80 ? "text-warn" : "text-bad"}`}>
          {percentage >= 95 ? "Healthy coverage" : percentage >= 80 ? "Some attention needed" : "Operational risk"}
        </div>
      </div>
    </div>
  );
}

export function FleetHealthChart({ fleet }: { fleet: Fleet }) {
  return (
    <div className="mt-5 grid gap-5 sm:grid-cols-2">
      <AvailabilityRing label="Agents" online={fleet.agents.online} total={fleet.agents.total} tone="brand" />
      <AvailabilityRing label="Printers" online={fleet.printers.online} total={fleet.printers.total} tone="ok" />
    </div>
  );
}

export function SubscriptionMixChart({ subscriptions }: { subscriptions: Subscriptions }) {
  const segments = [
    { label: "Active", value: subscriptions.active, className: "bg-ok-solid" },
    { label: "Trialing", value: subscriptions.trialing, className: "bg-info-solid" },
    { label: "Past due", value: subscriptions.pastDue, className: "bg-warn-solid" },
    { label: "Cancelled", value: subscriptions.cancelled, className: "bg-bad-solid" },
  ];
  const total = Math.max(1, subscriptions.total);

  return (
    <div className="mt-5">
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-3" aria-label="Subscription status mix">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className={segment.className}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={`${segment.label}: ${formatNumber(segment.value)}`}
          />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center justify-between gap-3 text-[12px]">
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
  const signals = [
    {
      label: "Print reliability",
      value: jobs.failed + jobs.expired,
      detail: "failed + expired jobs / 24h",
      tone: jobs.failed + jobs.expired === 0 ? "ok" : "bad",
    },
    {
      label: "Queue pressure",
      value: jobs.queued + jobs.inFlight,
      detail: "jobs currently open",
      tone: jobs.queued + jobs.inFlight === 0 ? "ok" : "warn",
    },
    {
      label: "Fleet exceptions",
      value: agents.offline + printers.offline,
      detail: "offline agents + printers",
      tone: agents.offline + printers.offline === 0 ? "ok" : "warn",
    },
    {
      label: "Billing attention",
      value: pastDue,
      detail: "subscriptions past due",
      tone: pastDue === 0 ? "ok" : "warn",
    },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {signals.map((signal) => (
        <div key={signal.label} className="inset-panel p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-semibold text-ink-2">{signal.label}</span>
            <span className={`h-2 w-2 rounded-full ${signal.tone === "ok" ? "bg-ok-solid" : signal.tone === "bad" ? "bg-bad-solid" : "bg-warn-solid"}`} />
          </div>
          <div className="mt-3 text-2xl font-bold tabular-nums text-ink">{formatNumber(signal.value)}</div>
          <div className="mt-1 text-[11px] text-ink-4">{signal.detail}</div>
        </div>
      ))}
    </div>
  );
}
