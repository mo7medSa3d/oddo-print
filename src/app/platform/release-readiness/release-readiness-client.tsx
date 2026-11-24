"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Card,
  CardHeader,
  Callout,
  SegmentedControl,
  StatusBadge,
  type Tone,
} from "../../../components/ui";
import { useI18n } from "../../../i18n/react";
import type { MessageKey } from "../../../i18n/messages/en";

type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT APPLICABLE" | "UNVERIFIED";

/**
 * Compliance notes for the release report.
 *
 * Each item states what is verified, what is not, and the consequence — the raw
 * engineering detail that used to sit in the list body now lives behind the
 * "Technical detail" disclosure, so the report reads as status rather than as
 * developer commentary.
 */
const COMPLIANCE_NOTES = [
  { labelKey: "release.compliance.otel", summaryKey: "release.compliance.otelSummary", detailKey: "release.compliance.otelDetail", statusKey: "release.count.blocked", tone: "warn" },
  { labelKey: "release.compliance.ipp", summaryKey: "release.compliance.ippSummary", detailKey: "release.compliance.ippDetail", statusKey: "release.count.unverified", tone: "warn" },
  { labelKey: "release.compliance.tauri", summaryKey: "release.compliance.tauriSummary", detailKey: "release.compliance.tauriDetail", statusKey: "release.count.blocked", tone: "bad" },
  { labelKey: "release.compliance.odooBilling", summaryKey: "release.compliance.odooBillingSummary", detailKey: "release.compliance.odooBillingDetail", statusKey: "release.count.unverified", tone: "warn" },
] as const satisfies ReadonlyArray<{
  labelKey: MessageKey;
  summaryKey: MessageKey;
  detailKey: MessageKey;
  statusKey: MessageKey;
  tone: Tone;
}>;
type SourceEvidence = "DOCUMENTED" | "MISSING";

type Row = {
  area: string;
  sourceEvidence: SourceEvidence;
  runtimeVerified: Status;
  status: Status;
  evidence: string;
  rootCause?: string;
};

type Filter = "all" | "attention" | "pass";

const STATUS_TONE: Record<Status, Tone> = {
  UNVERIFIED: "warn",
  PASS: "ok",
  FAIL: "bad",
  BLOCKED: "warn",
  "NOT APPLICABLE": "neutral",
};

