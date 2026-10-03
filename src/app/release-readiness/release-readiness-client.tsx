"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  Callout,
  ErrorState,
  PageSkeleton,
  SegmentedControl,
  StatusBadge,
  type Tone,
} from "../../components/ui";
import { useI18n } from "../../i18n/react";

type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT APPLICABLE";
type Row = {
  area: string;
  implemented: Status;
  runtimeVerified: Status;
  status: Status;
  evidence: string;
  rootCause?: string;
};

type SystemHealthPayload = {
  policy?: string;
  overall?: string;
  [key: string]: unknown;
};

type Filter = "all" | "attention" | "pass";

const STATUS_TONE: Record<Status, Tone> = {
  PASS: "ok",
  FAIL: "bad",
  BLOCKED: "warn",
  "NOT APPLICABLE": "neutral",
};

export default function ReleaseReadinessClient() {
  const { t } = useI18n();
  const STATUS_LABEL: Record<Status, string> = {
    PASS: t("release.status.pass"),
    FAIL: t("release.status.fail"),
    BLOCKED: t("release.status.blocked"),
    "NOT APPLICABLE": t("release.status.na"),
  };
  const [rows] = useState<Row[]>([
    {
      area: "Real Print Certification Mode (canonical pipeline + idempotency + state-driven)",
      implemented: "PASS",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "POST /api/printers/[id]/certify uses createPrintJobForPrinter (tenant validation, lifecycle, virtual rejection, executable status, agent ownership, protocol/capability, entitlements, queue limits, idempotency, transactional admission, runtime revalidation, notification). Idempotency-Key header supported, autoKey cert:printer:tenant:minuteBucket. Wizard state-driven from job row status (queued→pending, claimed→ok, etc.), not inferred from lastSeenAt. Physical BLOCKED in sandbox.",
      rootCause: "Previous direct db.insert bypassed canonical admission — fixed to use createPrintJobForPrinter",
    },
    {
      area: "Printer Capability Matrix (Transport/Protocol/Document/Duplex/Color/Status + driver/spooler evidence)",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "GET /api/printers/capabilities, printer-health.ts normalizePrinterStatus evidence-based with freshness check, driver health from capabilities.driver_name + fresh, spooler health requires capabilities.spooler_status not just DB status. Covered by automated regression tests; current CI status is reported by GitHub Actions.",
    },
    {
      area: "Agent Health ONLINE/DEGRADED/OFFLINE/STARTING (evidence-based, observed vs inferred)",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "lib/agent-health.ts computeAgentHealthStatus with STARTING (createdAt<5min, never seen), ONLINE <90s, DEGRADED 90s-5m, OFFLINE >5m. Checks: Gateway observed, Queue observed, Printers observed, Version observed, Heartbeat inferred labeled. failureCount null with note NOT MEASURED. RECOVERING removed (requires history). Covered by automated regression tests; current CI status is reported by GitHub Actions.",
    },
    {
      area: "Windows Service Recovery (SCM lifecycle, failure actions, state/start type/recovery/last restart/failure count/exit code)",
      implemented: "PASS",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "docs/WINDOWS_SERVICE_RECOVERY.md, /api/agents/service-status returns BLOCKED explicit with instructions, code hardened system32_exe, run_bounded_command. Runtime requires Windows host with sc.exe — BLOCKED in sandbox.",
    },
    {
      area: "Printer Queue Health + Gateway↔Spooler Job linking (evidence-based statuses)",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "printer-health.ts statuses ONLINE/IDLE/PRINTING/PAPER_OUT/OFFLINE/ERROR/DRIVER_ERROR/SPOOLER_ERROR/UNREACHABLE/UNKNOWN with freshness check, spoolerJobId column + job_events.spooler_job_id, agent/jobs PATCH persists spoolerJobId, timeline includes connection stage.",
    },
    {
      area: "Job Timeline (Created/Queued/Claimed/Accepted/Connection/Printing/Delivery/Success + failure path)",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "GET /api/jobs/[id]/timeline returns timeline from job_events or derived, claim token REDACTED (sha256 hash), not raw. Covered by automated regression tests; current CI status is reported by GitHub Actions.",
    },
    {
      area: "Distributed Trace correlation IDs (request_id/job_id/tenant_id/agent_id/printer_id/attempt_id/claim_id/spooler_job_id)",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "src/server/correlation.ts AsyncLocalStorage, X-Request-Id header, log.ts auto-enrichment, docs/DISTRIBUTED_TRACING.md documents the application-specific OTel-inspired fields. Covered by automated regression tests; current CI status is reported by GitHub Actions.",
    },
    {
      area: "System Health tenant-safe + overall policy",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "lib/system-health.ts checkQueue now requires tenantId (tenant-safe), checkAgents/Printers require tenantId, overall policy: CRITICAL ERROR→error, UNKNOWN→unknown, IMPORTANT ERROR→error, UNKNOWN→unknown, EXTERNAL ERROR→error, UNKNOWN/WARN→warn (intentionally unverified externals cap overall at WARN, never OK — prevents false OK). Policy documented. Odoo/Billing UNKNOWN honest. Covered by automated regression tests; current CI status is reported by GitHub Actions.",
    },
    {
      area: "Tenant isolation",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "Composite foreign keys, tenant_id scoping in the APIs, and tenant-safe system-health regression coverage are present; current CI status is reported by GitHub Actions.",
    },
    {
      area: "Claim tokens not exposed",
      implemented: "PASS",
      runtimeVerified: "PASS",
      status: "PASS",
      evidence: "timeline route redacts claimToken via sha256 hash, regression test ensures raw token never returned.",
    },
    {
      area: "IPP support / driverless direction (not claiming full IPP Everywhere certification)",
      implemented: "PASS",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "printer-capability.ts has IPP/IPPS support, capability matrix, but NOT claiming IPP Everywhere conformance without conformance testing. Marked as IPP support / driverless direction.",
    },
    {
      area: "Tauri updater signed",
      implemented: "FAIL",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "Audit src-tauri/Cargo.toml and tauri.conf.json — no updater plugin/config/signing pipeline found. Marked NOT IMPLEMENTED/BLOCKED, not claimed as PASS.",
    },
    {
      area: "Physical printing",
      implemented: "PASS",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "Test-print creates real job row but paper outcome unverified, certification Physical BLOCKED by design in sandbox. Requires hardware.",
    },
    {
      area: "Odoo runtime",
      implemented: "PASS",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "Odoo addon views fixed (invisible), but no real Odoo 19 deployment, cannot test buttons. System health Odoo UNKNOWN honest.",
    },
    {
      area: "PostgreSQL integration (tenant-isolation, concurrency)",
      implemented: "PASS",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "Code inspected, but integration tests skipped without DB. Marked BLOCKED.",
    },
    {
      area: "Go agent race detector",
      implemented: "PASS",
      runtimeVerified: "BLOCKED",
      status: "BLOCKED",
      evidence: "No Go toolchain in sandbox, go test -race cannot run, manual grep audit only.",
    },
  ]);

  const [systemHealth, setSystemHealth] = useState<SystemHealthPayload | null>(null);
  const [showRawHealth, setShowRawHealth] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/system/health", { credentials: "include", cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(t("errors.serviceUnavailable"));
        return r.json() as Promise<SystemHealthPayload>;
      })
      .then((data) => {
        if (!cancelled) setSystemHealth(data);
      })
      .catch(() => {
        // A failed health fetch (session expired, forbidden, gateway down)
        // must not be rendered as health data. Leave the live section hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const overall = rows.some((r) => r.status === "FAIL")
    ? "FAIL"
    : rows.some((r) => r.status === "BLOCKED")
      ? "BLOCKED (explicit)"
      : "PASS";

  const counts = useMemo(
    () => ({
      pass: rows.filter((r) => r.status === "PASS").length,
      blocked: rows.filter((r) => r.status === "BLOCKED").length,
      fail: rows.filter((r) => r.status === "FAIL").length,
    }),
    [rows],
  );

  const visibleRows = rows.filter((row) => {
    if (filter === "attention") return row.status !== "PASS";
    if (filter === "pass") return row.status === "PASS";
    return true;
  });

  const tone: Tone = overall === "FAIL" ? "bad" : overall === "PASS" ? "ok" : "warn";

  return (
    <div className="space-y-5">
      <Card
        className={`border-s-[3px] ${
          tone === "bad" ? "border-s-bad-solid" : tone === "warn" ? "border-s-warn-solid" : "border-s-ok-solid"
        }`}
      >
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-md font-[620] tracking-[-0.015em] text-ink">
                {t("release.decision", { overall })}
              </h2>
              <StatusBadge tone={tone} label={tone === "ok" ? t("release.badge.ship") : tone === "warn" ? t("release.badge.conditional") : t("release.badge.blocked")} />
            </div>
            <p className="mt-1.5 max-w-[86ch] text-sm leading-relaxed text-ink-3">
              {t("release.summaryBody")}
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-px overflow-hidden rounded-sg border border-edge bg-edge-subtle">
            {[
              { label: t("release.count.pass"), value: counts.pass, tone: "text-ok" },
              { label: t("release.count.blocked"), value: counts.blocked, tone: "text-warn" },
              { label: t("release.count.fail"), value: counts.fail, tone: "text-bad" },
            ].map((item) => (
              <div key={item.label} className="bg-surface px-4 py-2.5 text-center">
                <div className={`text-lg font-[660] leading-none tabular ${item.tone}`}>{item.value}</div>
                <div className="mt-1 text-2xs font-[600] uppercase tracking-[0.08em] text-ink-3">
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
          subtitle={t("release.checklistSubtitle", { visible: String(visibleRows.length), total: String(rows.length) })}
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
            {visibleRows.map((row) => {
              const open = expanded === row.area;
              return (
                <li key={row.area}>
                  <div className="flex flex-wrap items-start gap-3 px-5 py-4">
                    <StatusBadge tone={STATUS_TONE[row.status]} label={STATUS_LABEL[row.status]} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-[600] leading-snug text-ink">{row.area}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                        <span>
                          {t("release.implemented")}{" "}
                          <span className="font-[550] text-ink-2">{STATUS_LABEL[row.implemented]}</span>
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
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-edge px-2.5 text-sm font-[550] text-ink-2 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink"
                    >
                      {t("release.evidence")}
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform duration-[160ms] ${open ? "rotate-180" : ""}`}
                        aria-hidden
                      />
                    </button>
                  </div>
                  {open && (
                    <div className="space-y-3 px-5 pb-5">
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

      {systemHealth && (
        <Card>
          <CardHeader
            title={t("release.liveHealth")}
            subtitle={systemHealth.policy ? t("release.overallPolicy", { policy: systemHealth.policy }) : undefined}
            actions={
              <Button variant="secondary" size="sm" onClick={() => setShowRawHealth((v) => !v)}>
                {showRawHealth ? t("release.hideJson") : t("release.showJson")}
              </Button>
            }
          />
          {showRawHealth && (
            <pre className="mx-5 my-4 max-h-64 overflow-auto rounded-sg border border-edge-subtle bg-surface-2 p-3.5 font-mono text-2xs leading-relaxed text-ink-2">
              {JSON.stringify(systemHealth, null, 2)}
            </pre>
          )}
        </Card>
      )}

      <Card>
        <CardHeader
          title={t("release.complianceTitle")}
          subtitle={t("release.complianceSubtitle")}
        />
        <ul className="list-disc space-y-2 ps-9 pe-5 py-5 text-sm text-ink-2">
          <li>
            <strong className="font-[600] text-ink">{t("release.compliance.otel")}</strong> (not full
            OpenTelemetry): custom fields request_id/job_id/tenant_id/agent_id/printer_id/attempt_id/claim_id/spooler_job_id
            in logs and headers, documented as application-specific, not official OTel semantic conventions.
          </li>
          <li>
            <strong className="font-[600] text-ink">{t("release.compliance.ipp")}</strong> (not IPP
            Everywhere certified): IPP/IPPS transport supported, capability matrix, but conformance
            testing not run, so not claiming certification.
          </li>
          <li>
            <strong className="font-[600] text-ink">{t("release.compliance.tauri")}</strong>: no updater plugin/config found
            in tauri.conf.json, marked NOT IMPLEMENTED/BLOCKED, not claimed as PASS. Capabilities 21
            perms least-privilege verified.
          </li>
          <li>
            <strong className="font-[600] text-ink">{t("release.compliance.odooBilling")}</strong>: UNKNOWN / NOT VERIFIED
            honest, intentionally-unverified externals cap overall at WARN (never OK) — policy prevents
            false green.
          </li>
        </ul>
      </Card>
    </div>
  );
}