export default function ReleaseReadinessClient() {
  const { t, formatNumber } = useI18n();
  const STATUS_LABEL: Record<Status, string> = {
    UNVERIFIED: t("release.status.unverified"),
    PASS: t("release.status.pass"),
    FAIL: t("release.status.fail"),
    BLOCKED: t("release.status.blocked"),
    "NOT APPLICABLE": t("release.status.na"),
  };
  const SOURCE_EVIDENCE_LABEL: Record<SourceEvidence, string> = {
    DOCUMENTED: t("release.sourceEvidence.documented"),
    MISSING: t("release.sourceEvidence.missing"),
  };
  const rows: Row[] = [
    { area: t("release.area.certification"), evidence: t("release.evidence.certification"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.capabilities"), evidence: t("release.evidence.capabilities"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.agentHealth"), evidence: t("release.evidence.agentHealth"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.serviceRecovery"), evidence: t("release.evidence.serviceRecovery"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.queueHealth"), evidence: t("release.evidence.queueHealth"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.timeline"), evidence: t("release.evidence.timeline"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.trace"), evidence: t("release.evidence.trace"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.systemHealth"), evidence: t("release.evidence.systemHealth"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.tenantIsolation"), evidence: t("release.evidence.tenantIsolation"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.claimPrivacy"), evidence: t("release.evidence.claimPrivacy"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.ipp"), evidence: t("release.evidence.ipp"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.updater"), evidence: t("release.evidence.updater"), sourceEvidence: "MISSING", runtimeVerified: "UNVERIFIED", status: "BLOCKED" },
    { area: t("release.area.physical"), evidence: t("release.evidence.physical"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.odoo"), evidence: t("release.evidence.odoo"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.postgres"), evidence: t("release.evidence.postgres"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
    { area: t("release.area.goRace"), evidence: t("release.evidence.goRace"), sourceEvidence: "DOCUMENTED", runtimeVerified: "UNVERIFIED", status: "UNVERIFIED" },
  ];

  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const overall: Status = rows.some((r) => r.status === "FAIL")
    ? "FAIL"
    : rows.some((r) => r.status === "BLOCKED")
      ? "BLOCKED"
      : rows.some((r) => r.status === "UNVERIFIED") ? "UNVERIFIED" : "PASS";

  const counts = {
      pass: rows.filter((r) => r.status === "PASS").length,
      blocked: rows.filter((r) => r.status === "BLOCKED").length,
      fail: rows.filter((r) => r.status === "FAIL").length,
      unverified: rows.filter((r) => r.status === "UNVERIFIED").length,
  };

  const visibleRows = rows.filter((row) => {
    if (filter === "attention") return row.status !== "PASS";
    if (filter === "pass") return row.status === "PASS";
    return true;
  });

  const tone: Tone = overall === "FAIL" ? "bad" : overall === "PASS" ? "ok" : "warn";

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-md font-[620] tracking-[-0.015em] text-ink">
                {t("release.decision", { overall: STATUS_LABEL[overall] })}
              </h2>
              <StatusBadge tone={tone} label={tone === "ok" ? t("release.badge.ship") : tone === "warn" ? t("release.badge.conditional") : t("release.badge.blocked")} />
            </div>
            <p className="mt-1.5 max-w-[86ch] text-sm leading-relaxed text-ink-3">
              {t("release.summaryBody")}
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-4 gap-px overflow-hidden rounded-md border border-edge bg-edge-subtle">
            {[
              { label: t("release.count.pass"), value: counts.pass, tone: "text-ok" },
              { label: t("release.count.blocked"), value: counts.blocked, tone: "text-warn" },
              { label: t("release.count.fail"), value: counts.fail, tone: "text-bad" },
              { label: t("release.count.unverified"), value: counts.unverified, tone: "text-ink-3" },
            ].map((item) => (
              <div key={item.label} className="bg-surface px-4 py-2.5 text-center">
                <div className={`text-lg font-[660] leading-none tabular-nums ${item.tone}`}>{formatNumber(item.value)}</div>
                <div className="mt-1 text-xs font-[550] text-ink-3">
                  {item.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={t("release.checklist")}
          subtitle={t("release.checklistSubtitle", { visible: formatNumber(visibleRows.length), total: formatNumber(rows.length) })}
          actions={
            <SegmentedControl
              label={t("release.filterLabel")}
              value={filter}
              onChange={setFilter}
              size="sm"
              options={[
                { value: "all", label: t("release.filter.all") },
                { value: "attention", label: t("release.filter.attention") },
                { value: "pass", label: t("release.filter.pass") },
              ]}
            />
          }
        />

        {visibleRows.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-[550] text-ink">{t("release.emptyTitle")}</p>
            <p className="mt-1 text-sm text-ink-3">{t("release.emptyBody")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {visibleRows.map((row, index) => {
              const open = expanded === row.area;
              return (
                <li key={row.area}>
                  <div className="flex flex-wrap items-start gap-3 px-5 py-4">
                    <StatusBadge tone={STATUS_TONE[row.status]} label={STATUS_LABEL[row.status]} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-[600] leading-snug text-ink">{row.area}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                        <span>
                          {t("release.sourceEvidence")}{" "}
                          <span className="font-[550] text-ink-2">{SOURCE_EVIDENCE_LABEL[row.sourceEvidence]}</span>
                        </span>
                        <span aria-hidden>·</span>
                        <span>
                          {t("release.runtimeVerified")}{" "}
                          <span className="font-[550] text-ink-2">{STATUS_LABEL[row.runtimeVerified]}</span>
                        </span>
                        {row.rootCause && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-[550] text-brand">{t("release.rootCauseFixed")}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : row.area)}
                      aria-expanded={open}
                      aria-controls={`release-evidence-${index}`}
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-sm border border-edge px-2.5 text-sm font-[550] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2"
                    >
                      {t("release.evidence")}
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
                        aria-hidden
                      />
                    </button>
                  </div>
                  {open && (
                    <div id={`release-evidence-${index}`} className="space-y-3 px-5 pb-5">
                      <p className="max-w-[100ch] text-sm leading-relaxed text-ink-2">{row.evidence}</p>
                      {row.rootCause && (
                        <Callout tone="info" title={t("release.rootCauseFixed")}>
                          {row.rootCause}
                        </Callout>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={t("release.complianceTitle")}
          subtitle={t("release.complianceSubtitle")}
        />
        <ul className="divide-y divide-edge-subtle px-5">
          {COMPLIANCE_NOTES.map((note) => (
            <li key={note.labelKey} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0">
                <div className="text-sm font-[600] text-ink">{t(note.labelKey)}</div>
                <p className="mt-1 text-sm leading-relaxed text-ink-3">{t(note.summaryKey)}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-[550] text-brand">
                    {t("release.technicalDetail")}
                  </summary>
                  <p dir="auto" className="mt-1.5 font-mono text-xs leading-relaxed text-ink-2">{t(note.detailKey)}</p>
                </details>
              </div>
              <StatusBadge tone={note.tone} label={t(note.statusKey)} className="shrink-0" />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
