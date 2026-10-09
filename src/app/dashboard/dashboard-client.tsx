"use client";

import { fetchWithTimeout } from "../../lib/fetch-timeout";
import React, { useState, useMemo, useEffect } from "react";
import { ensureCustomerSession } from "../../lib/session-config";
import { useRouter } from "next/navigation";
import {
  deleteAgentResult,
  getDashboardJobsResult,
  getDashboardStateResult,
  setAgentLifecycleResult,
  setPrinterLifecycleResult,
} from "../actions";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  PauseCircle,
  PlayCircle,
  Printer as PrinterIcon,
  Plus,
  RefreshCw,
  Server,
  Search,
  LayoutGrid,
  List,
  Wifi,
  Usb,
  Layers,
  RotateCcw,
  Eye,
  Trash2,
  Cpu,
  ShieldCheck,
  Clock,
  FileText,
  Inbox,
  KeyRound,
  X,
  ChevronRight,
  MoreHorizontal,
  Info,
  ArrowUpRight,
} from "lucide-react";
import { apiMessageKey } from "../../lib/api-error-keys";
import type { MessageKey } from "../../i18n/messages/en";
import type { Translator } from "../../i18n/translate";
import {
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Select,
  StatusBadge,
  Mono,
  Modal,
  CopyButton,
  IconButton,
  Menu,
  Progress,
  EmptyState,
  ErrorState,
  Callout,
  TableSkeleton,
  Tabs,
  SegmentedControl,
  Avatar,
  KeyValueList,
  Tooltip,
  type MenuItemSpec,
  type Tone,
} from "../../components/ui";
import {
  agentLiveView,
  deriveOutcome,
  jobGuidance,
  jobFailurePresentation,
  jobDisplayLabel,
  jobLabel,
  jobTone as sharedJobTone,
  printerLabel,
  printerObservationFreshness,
  printerTone as sharedPrinterTone,
  effectivePrinterStatus,
} from "../../shared/job-vocabulary";
import { copyTextToClipboard } from "../../lib/clipboard";
import { generateIdempotencyKey } from "../../lib/idempotency";
import { DiagnosticOperations, decodeDiagnosticResult, diagnosticScope, diagnosticMessageKey, diagnosticMessageType, type DiagnosticResult } from "../../shared/diagnostic-test";
import { shortId } from "../../lib/utils";
import { useI18n } from "../../i18n/react";
import { getPrinterLanguageBadges } from "../../lib/printer-capability";
import PrintCertificationWizard from "../../components/PrintCertificationWizard";
import JobTimeline from "../../components/JobTimeline";
import UpgradeLimitDialog, { type UpgradeLimitResource } from "../../components/UpgradeLimitDialog";
import { isLimitSignalResult } from "../../lib/limit-signal";

export type Agent = {
  id: string;
  name: string;
  pairingCode: string | null;
  pairingCodeExpiresAt?: Date | null;
  status: string;
  lifecycle: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  printerCount: number;
  staleThresholdSeconds?: number;
  metadata?: unknown;
};

export type Printer = {
  id: string;
  agentId: string;
  agentName?: string | null;
  name: string;
  printerType: string;
  deviceClass?: string | null;
  connectionType: string;
  protocol?: string | null;
  lifecycle: string;
  status: string;
  reportedStatus?: string | null;
  freshness?: "fresh" | "stale" | "missing";
  config?: unknown;
  capabilities?: unknown;
  lastSeenAt?: Date | null;
};

export type Job = {
  id: string;
  agentId: string;
  agentName?: string | null;
  printerId: string;
  printerName?: string | null;
  status: string;
  destination?: string | null;
  documentType?: string | null;
  error?: string | null;
  payload?: unknown;
  retries?: number;
  deliveryAttempts?: number;
  claimedAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  ackedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type FleetMeta = {
  pageSize: number;
  agentOffset: number;
  agentHasMore: boolean;
  printerOffset: number;
  printerHasMore: boolean;
  totalAgents: number;
  onlineAgents: number;
  totalPrinters: number;
  onlinePrinters: number;
};

type JobDetailsResponse = Omit<Job, "payload"> & {
  archived?: boolean;
  diagnosticPayload?: unknown;
};

class DashboardApiError extends Error {
  constructor(
    public readonly key: MessageKey,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
    public readonly httpStatus?: number,
  ) {
    // `super` stays debug-only: the operator reads `key` through `t()`, never
    // the English string the Gateway put in the body.
    super(key);
  }
}

type BillingUsage = {
  plan: { id: string; name: string };
  resources: {
    agents: { used: number; limit: number | "unlimited" | null };
    printers: { used: number; limit: number | "unlimited" | null };
    prints: {
      unit: "job";
      used: number;
      limit: number | "unlimited";
      remaining: number | "unlimited";
      periodStart: string;
      periodEnd: string | null;
    };
  };
};

const MAX_DIAGNOSTIC_PREVIEW_CHARS = 64 * 1024;

function stringifyDiagnosticPayload(payload: unknown, t: Translator): string {
  // Loading is an async UI state, not a payload value. If the list projection
  // intentionally omits payload or the details response has no diagnostic
  // payload, render an honest empty state instead of a fake perpetual loader.
  if (payload === undefined) return t("job.noPayload");
  if (payload === null) return t("job.noPayload");
  try {
    return JSON.stringify(payload, null, 2) || t("job.noPayload");
  } catch {
    return t("job.payloadUnrenderable");
  }
}

function diagnosticPayloadPreview(text: string, t: Translator): string {
  if (text.length <= MAX_DIAGNOSTIC_PREVIEW_CHARS) return text;
  return text.slice(0, MAX_DIAGNOSTIC_PREVIEW_CHARS) +
    "\n\n" + t("job.payloadTruncated", { size: "64 KiB" });
}

function formatCountdown(
  expiresAt: Date | string | null | undefined,
  expiredLabel: string,
): { text: string; expired: boolean } {
  if (!expiresAt) return { text: "10:00", expired: false };
  const exp = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const now = new Date();
  const diffMs = exp.getTime() - now.getTime();
  if (diffMs <= 0) return { text: expiredLabel, expired: true };
  const min = Math.floor(diffMs / 60000);
  const sec = Math.floor((diffMs % 60000) / 1000);
  return {
    text: `${min}:${sec.toString().padStart(2, "0")}`,
    expired: false,
  };
}

/**
 * A job still owned by an agent. Operator reprint must not be offered for
 * these: the Reprint route answers JOB_NOT_TERMINAL for anything in flight.
 */
const IN_FLIGHT_JOB_STATUSES = new Set(["queued", "claimed", "printing"]);

function isJobInFlight(status: string): boolean {
  return IN_FLIGHT_JOB_STATUSES.has(status.toLowerCase());
}

async function sendGatewayReprint(jobId: string): Promise<{ jobId?: string }> {
  const response = await fetchWithTimeout(`/api/jobs/${encodeURIComponent(jobId)}/reprint`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : "HTTP_ERROR";
    throw new DashboardApiError(apiMessageKey(code, response.status, "errors.reprintFailed"), code, body ?? {});
  }
  return { jobId: typeof body?.jobId === "string" ? body.jobId : undefined };
}

function upgradeLimitResourceForEntitlement(entitlement: unknown): UpgradeLimitResource | null {
  switch (entitlement) {
    case "max_agents": return "agents";
    case "max_printers": return "printers";
    case "max_prints_per_period": return "prints";
    default: return null;
  }
}

function upgradeLimitFromApiError(error: DashboardApiError): {
  resource: UpgradeLimitResource;
  used?: number | null;
  limit?: number | "unlimited" | null;
  periodEnd?: string | null;
  retryAfterSeconds?: number | null;
} | null {
  const resource = upgradeLimitResourceForEntitlement(error.details.entitlement);
  if (!resource) return null;
  return {
    resource,
    used: typeof error.details.used === "number" ? error.details.used : null,
    limit: typeof error.details.limit === "number" || error.details.limit === "unlimited" ? error.details.limit : null,
    periodEnd: typeof error.details.periodEnd === "string" ? error.details.periodEnd : null,
    retryAfterSeconds: typeof error.details.retryAfterSeconds === "number" ? error.details.retryAfterSeconds : null,
  };
}

function upgradeLimitFromLimitSignal(limit: {
  entitlement: string;
  message: string;
  used?: number | null;
  max?: number | "unlimited" | null;
  periodEnd?: string | null;
  retryAfterSeconds?: number | null;
}): {
  resource: UpgradeLimitResource;
  used?: number | null;
  limit?: number | "unlimited" | null;
  periodEnd?: string | null;
  retryAfterSeconds?: number | null;
} | null {
  const resource = upgradeLimitResourceForEntitlement(limit.entitlement);
  if (!resource) return null;
  return {
    resource,
    used: limit.used ?? null,
    limit: limit.max ?? null,
    periodEnd: limit.periodEnd ?? null,
    retryAfterSeconds: limit.retryAfterSeconds ?? null,
  };
}

async function sendGatewayTestPage(printerId: string, operationKey: string): Promise<DiagnosticResult> {
  const response = await fetchWithTimeout(`/api/printers/${encodeURIComponent(printerId)}/test-print`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": operationKey,
    },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.ok) return decodeDiagnosticResult(body, printerId);
  const obj = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const code = typeof obj.code === "string" ? obj.code : "HTTP_ERROR";
  throw new DashboardApiError(apiMessageKey(code, response.status, "errors.testPageFailed"), code, obj, response.status);
}

/* ---------- Local presentational helpers ---------- */

function KpiCell({
  label,
  value,
  meta,
  tone,
  progress,
}: {
  label: string;
  value: React.ReactNode;
  meta?: React.ReactNode;
  tone?: Tone;
  progress?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-surface p-3.5 sm:p-4">
      <span className="min-w-0 text-xs font-[550] leading-relaxed text-ink-3">{label}</span>
      <span className="text-2xl font-[640] leading-none tracking-[-0.02em] text-ink tabular">
        {value}
      </span>
      <span className="flex min-h-[16px] min-w-0 flex-wrap items-center gap-1.5 text-xs leading-relaxed text-ink-3">
        {tone && (
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              tone === "ok" ? "bg-ok-solid" : tone === "bad" ? "bg-bad-solid" : tone === "warn" ? "bg-warn-solid" : "bg-ink-4"
            }`}
          />
        )}
        {meta}
      </span>
      {typeof progress === "number" && <Progress value={progress} label={label} className="mt-0.5" />}
    </div>
  );
}

function PrinterLanguageChips({ printer }: { printer: Printer }) {
  // deviceClass must not invent printer languages. The declared
  // protocol/connection are authoritative (mirrors server-side routing).
  // See getPrinterLanguageBadges in ../lib/printer-capability.
  const badges = getPrinterLanguageBadges(printer.protocol ?? "", printer.connectionType ?? "");
  if (badges.length === 0) return <span className="text-xs text-ink-4">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((label) => (
        <span
          key={label}
          className="rounded-xs border border-edge-subtle bg-surface-2 px-1.5 py-0.5 text-xs font-[550] text-ink-3"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function connectionIcon(connectionType: string) {
  const c = connectionType.toLowerCase();
  if (c === "usb") return <Usb className="h-3.5 w-3.5 text-ink-3" aria-hidden />;
  if (c === "network" || c === "tcp") return <Wifi className="h-3.5 w-3.5 text-ink-3" aria-hidden />;
  return <Layers className="h-3.5 w-3.5 text-ink-3" aria-hidden />;
}

function connectionLabel(connectionType: string, t: Translator): string {
  const c = connectionType.toLowerCase();
  if (c === "spooler") return t("printer.connection.spooler");
  if (c === "usb") return t("printer.connection.usb");
  if (c === "ipp" || c === "ipps") return t("printer.connection.ipp");
  if (c === "network" || c === "tcp") return t("printer.connection.network");
  return t("printer.connection.generic");
}

export default function DashboardClient({
  initialAgents,
  initialPrinters,
  initialJobs,
  initialFleet,
  databaseError,
  canMutate,
  diagnosticActorScope,
}: {
  initialAgents: Agent[];
  initialPrinters: Printer[];
  initialJobs: Job[];
  initialFleet: FleetMeta;
  databaseError: string | null;
  canMutate: { printers: boolean; printersTest: boolean; agentsLifecycle: boolean; jobsCancel: boolean; jobsRetry: boolean };
  diagnosticActorScope: string;
}) {
  const [agents, setAgents] = useState<Agent[]>(initialAgents);
  const [printers, setPrinters] = useState<Printer[]>(initialPrinters);
  const [kpiJobs, setKpiJobs] = useState<Job[]>(initialJobs);
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [fleet, setFleet] = useState<FleetMeta>(initialFleet);
  const [agentOffset, setAgentOffset] = useState(initialFleet.agentOffset);
  const [printerOffset, setPrinterOffset] = useState(initialFleet.printerOffset);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobsRetryTick, setJobsRetryTick] = useState(0);
  const router = useRouter();
  const { t, tc, locale, formatNumber, formatDate, formatRelativeTime, formatDateTime } = useI18n();


  const [prevAgents, setPrevAgents] = useState(initialAgents);
  if (prevAgents !== initialAgents) {
    setPrevAgents(initialAgents);
    setAgents(initialAgents);
  }

  const [prevPrinters, setPrevPrinters] = useState(initialPrinters);
  if (prevPrinters !== initialPrinters) {
    setPrevPrinters(initialPrinters);
    setPrinters(initialPrinters);
  }

  const [prevJobs, setPrevJobs] = useState(initialJobs);
  if (prevJobs !== initialJobs) {
    setPrevJobs(initialJobs);
    setKpiJobs(initialJobs);
    setJobs(initialJobs);
  }

  const [prevFleet, setPrevFleet] = useState(initialFleet);
  if (prevFleet !== initialFleet) {
    setPrevFleet(initialFleet);
    setFleet(initialFleet);
    setAgentOffset(initialFleet.agentOffset);
    setPrinterOffset(initialFleet.printerOffset);
  }

  const [agentName, setAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const diagnosticOps = React.useRef(new DiagnosticOperations(generateIdempotencyKey));
  const [certifyPrinter, setCertifyPrinter] = useState<Printer | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [activePairing, setActivePairing] = useState<{ id?: string; code: string; expiresAt: Date } | null>(null);
  // Agent ids known when the current pairing attempt started, keyed by the
  // pairing code so manual dismissals cannot leak a stale baseline into the
  // next attempt. A brand-new agent has no id yet, so completion is the
  // appearance of a NEW online identity rather than any historical
  // heartbeat (C057).
  const pairingBaseline = React.useRef<{ code: string; ids: Set<string> } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [countdownText, setCountdownText] = useState("10:00");
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
  const [pendingAgentAction, setPendingAgentAction] = useState<{ agent: Agent; next: "disabled" | "retired" } | null>(null);
  const [reprintCandidate, setReprintCandidate] = useState<Job | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [upgradeLimit, setUpgradeLimit] = useState<{
    resource: UpgradeLimitResource;
    used?: number | null;
    limit?: number | "unlimited" | null;
    periodEnd?: string | null;
    retryAfterSeconds?: number | null;
  } | null>(null);
  const [billingUsage, setBillingUsage] = useState<BillingUsage | null>(null);
  const [billingUsageError, setBillingUsageError] = useState(false);

  const [printerViewMode, setPrinterViewMode] = useState<"grid" | "table">("grid");
  const [printerSearch, setPrinterSearch] = useState("");
  const [debouncedPrinterSearch, setDebouncedPrinterSearch] = useState("");
  const [printerStatusFilter, setPrinterStatusFilter] = useState<string>("all");

  const [jobSearch, setJobSearch] = useState("");
  const [debouncedJobSearch, setDebouncedJobSearch] = useState("");
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("all");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedJobDetails, setSelectedJobDetails] = useState<JobDetailsResponse | null>(null);
  const [selectedJobPayload, setSelectedJobPayload] = useState<{ jobId: string; value: unknown } | null>(null);
  const [selectedJobPayloadLoading, setSelectedJobPayloadLoading] = useState(false);
  const [selectedJobPayloadError, setSelectedJobPayloadError] = useState(false);
  const [selectedJobPayloadReloadKey, setSelectedJobPayloadReloadKey] = useState(0);
  // Inspector metadata refresh generation: the drawer stays open while the
  // job advances, so details are re-polled while non-terminal instead of
  // going stale next to a live timeline (C057).
  const [selectedJobRefreshTick, setSelectedJobRefreshTick] = useState(0);

  const openJobDetails = React.useCallback((job: Job) => {
    setSelectedJob(job);
    setSelectedJobDetails(null);
    setSelectedJobPayload(null);
    setSelectedJobPayloadLoading(true);
    setSelectedJobPayloadError(false);
    setSelectedJobPayloadReloadKey(0);
  }, []);

  const closeJobDetails = React.useCallback(() => {
    setSelectedJob(null);
    setSelectedJobDetails(null);
    setSelectedJobPayload(null);
    setSelectedJobPayloadLoading(false);
    setSelectedJobPayloadError(false);
    setSelectedJobPayloadReloadKey(0);
  }, []);

  const retrySelectedJobPayload = React.useCallback(() => {
    if (!selectedJob) return;
    setSelectedJobPayloadLoading(true);
    setSelectedJobPayloadError(false);
    setSelectedJobPayloadReloadKey((key) => key + 1);
  }, [selectedJob]);

  useEffect(() => {
    if (!selectedJob) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    let cancelled = false;
    let refreshTimer: number | undefined;

    void fetchWithTimeout(`/api/jobs/${encodeURIComponent(selectedJob.id)}?includePayload=1`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`job details request failed with ${res.status}`);
        const row = (await res.json()) as JobDetailsResponse;
        if (!cancelled) {
          setSelectedJobDetails(row);
          setSelectedJobPayload({ jobId: selectedJob.id, value: row.diagnosticPayload ?? null });
          // Keep status/actions fresh while the job is still moving; terminal
          // rows settle (the separately loaded payload is retained).
          if (!["success", "failed", "expired"].includes(String(row.status ?? ""))) {
            refreshTimer = window.setTimeout(() => setSelectedJobRefreshTick((tick) => tick + 1), 5000);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedJobDetails(null);
          setSelectedJobPayload({ jobId: selectedJob.id, value: null });
          setSelectedJobPayloadError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedJobPayloadLoading(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      controller.abort();
    };
  }, [selectedJob, selectedJobPayloadReloadKey, selectedJobRefreshTick]);

  const selectedJobView =
    selectedJob && selectedJobDetails?.id === selectedJob.id
      ? ({ ...selectedJob, ...selectedJobDetails } as Job)
      : selectedJob;

  const dashboardRequest = React.useCallback(async <T,>(operation: () => Promise<{ ok: true; data: T } | { ok: false; error: string | null; status: number; code: string }>): Promise<T> => {
    const session = await ensureCustomerSession();
    if (!session.authenticated) {
      router.replace("/login?next=%2Fdashboard");
      throw new Error(t("errors.sessionExpired"));
    }
    const result = await operation();
    if (!result.ok) {
      if (result.status === 401) router.replace("/login?next=%2Fdashboard");
      throw new Error(result.error ?? t(apiMessageKey(result.code, result.status, "errors.operationFailed")));
    }
    return result.data;
  }, [router, t]);
  const getDashboardJobs = React.useCallback((options?: Parameters<typeof getDashboardJobsResult>[0]) => dashboardRequest(() => getDashboardJobsResult(options)), [dashboardRequest]);
  const getDashboardState = React.useCallback((options?: Parameters<typeof getDashboardStateResult>[0]) => dashboardRequest(() => getDashboardStateResult(options)), [dashboardRequest]);
  const deleteAgent = (id: string) => dashboardRequest(() => deleteAgentResult(id));
  const setPrinterLifecycle = (id: string, lifecycle: "active" | "disabled" | "retired") => dashboardRequest(() => setPrinterLifecycleResult(id, lifecycle));
  const setAgentLifecycle = (id: string, lifecycle: "active" | "disabled" | "retired") => dashboardRequest(() => setAgentLifecycleResult(id, lifecycle));

  const fleetQueryRef = React.useRef({
    agentOffset: initialFleet.agentOffset,
    printerOffset: initialFleet.printerOffset,
    printerSearch: "",
    printerStatus: "all",
  });
  useEffect(() => {
    fleetQueryRef.current = {
      agentOffset,
      printerOffset,
      printerSearch: debouncedPrinterSearch,
      printerStatus: printerStatusFilter,
    };
  }, [agentOffset, printerOffset, debouncedPrinterSearch, printerStatusFilter]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const normalized = printerSearch.trim();
      setDebouncedPrinterSearch(normalized.length === 1 ? "" : normalized.slice(0, 64));
    }, 250);
    return () => clearTimeout(timer);
  }, [printerSearch]);

  const jobsGeneration = React.useRef(0);
  const filterRef = React.useRef({ status: "all", search: "" });
  useEffect(() => {
    filterRef.current = { status: jobStatusFilter, search: debouncedJobSearch };
  }, [jobStatusFilter, debouncedJobSearch]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const normalized = jobSearch.trim();
      // The server query deliberately requires at least two characters so a
      // one-character wildcard search cannot force a low-selectivity scan on
      // every keystroke. Keep the character visible and filter the currently
      // loaded rows locally until the term is selective enough for the server.
      setDebouncedJobSearch(normalized.length === 1 ? "" : normalized);
    }, 250);
    return () => clearTimeout(timer);
  }, [jobSearch]);

  useEffect(() => {
    let cancelled = false;
    const generation = ++jobsGeneration.current;
    async function loadFilteredJobs() {
      setJobsLoading(true);
      setJobsError(null);
      try {
        const res = await getDashboardJobs({
          status: jobStatusFilter,
          search: debouncedJobSearch,
          limit: 100,
        });
        if (!cancelled && generation === jobsGeneration.current) {
          setJobs(res as unknown as Job[]);
        }
      } catch (err) {
        // Surface the failure: a stale job list with no error state is
        // indistinguishable from "no jobs" for an operator.
        console.error("Dashboard jobs query failed:", err);
        if (!cancelled && generation === jobsGeneration.current) {
          setJobsError(t("errors.loadJobsFailed"));
        }
      } finally {
        if (!cancelled && generation === jobsGeneration.current) {
          setJobsLoading(false);
        }
      }
    }
    void loadFilteredJobs();
    return () => {
      cancelled = true;
    };
  }, [jobStatusFilter, debouncedJobSearch, jobsRetryTick, t, getDashboardJobs]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const refreshBillingUsage = React.useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/billing/usage", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setBillingUsageError(true);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") {
        setBillingUsageError(true);
        return;
      }
      setBillingUsage(data as BillingUsage);
      setBillingUsageError(false);
    } catch {
      setBillingUsageError(true);
    }
  }, []);

  const [refreshing, setRefreshing] = React.useState(false);
  const refreshingRef = React.useRef(false);
  const queuedFleetQueryRef = React.useRef<typeof fleetQueryRef.current | null>(null);

  const refreshData = React.useCallback(async (queryOverride?: typeof fleetQueryRef.current) => {
    if (refreshingRef.current) {
      if (queryOverride) queuedFleetQueryRef.current = queryOverride;
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
    let currentQuery = queryOverride;
    try {
      while (true) {
        try {
          const data = await getDashboardState(currentQuery ?? fleetQueryRef.current);
      if (data) {
        setAgents(data.agents as Agent[]);
        setPrinters(data.printers as Printer[]);
        setFleet(data.fleet as FleetMeta);
        setKpiJobs(data.jobs as Job[]);
        if (data.agents.length === 0 && data.fleet.agentOffset > 0) {
          const next = Math.max(0, data.fleet.agentOffset - data.fleet.pageSize);
          setAgentOffset(next);
          fleetQueryRef.current = { ...fleetQueryRef.current, agentOffset: next };
        }
        if (data.printers.length === 0 && data.fleet.printerOffset > 0) {
          const next = Math.max(0, data.fleet.printerOffset - data.fleet.pageSize);
          setPrinterOffset(next);
          fleetQueryRef.current = { ...fleetQueryRef.current, printerOffset: next };
        }

        const current = filterRef.current;
        if (current.status === "all" && !current.search) {
          ++jobsGeneration.current;
          setJobsError(null);
          setJobs(data.jobs as Job[]);
          setJobsLoading(false);
        } else {
          const generation = ++jobsGeneration.current;
          void getDashboardJobs({
            status: current.status,
            search: current.search,
            limit: 100,
          }).then((res) => {
            if (generation === jobsGeneration.current && current.status === filterRef.current.status && current.search === filterRef.current.search) { setJobs(res as unknown as Job[]); setJobsError(null); }
          }).catch(() => {
            if (generation === jobsGeneration.current) setJobsError(t("errors.loadJobsFailed"));
          }).finally(() => { if (generation === jobsGeneration.current) setJobsLoading(false); });
        }

        setActivePairing((currentPairing) => {
          if (!currentPairing) {
            pairingBaseline.current = null;
            return null;
          }
          const online = (a: (typeof data.agents)[number]) => a.status === "online";
          if (currentPairing.id !== undefined) {
            // Known identity (re-pair/re-enable): completion is that identity
            // observed online. Status is availability-derived server-side, so
            // online implies a fresh heartbeat — a preserved lastSeenAt from
            // before re-enabling cannot complete it (C057).
            const target = data.agents.find((a) => a.id === currentPairing.id);
            if (target && online(target)) {
              setMessage({
                text: t("success.agentPairedOnline", { name: target.name }),
                type: "ok",
              });
              pairingBaseline.current = null;
              return null;
            }
            return currentPairing;
          }
          // New agent (id not yet known): baseline the known ids on the first
          // tick for THIS code, then complete when a NEW online identity
          // appears. Freshness comes from the online status itself, never
          // from a historical lastSeenAt or a cleared expiry (C057).
          const baseline = pairingBaseline.current;
          if (baseline === null || baseline.code !== currentPairing.code) {
            pairingBaseline.current = { code: currentPairing.code, ids: new Set(data.agents.map((a) => a.id)) };
            return currentPairing;
          }
          const newcomer = data.agents.find((a) => !baseline.ids.has(a.id) && online(a));
          if (newcomer) {
            setMessage({
              text: t("success.agentPairedOnline", { name: newcomer.name }),
              type: "ok",
            });
            pairingBaseline.current = null;
            return null;
          }
          return currentPairing;
        });
      }
          void refreshBillingUsage();
        } catch (error) {
          setMessage({ text: error instanceof Error ? error.message : t("errors.operationFailed"), type: "err" });
        }

        const queued = queuedFleetQueryRef.current;
        queuedFleetQueryRef.current = null;
        if (!queued) break;
        currentQuery = queued;
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [refreshBillingUsage, t, getDashboardState, getDashboardJobs]);

  useEffect(() => {
    let cancelled = false;
    const nextQuery = {
      ...fleetQueryRef.current,
      printerOffset: 0,
      printerSearch: debouncedPrinterSearch,
      printerStatus: printerStatusFilter,
    };
    fleetQueryRef.current = nextQuery;
    queueMicrotask(() => {
      if (cancelled) return;
      setPrinterOffset(0);
      void refreshData(nextQuery);
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedPrinterSearch, printerStatusFilter, refreshData]);

  useEffect(() => {
    const intervalMs = activePairing ? 3000 : 6000;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refreshData();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [activePairing, refreshData]);

  useEffect(() => {
    if (!activePairing) return;
    const interval = setInterval(() => {
      const { text, expired } = formatCountdown(activePairing.expiresAt, t("status.expired"));
      setCountdownText(text);
      if (expired) {
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [activePairing, t]);

  const kpis = useMemo(() => {
    const totalAgents = fleet.totalAgents;
    const onlineAgents = fleet.onlineAgents;

    const totalPrinters = fleet.totalPrinters;
    const onlinePrinters = fleet.onlinePrinters;

    const inFlightJobs = kpiJobs.filter((j) => {
      const s = j.status.toLowerCase();
      return s === "queued" || s === "printing" || s === "claimed";
    }).length;

    const completedJobs = kpiJobs.filter((j) => j.status.toLowerCase() === "success").length;
    const attentionJobs = kpiJobs.filter(
      (j) => deriveOutcome(j.status, j.error) === "unknown"
    ).length;
    const failedJobs = kpiJobs.filter((j) => j.status.toLowerCase() === "failed" && deriveOutcome(j.status, j.error) === "not_printed").length;
    const expiredJobs = kpiJobs.filter((j) => j.status.toLowerCase() === "expired").length;
    // Mutually exclusive terminal buckets for the rate denominator: success
    // rows report outcome unknown by design (transport success is not paper
    // proof) and expired rows with markers are already inside attentionJobs,
    // so naively summing the display counts double-counts them (C057).
    const expiredDefiniteJobs = kpiJobs.filter(
      (j) => j.status.toLowerCase() === "expired" && deriveOutcome(j.status, j.error) === "not_printed"
    ).length;
    const attentionTerminalJobs = kpiJobs.filter(
      (j) => (j.status.toLowerCase() === "failed" || j.status.toLowerCase() === "expired") && deriveOutcome(j.status, j.error) === "unknown"
    ).length;
    const resolvedJobs = completedJobs + failedJobs + expiredDefiniteJobs + attentionTerminalJobs;
    const successRate =
      resolvedJobs > 0 ? Math.round((completedJobs / resolvedJobs) * 100) : null;

    return {
      totalAgents,
      onlineAgents,
      totalPrinters,
      onlinePrinters,
      inFlightJobs,
      completedJobs,
      attentionJobs,
      failedJobs,
      expiredJobs,
      successRate,
    };
  }, [fleet, kpiJobs]);

  const runAction = async <T,>(operation: () => Promise<T>, successMsg?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await operation();
      if (isLimitSignalResult(result)) {
        const limit = upgradeLimitFromLimitSignal(result.limit);
        setMessage(null);
        if (limit) setUpgradeLimit(limit);
        // `limit.message` is an internal exception string, not operator copy.
        else setMessage({ text: t(apiMessageKey(result.limit.code, 429, "errors.billingBlocked")), type: "err" });
        return undefined;
      }
      if (successMsg) setMessage({ text: successMsg, type: "ok" });
      void refreshData();
      return result;
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : t("errors.operationFailed"),
        type: "err",
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const handleGatewayTestPrint = async (printerId: string, printerName: string) => {
    const scope = diagnosticScope(window.location.origin, diagnosticActorScope, printerId);
    // A subsequent physical print after a verified Gateway outcome is NEVER
    // a silent click/retry. A lost response retries the same existing key.
    if (diagnosticOps.current.observed(scope)) {
      if (!window.confirm(t("diagnostic.repeatConfirm"))) return;
      diagnosticOps.current.confirmRepeat(scope);
    }
    const key = diagnosticOps.current.begin(scope);
    if (!key) return; // synchronous flight owner, including same-tick clicks
    setTestingPrinterId(printerId);
    setMessage(null);
    try {
      const result = await sendGatewayTestPage(printerId, key);
      diagnosticOps.current.accept(scope, result);
      setMessage({
        text: t(diagnosticMessageKey(result), { printer: printerName }),
        type: diagnosticMessageType(result),
      });
      void refreshData();
    } catch (error) {
      // A timeout/5xx/4xx or malformed 2xx is not proof of no persistence.
      // Retain the key for explicit reconciliation via the same idempotent POST.
      diagnosticOps.current.uncertain(scope);
      if (error instanceof DashboardApiError) {
        const limit = upgradeLimitFromApiError(error);
        if (limit) {
          setUpgradeLimit(limit);
          return;
        }
        const errorKey = error.httpStatus === 401 ? "diagnostic.authRequired"
          : error.httpStatus === 403 ? "diagnostic.permissionDenied" : "diagnostic.admissionUnknown";
        setMessage({ text: t(errorKey), type: "err" });
      } else {
        setMessage({ text: t("diagnostic.admissionUnknown"), type: "err" });
      }
    } finally {
      diagnosticOps.current.uncertain(scope);
      setTestingPrinterId(null);
    }
  };

  /**
   * Reprint is the ONE mutation that deliberately creates a NEW physical
   * print, so it must be double-submit guarded at the UI boundary.
   *
   * The server already converges concurrent reprints of the same job onto
   * one row (print-job-service reuses an active reprint job), so this guard
   * is about state/UX correctness, not a duplicate-print hole.
   */
  const confirmReprint = async () => {
    const job = reprintCandidate;
    if (!job || busy) return;
    setReprintCandidate(null);
    setMessage(null);
    setBusy(true);
    try {
      const result = await sendGatewayReprint(job.id);
      setMessage({
        text: result.jobId
          ? t("success.reprintQueuedWithJob", { printer: job.printerId, job: result.jobId.slice(0, 12) })
          : t("success.reprintQueued", { printer: job.printerId }),
        type: "ok",
      });
      void refreshData();
    } catch (error) {
      if (error instanceof DashboardApiError) {
        const limit = upgradeLimitFromApiError(error);
        if (limit) {
          setUpgradeLimit(limit);
          return;
        }
        setMessage({ text: t(error.key), type: "err" });
      } else {
        setMessage({ text: t("errors.reprintFailed"), type: "err" });
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmAgentAction = async () => {
    if (!pendingAgentAction) return;
    const { agent, next } = pendingAgentAction;
    setPendingAgentAction(null);
    const result = await runAction(() => setAgentLifecycle(agent.id, next));
    if (result && next === "disabled") {
      setMessage({
        text: t("dashboard.agentDisabledNotice", { name: agent.name, count: agent.printerCount }),
        type: "ok",
      });
    }
    if (result && next === "retired") {
      setMessage({ text: t("dashboard.agentRetiredNotice", { name: agent.name }), type: "ok" });
    }
  };

  const handleCreateAgent = async (name: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetchWithTimeout("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const code = typeof body?.code === "string" ? body.code : "AGENT_CREATE_FAILED";
        throw new DashboardApiError(apiMessageKey(code, response.status, "errors.agentRegistrationFailed"), code, body ?? {});
      }

      const expiresAt = typeof body?.expiresAt === "string"
        ? new Date(body.expiresAt)
        : typeof body?.expires_at === "string"
          ? new Date(body.expires_at)
          : new Date(Date.now() + 1000 * 60 * 10);
      const pairingCode = typeof body?.pairingCode === "string" ? body.pairingCode : "";
      const id = typeof body?.id === "string" ? body.id : undefined;
      setAgentOffset(0);
      fleetQueryRef.current = { ...fleetQueryRef.current, agentOffset: 0 };
      setActivePairing({ id, code: pairingCode, expiresAt });
      setAgentName("");
      setMessage({
        text: t("success.agentRegisteredWithCode", { code: pairingCode }),
        type: "ok",
      });
      void refreshData();
    } catch (error) {
      if (error instanceof DashboardApiError && error.code === "MAX_AGENTS_EXCEEDED") {
        setUpgradeLimit({
          resource: "agents",
          used: typeof error.details.used === "number" ? error.details.used : null,
          limit: typeof error.details.limit === "number" ? error.details.limit : null,
        });
      } else if (error instanceof DashboardApiError) {
        setMessage({ text: t(error.key), type: "err" });
      } else {
        setMessage({ text: t("errors.agentRegistrationFailed"), type: "err" });
      }
    } finally {
      setBusy(false);
    }
  };

  const copyPairingCode = async (code: string) => {
    if (await copyTextToClipboard(code)) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } else {
      setMessage({ text: t("errors.copyManually"), type: "err" });
    }
  };

  const filteredPrinters = printers;
  const printerFiltersActive = printerStatusFilter !== "all" || debouncedPrinterSearch.length >= 2;

  const filteredJobs = useMemo(() => {
    if (!jobSearch.trim()) return jobs;
    const q = jobSearch.toLowerCase();
    // Superset of the server search fields (id, destination, document type,
    // printer, agent, error): the client pass must never remove a row the
    // server matched (C056).
    return jobs.filter((j) => {
      return (
        j.id.toLowerCase().includes(q) ||
        j.printerId.toLowerCase().includes(q) ||
        (j.agentId && j.agentId.toLowerCase().includes(q)) ||
        (j.destination && j.destination.toLowerCase().includes(q)) ||
        (j.documentType && j.documentType.toLowerCase().includes(q)) ||
        (j.error && j.error.toLowerCase().includes(q))
      );
    });
  }, [jobs, jobSearch]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const printerById = useMemo(() => new Map(printers.map((p) => [p.id, p])), [printers]);

  const jobFilterTabs = ["all", "active", "queued", "success", "failed", "unknown", "expired"] as const;
  const jobTabs =
    jobStatusFilter === "all" || (jobFilterTabs as readonly string[]).includes(jobStatusFilter)
      ? (jobFilterTabs as unknown as string[])
      : [jobStatusFilter, ...jobFilterTabs];
  const jobTabLabels: Record<string, string> = {
    all: t("job.filter.all"),
    active: t("job.filter.inFlight"),
    queued: t("job.filter.queued"),
    success: t("job.filter.delivered"),
    failed: t("job.filter.failed"),
    unknown: t("job.filter.unknown"),
    expired: t("job.filter.expired"),
  };

  const jobActions = (job: Job): MenuItemSpec[] => {
    const outcome = deriveOutcome(job.status, job.error);
    // Server rule (src/app/api/jobs/[id]/reprint/route.ts): reprint requires a
    // terminal job AND rejects `success` with JOB_REPRINT_NOT_ALLOWED, because
    // the document already printed. Offering it here would be a dead-end
    // action that always fails, so success is excluded explicitly. Reprint is
    // also a mutation: read-only roles don't see it (C058).
    const canReprint = canMutate.jobsRetry && job.status.toLowerCase() !== "success" && !isJobInFlight(job.status);
    return [
      { key: "inspect", label: t("job.viewDetails"), icon: <Eye className="h-4 w-4" />, onSelect: () => openJobDetails(job) },
      {
        key: "copy",
        label: t("job.copyJobId"),
        icon: <Copy className="h-4 w-4" />,
        onSelect: () => void copyTextToClipboard(job.id),
      },
      ...(canReprint
        ? [
            {
              key: "reprint",
              label: outcome === "unknown" ? t("job.reprintVerify") : t("job.reprintQueue"),
              icon: <RotateCcw className="h-4 w-4" />,
              separatorBefore: true,
              onSelect: () => setReprintCandidate(job),
            } as MenuItemSpec,
          ]
        : []),
    ];
  };

  const printerActions = (printer: Printer): MenuItemSpec[] => {
    const active = printer.lifecycle === "active";
    const retired = printer.lifecycle === "retired";
    return [
      ...(canMutate.printersTest
        ? [
            {
              key: "test",
              label: t("printer.sendTestPage"),
              icon: <PlayCircle className="h-4 w-4" />,
              disabled: busy || testingPrinterId !== null || !active,
              onSelect: () => void handleGatewayTestPrint(printer.id, printer.name),
            },
          ]
        : []),
      { key: "certify", label: t("cert.run"), icon: <ShieldCheck className="h-4 w-4" />, onSelect: () => setCertifyPrinter(printer) },
      {
        key: "copy",
        label: t("printer.copyPrinterId"),
        icon: <Copy className="h-4 w-4" />,
        onSelect: () => void copyTextToClipboard(printer.id),
      },
      // Terminal lifecycle cannot reactivate: retired printers are never
      // offered enable/disable (the server rejects it). Read-only roles see
      // no lifecycle item at all (C058).
      ...(canMutate.printers && !retired
        ? [
            {
              key: "lifecycle",
              label: active ? t("printer.disable") : t("printer.enable"),
              separatorBefore: true,
              disabled: busy,
              onSelect: () =>
                void runAction(
                  () => setPrinterLifecycle(printer.id, active ? "disabled" : "active"),
                  active ? t("printer.disabled") : t("printer.enabled"),
                ),
            },
          ]
        : []),
    ];
  };

  const goToAgentOffset = (nextOffset: number) => {
    const next = Math.max(0, nextOffset);
    setAgentOffset(next);
    const query = { ...fleetQueryRef.current, agentOffset: next };
    fleetQueryRef.current = query;
    void refreshData(query);
  };

  const goToPrinterOffset = (nextOffset: number) => {
    const next = Math.max(0, nextOffset);
    setPrinterOffset(next);
    const query = { ...fleetQueryRef.current, printerOffset: next };
    fleetQueryRef.current = query;
    void refreshData(query);
  };

  const reenableAgent = async (agent: Agent) => {
    const result = await runAction(() => setAgentLifecycle(agent.id, "active"));
    if (!result) return;
    const pairingCode = typeof result.pairingCode === "string" ? result.pairingCode : "";
    if (pairingCode && result.pairingCodeExpiresAt) {
      setActivePairing({ id: agent.id, code: pairingCode, expiresAt: result.pairingCodeExpiresAt });
      setRegisterOpen(true);
    }
    void refreshData();
  };

  const agentActions = (agent: Agent): MenuItemSpec[] => [
    ...(canMutate.agentsLifecycle && agent.lifecycle === "active"
      ? [
          {
            key: "disable",
            label: t("agent.disable"),
            icon: <PauseCircle className="h-4 w-4" />,
            disabled: busy,
            onSelect: () => setPendingAgentAction({ agent, next: "disabled" as const }),
          },
        ]
      : []),
    ...(canMutate.agentsLifecycle && agent.lifecycle === "disabled"
      ? [
          {
            key: "enable",
            label: t("agent.reenable"),
            icon: <PlayCircle className="h-4 w-4" />,
            disabled: busy,
            onSelect: () => { void reenableAgent(agent); },
          },
        ]
      : []),
    ...(canMutate.agentsLifecycle && agent.lifecycle !== "retired"
      ? [
          {
            key: "retire",
            label: t("agent.retire"),
            icon: <AlertTriangle className="h-4 w-4" />,
            disabled: busy,
            onSelect: () => setPendingAgentAction({ agent, next: "retired" as const }),
          },
        ]
      : []),
    {
      key: "delete",
      label: t("agent.delete"),
      icon: <Trash2 className="h-4 w-4" />,
      tone: "danger" as const,
      separatorBefore: true,
      disabled: busy,
      onSelect: () => setAgentToDelete(agent),
    },
  ];

  const prints = billingUsage?.resources.prints;
  const printsLimitReached = prints && prints.limit !== "unlimited" && prints.remaining !== "unlimited" && prints.remaining === 0;
  const printsPercent =
    prints && prints.limit !== "unlimited" ? (prints.used / Math.max(1, prints.limit)) * 100 : null;
  const printerStatusOptions = ["all", "online", "busy", "offline", "error", "unknown", "stale", "disabled", "retired"] as const;

  const onlineAgentsLabel =
    kpis.totalAgents === 0
      ? t("agent.noAgents")
      : kpis.onlineAgents === kpis.totalAgents
        ? t("agent.allReachable")
        : tc("agent.unreachable", kpis.totalAgents - kpis.onlineAgents);

  const printerMetaLabel =
    kpis.totalPrinters === 0
      ? t("printer.noPrinters")
      : kpis.onlinePrinters === kpis.totalPrinters
        ? t("printer.allAvailable")
        : tc("printer.unavailable", kpis.totalPrinters - kpis.onlinePrinters);

  return (
    <div className="space-y-5">
      {/* ── Fleet summary ─────────────────────────────────────────── */}
      <section
        aria-label={t("dashboard.fleetSummary")}
        className="rounded-lg border border-edge bg-surface shadow-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-edge-subtle px-4 py-2.5">
          <h2 className="text-sm font-[600] text-ink">{t("dashboard.fleetSummary")}</h2>
          <div className="flex min-w-0 items-center gap-2">
            {/* Class order and tokens on the nominal pill are locked by
                tests/theme-consistency.test.ts — keep the literal string. */}
            {kpis.totalAgents > 0 && kpis.onlineAgents === kpis.totalAgents ? (
              <span className="inline-flex items-center gap-1.5 border border-ok-edge bg-ok-bg text-ok rounded-sm px-2 py-0.5 text-2xs font-[600]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok-solid" />
                {t("dashboard.fleetNominal")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-warn-edge bg-warn-bg px-2 py-0.5 text-2xs font-[600] text-warn">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warn-solid" />
                {kpis.totalAgents === 0 ? t("dashboard.waitingForFirstAgent") : onlineAgentsLabel}
              </span>
            )}
            <IconButton
              label={t("dashboard.refreshConsole")}
              onClick={() => void refreshData()}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
            </IconButton>
          </div>
        </div>

        {/* Separators come from 1px grid gaps over a divider-coloured
            backdrop, not `divide-*`. Tailwind's `divide-x` applies
            `& > :not(:last-child) { border-inline-end-width: 1px }` and
            `divide-y` the same for `border-bottom`, i.e. every child except the
            LAST gets a border. In the 2-column layout that draws a line on the
            card's right edge after the first row and another along its bottom
            edge after the third cell — stray lines hugging the card frame,
            which read as a broken border. 1px grid gaps are column-count
            agnostic, so no breakpoint can produce a stray edge. */}
        <div className="overflow-hidden rounded-b-lg"><div className="grid min-w-0 grid-cols-2 gap-px bg-edge-subtle sm:grid-cols-4">
          <KpiCell
            label={t("dashboard.agentsOnline")}
            value={`${kpis.onlineAgents}/${kpis.totalAgents}`}
            tone={kpis.totalAgents === 0 ? "neutral" : kpis.onlineAgents === kpis.totalAgents ? "ok" : "warn"}
            meta={onlineAgentsLabel}
          />
          <KpiCell
            label={t("dashboard.printersAvailable")}
            value={`${kpis.onlinePrinters}/${kpis.totalPrinters}`}
            tone={kpis.totalPrinters === 0 ? "neutral" : kpis.onlinePrinters === kpis.totalPrinters ? "ok" : "warn"}
            meta={printerMetaLabel}
          />
          <KpiCell
            label={t("dashboard.jobsInFlight")}
            value={kpis.inFlightJobs}
            tone={kpis.inFlightJobs > 0 ? "brand" : "neutral"}
            meta={t("dashboard.jobsInFlightMeta")}
          />
          <KpiCell
            label={t("dashboard.deliveryRate")}
            value={kpis.successRate === null ? "—" : `${kpis.successRate}%`}
            tone={kpis.successRate === null ? "neutral" : kpis.successRate >= 95 ? "ok" : kpis.successRate >= 80 ? "warn" : "bad"}
            meta={t("dashboard.deliveredOf", {
                completed: formatNumber(kpis.completedJobs),
                total: formatNumber(kpis.completedJobs + kpis.failedJobs + kpis.attentionJobs + kpis.expiredJobs),
              })}
            progress={kpis.successRate ?? undefined}
          />
        </div>
        </div>

        {prints && (
          <div className="flex flex-col gap-3 border-t border-edge-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="label-caps">{t("dashboard.printCredits")}</span>
                <span className="text-sm font-[600] tabular text-ink">
                  {formatNumber(prints.used)}
                  {prints.limit !== "unlimited" && (
                    <span className="font-[500] text-ink-3"> / {formatNumber(prints.limit)}</span>
                  )}
                </span>
                {prints.limit === "unlimited" && <StatusBadge tone="ok" label={t("billing.unlimited")} size="sm" />}
                {printsLimitReached && <StatusBadge tone="bad" label={t("billing.limitReached")} size="sm" />}
              </div>
              <p className="mt-0.5 text-xs text-ink-3">
                {billingUsage?.plan?.name ? `${billingUsage.plan.name} · ` : ""}
                {prints.periodEnd ? t("billing.resetsOnDate", { date: formatDate(prints.periodEnd) }) : t("billing.currentPeriod")}
              </p>
            </div>
            <div className="flex items-center gap-3 sm:shrink-0">
              {printsPercent !== null && (
                <Progress
                  className="w-full sm:w-[180px]"
                  value={printsPercent}
                  tone={printsLimitReached ? "bad" : printsPercent >= 85 ? "warn" : "brand"}
                  label={t("billing.printCreditUsage")}
                />
              )}
              <Button variant="ghost" size="sm" href="/billing" icon={<ArrowUpRight className="h-3.5 w-3.5" />}>
                {t("billing.manageBilling")}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* ── Notices ───────────────────────────────────────────────── */}
      {message && (
        <div className="flex items-start gap-2">
          <Callout
            tone={message.type === "ok" ? "ok" : "bad"}
            title={message.type === "ok" ? t("common.done") : t("common.actionNeeded")}
            className="flex-1"
          >
            {message.text}
          </Callout>
          <IconButton label={t("common.dismiss")} onClick={() => setMessage(null)} className="mt-1">
            <X className="h-4 w-4" aria-hidden />
          </IconButton>
        </div>
      )}

      {billingUsageError && (
        <Callout
          tone="warn"
          title={t("billing.usageUnavailable")}
          action={
            <Button variant="secondary" size="sm" onClick={() => void refreshBillingUsage()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("billing.usageUnavailableDashboardBody")}
        </Callout>
      )}

      {printsLimitReached && (
        <Callout
          tone="bad"
          title={t("billing.limitReachedTitle")}
          action={
            <Button variant="primary" size="sm" href="/billing">
              {t("limit.upgradePlan")}
            </Button>
          }
        >
          {t("dashboard.printCreditsExhausted")}
        </Callout>
      )}

      {activePairing && !registerOpen && (
        <Callout
          tone="brand"
          icon={<Cpu className="h-4 w-4" aria-hidden />}
          title={`${t("agent.pairingCode")}: ${activePairing.code}`}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copyPairingCode(activePairing.code)}
              icon={<Copy className="h-3.5 w-3.5" />}
            >
              {copiedCode ? t("success.copied") : t("agent.copyCode")}
            </Button>
          }
        >
          {t("agent.pairingCodeIntro")}{" "}
          <span className="font-[600] tabular text-ink">{countdownText}</span>.
        </Callout>
      )}

      {/* ── Fleet ─────────────────────────────────────────────────── */}
      <div className="grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-12">
        <Card className="overflow-hidden xl:col-span-4">
          {/* Heading literals ("Agents" / "Printers" / "Recent Print Jobs") are part of the
              operator vocabulary contracts asserted by the integration suite. */}
          <div className="flex flex-col gap-3 border-b border-edge-subtle px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <Server className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
              <div className="min-w-0">
                <h3 className="truncate text-md font-[600] leading-snug tracking-[-0.012em] text-ink">
                  {t("dashboard.tab.agents")}
                </h3>
                <p className="mt-0.5 text-sm leading-snug text-ink-3">
                  {t("agent.onlineOfCount", {
                    online: formatNumber(kpis.onlineAgents),
                    total: formatNumber(kpis.totalAgents),
                  })}
                </p>
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setRegisterOpen(true)}
              icon={<Plus className="h-3.5 w-3.5" />}
              disabled={busy || databaseError !== null}
              className="shrink-0"
            >
              {t("agent.registerTitle")}
            </Button>
          </div>

          {agents.length === 0 ? (
            <EmptyState
              icon={<Server className="h-5 w-5" />}
              title={t("empty.agents.title")}
              description={t("agent.registerEmptyDescription")}
              action={
                <Button variant="primary" size="sm" onClick={() => setRegisterOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
                  {t("agent.register")}
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-edge-subtle">
              {agents.map((agent) => {
                const view = agentLiveView(agent, nowMs, locale);
                const meta = agent.metadata as { hostname?: string; os?: string; version?: string } | undefined;
                return (
                  <li
                    key={agent.id}
                    className="flex items-start gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-surface-hover"
                  >
                    <Server className="mt-1 h-4 w-4 shrink-0 text-ink-4" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-[600] text-ink">{agent.name}</span>
                        <StatusBadge tone={view.tone} label={view.label} size="sm" pulse={view.tone === "ok"} />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-3">
                        <span className="font-mono text-2xs" title={agent.id}>{shortId(agent.id)}</span>
                        {meta?.hostname && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate">{meta.hostname}</span>
                          </>
                        )}
                        {meta?.os && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{meta.os}</span>
                          </>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-3">
                        <span>{tc("printer.count", agent.printerCount ?? 0)}</span>
                        <span aria-hidden>·</span>
                        <span title={formatDateTime(agent.lastSeenAt)}>
                          {t("agent.lastSeen")} {formatRelativeTime(agent.lastSeenAt)}
                        </span>
                        {agent.lifecycle !== "active" && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-[550] capitalize text-warn">{agent.lifecycle}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {agent.lifecycle === "disabled" && (
                        <Button variant="secondary" size="sm" onClick={() => { void reenableAgent(agent); }} disabled={busy}>
                          {t("agent.reenable")}
                        </Button>
                      )}
                      <Menu
                        label={t("common.agentActions", { name: agent.name })}
                        items={agentActions(agent)}
                        trigger={
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                          </span>
                        }
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {(fleet.agentOffset > 0 || fleet.agentHasMore) && (
            <div className="flex items-center justify-between gap-3 border-t border-edge-subtle px-4 py-3">
              <span className="text-xs tabular-nums text-ink-3">
                {formatNumber(fleet.agentOffset + (agents.length ? 1 : 0))}–{formatNumber(fleet.agentOffset + agents.length)} / {formatNumber(fleet.totalAgents)}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={refreshing || activePairing !== null || fleet.agentOffset === 0}
                  onClick={() => goToAgentOffset(fleet.agentOffset - fleet.pageSize)}
                >
                  {t("common.previousPage")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={refreshing || activePairing !== null || !fleet.agentHasMore}
                  onClick={() => goToAgentOffset(fleet.agentOffset + fleet.pageSize)}
                >
                  {t("common.nextPage")}
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden xl:col-span-8">
          <div className="flex flex-col gap-3 border-b border-edge-subtle px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <PrinterIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
              <div className="min-w-0">
                <h3 className="truncate text-md font-[600] leading-snug tracking-[-0.012em] text-ink">
                  {t("dashboard.tab.printers")}
                </h3>
                <p className="mt-0.5 text-sm leading-snug text-ink-3">
                  {t("dashboard.printersReady", {
                    ready: formatNumber(kpis.onlinePrinters),
                    total: formatNumber(kpis.totalPrinters),
                  })}
                </p>
              </div>
            </div>
            <div className="hidden xl:block">
            <SegmentedControl
              label={t("printer.viewToggle")}
              size="sm"
              value={printerViewMode}
              onChange={setPrinterViewMode}
              options={[
                { value: "grid", label: t("printer.view.cards"), icon: <LayoutGrid className="h-3.5 w-3.5" /> },
                { value: "table", label: t("printer.view.list"), icon: <List className="h-3.5 w-3.5" /> },
              ]}
            />
            </div>
          </div>

          {fleet.totalPrinters > 0 && (
            <div className="flex flex-col gap-2.5 border-b border-edge-subtle px-4 py-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
                <Input
                  type="search"
                  value={printerSearch}
                  onChange={(e) => setPrinterSearch(e.target.value)}
                  placeholder={t("printer.searchPlaceholder")}
                  aria-label={t("printer.searchLabel")}
                  maxLength={64}
                  className="ps-9"
                />
              </div>
              <Select
                aria-label={t("printer.filterByStatus")}
                value={printerStatusFilter}
                onChange={(e) => setPrinterStatusFilter(e.target.value)}
                className="sm:w-[190px]"
              >
                {printerStatusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status === "all" ? t("printer.allStatuses") : printerLabel(status, locale)}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {printers.length === 0 && !printerFiltersActive ? (
            <EmptyState
              icon={<PrinterIcon className="h-5 w-5" />}
              title={t("printer.noneDiscovered")}
              description={t("empty.printers.description")}
            />
          ) : filteredPrinters.length === 0 ? (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title={t("printer.noMatches")}
              description={t("printer.noMatchesHint")}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setPrinterSearch("");
                    setPrinterStatusFilter("all");
                  }}
                >
                  {t("common.clearFilters")}
                </Button>
              }
            />
          ) : (
            <>
            <ul className={`grid min-w-0 gap-3 p-3 sm:grid-cols-2 sm:p-4 ${printerViewMode === "table" ? "xl:hidden" : ""}`}>
              {filteredPrinters.map((printer) => {
                const parentAgent = agentById.get(printer.agentId);
                const effStatus = effectivePrinterStatus(printer, parentAgent, nowMs).toLowerCase();
                const freshness = printer.freshness ?? printerObservationFreshness(printer.lastSeenAt, nowMs);
                const displayStatus = effStatus;
                const active = printer.lifecycle === "active";
                return (
                  <li
                    key={printer.id}
                    className="flex min-w-0 flex-col gap-3 rounded-lg border border-edge bg-surface p-3.5 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-edge-strong hover:shadow-sm focus-within:border-brand"
                  >
                    <div className="flex min-w-0 flex-wrap items-start gap-2.5">
                      <PrinterIcon className="mt-1 h-4 w-4 shrink-0 text-ink-4" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-[600] text-ink">{printer.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                          {connectionIcon(printer.connectionType)}
                          <span>{connectionLabel(printer.connectionType, t)}</span>
                          {printer.protocol && (
                            <>
                              <span aria-hidden>·</span>
                              <span className="font-[550] text-ink-3">{printer.protocol}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex max-w-full flex-wrap items-center gap-1.5">
                      <StatusBadge
                        tone={sharedPrinterTone(displayStatus)}
                        label={printerLabel(displayStatus, locale)}
                        size="sm"
                        pulse={displayStatus === "online" && freshness === "fresh"}
                      />
                      {freshness === "stale" ? <StatusBadge tone="warn" label={t("status.stale")} size="sm" /> : null}
                      </div>
                    </div>

                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                      <div className="min-w-0">
                        <dt className="text-ink-4">{t("printer.agent")}</dt>
                        <dd className="truncate text-ink-2" title={printer.agentName ?? parentAgent?.name ?? undefined}>
                          {printer.agentName ?? parentAgent?.name ?? t("printer.unknownAgent")}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-ink-4">{t("printer.languages")}</dt>
                        <dd className="mt-0.5">
                          <PrinterLanguageChips printer={printer} />
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-edge-subtle pt-3">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleGatewayTestPrint(printer.id, printer.name)}
                        loading={testingPrinterId === printer.id}
                        disabled={busy || testingPrinterId !== null || !active}
                        icon={testingPrinterId === printer.id ? undefined : <PlayCircle className="h-3.5 w-3.5" />}
                      >
                        {testingPrinterId === printer.id ? t("printer.sending") : t("printer.sendTestPage")}
                      </Button>
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setCertifyPrinter(printer)}
                          icon={<ShieldCheck className="h-3.5 w-3.5" />}
                        >
                          {t("printer.certify")}
                        </Button>
                        <Menu
                          label={t("printer.moreActions", { name: printer.name })}
                          items={printerActions(printer)}
                          trigger={
                            <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
                              <MoreHorizontal className="h-4 w-4" aria-hidden />
                            </span>
                          }
                        />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {printerViewMode === "table" && (
            <div className="hidden min-w-0 overflow-x-auto xl:block">
              <table className="data-table min-w-[720px]">
                <caption className="sr-only">{t("printer.tableCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("printer.printer")}</th>
                    <th scope="col">{t("printer.agent")}</th>
                    <th scope="col">{t("printer.connection")}</th>
                    <th scope="col">{t("printer.languages")}</th>
                    <th scope="col">{t("common.status")}</th>
                    <th scope="col" className="w-[1%] text-end">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPrinters.map((printer) => {
                    const parentAgent = agentById.get(printer.agentId);
                    const effStatus = effectivePrinterStatus(printer, parentAgent, nowMs).toLowerCase();
                    const freshness = printer.freshness ?? printerObservationFreshness(printer.lastSeenAt, nowMs);
                    const displayStatus = effStatus;
                    const active = printer.lifecycle === "active";
                    return (
                      <tr key={printer.id}>
                        <td>
                          <div className="text-sm font-[550] text-ink">{printer.name}</div>
                          <div className="mt-0.5 truncate font-mono text-2xs text-ink-3" title={printer.id}>
                            {shortId(printer.id)}
                          </div>
                        </td>
                        <td className="text-sm text-ink-2">{printer.agentName ?? parentAgent?.name ?? "—"}</td>
                        <td>
                          <div className="flex items-center gap-1.5 text-xs text-ink-2">
                            {connectionIcon(printer.connectionType)}
                            <span>{connectionLabel(printer.connectionType, t)}</span>
                            {printer.protocol && <span className="font-[550] text-ink-3">· {printer.protocol}</span>}
                          </div>
                        </td>
                        <td>
                          <PrinterLanguageChips printer={printer} />
                        </td>
                        <td>
                          <div className="flex items-center gap-1"><StatusBadge tone={sharedPrinterTone(displayStatus)} label={printerLabel(displayStatus, locale)} size="sm" />{freshness === "stale" ? <StatusBadge tone="warn" label={t("status.stale")} size="sm" /> : null}</div>
                        </td>
                        <td className="text-end">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => void handleGatewayTestPrint(printer.id, printer.name)}
                              loading={testingPrinterId === printer.id}
                              disabled={busy || testingPrinterId !== null || !active}
                            >
                              {testingPrinterId === printer.id ? t("printer.sending") : t("printer.testPage")}
                            </Button>
                            <Menu
                              label={t("printer.moreActionsFor", { name: printer.name })}
                              items={printerActions(printer)}
                              trigger={
                                <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
                                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                                </span>
                              }
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            )}
            </>
          )}
          {(fleet.printerOffset > 0 || fleet.printerHasMore) && (
            <div className="flex items-center justify-end gap-2 border-t border-edge-subtle px-4 py-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={refreshing || fleet.printerOffset === 0}
                onClick={() => goToPrinterOffset(fleet.printerOffset - fleet.pageSize)}
              >
                {t("common.previousPage")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={refreshing || !fleet.printerHasMore}
                onClick={() => goToPrinterOffset(fleet.printerOffset + fleet.pageSize)}
              >
                {t("common.nextPage")}
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* ── Recent print jobs ─────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <CardHeader
          title={t("dashboard.tab.jobs")}
          subtitle={t("job.subtitle")}
          icon={<Layers className="h-4 w-4" />}
        />

        <div className="flex flex-col gap-3 border-b border-edge-subtle px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs
            tabs={jobTabs as readonly string[]}
            active={jobStatusFilter}
            onChange={setJobStatusFilter}
            labels={jobTabLabels}
            className="min-w-0"
          />
          <div className="flex items-center gap-2 lg:shrink-0">
            <div className="relative min-w-0 flex-1 lg:w-[240px]">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
              <Input
                type="search"
                value={jobSearch}
                onChange={(e) => setJobSearch(e.target.value)}
                placeholder={t("job.searchPlaceholder")}
                aria-label={t("job.searchLabel")}
                maxLength={64}
                className="ps-9"
              />
            </div>
          </div>
        </div>

        {jobsLoading && jobs.length === 0 ? (
          <TableSkeleton rows={6} columns={5} />
        ) : jobsError ? (
          <div className="px-4 py-5">
            <ErrorState
              title={t("job.unavailable")}
              message={jobsError}
              retry={() => setJobsRetryTick((tick) => tick + 1)}
            />
          </div>
        ) : filteredJobs.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-5 w-5" />}
            title={jobs.length === 0 ? t("empty.jobs.title") : t("job.noMatches")}
            description={
              jobs.length === 0
                ? t("job.emptySourceDescription")
                : t("job.noMatchesHint")
            }
            action={
              jobs.length === 0 ? (
                <Button variant="secondary" size="sm" href="/api-keys" icon={<KeyRound className="h-3.5 w-3.5" />}>
                  {t("job.connectOdoo")}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setJobSearch("");
                    setJobStatusFilter("all");
                  }}
                >
                  {t("common.clearFilters")}
                </Button>
              )
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto xl:block">
              <table className="data-table min-w-[860px]">
                <caption className="sr-only">{t("job.tableCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("job.job")}</th>
                    <th scope="col">{t("job.printer")}</th>
                    <th scope="col">{t("job.document")}</th>
                    <th scope="col">{t("job.status")}</th>
                    <th scope="col" className="text-end">{t("job.created")}</th>
                    <th scope="col" className="w-[1%] text-end">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((job) => {
                    const outcome = deriveOutcome(job.status, job.error);
                    const printer = printerById.get(job.printerId);
                    return (
                      <tr key={job.id}>
                        <td>
                          <button
                            type="button"
                            onClick={() => openJobDetails(job)}
                            title={job.id}
                            className="rounded-xs font-mono text-xs font-[600] text-brand transition-colors hover:text-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2"
                          >
                            {shortId(job.id)}
                          </button>
                          <div className="mt-0.5 truncate text-2xs text-ink-3">
                            {tc("job.attempts", job.deliveryAttempts ?? 0)}
                            {job.retries ? ` · ${tc("job.retries", job.retries)}` : ""}
                          </div>
                        </td>
                        <td>
                          <div className="truncate text-sm text-ink-2" title={job.printerName ?? printer?.name ?? undefined}>
                            {job.printerName ?? printer?.name ?? t("job.unknownPrinter")}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-2xs text-ink-3" title={job.printerId}>
                            {shortId(job.printerId)}
                          </div>
                        </td>
                        <td>
                          <div className="max-w-[220px] truncate text-sm text-ink-2" title={job.destination ?? undefined}>
                            {job.destination ?? "—"}
                          </div>
                          <div className="mt-0.5 text-2xs text-ink-4">
                            {job.documentType?.replace(/_/g, " ") ?? t("job.unknownType")}
                          </div>
                        </td>
                        <td>
                          <StatusBadge tone={sharedJobTone(job.status, outcome)} label={jobDisplayLabel(job.status, job.error, locale)} size="sm" />
                        </td>
                        <td className="text-end text-sm text-ink-3" title={formatDateTime(job.createdAt)}>
                          {formatRelativeTime(job.createdAt)}
                        </td>
                        <td className="text-end">
                          <Menu
                            label={t("job.actionsForJob", { id: shortId(job.id) })}
                            items={jobActions(job)}
                            placement="above"
                            trigger={
                              <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
                                <MoreHorizontal className="h-4 w-4" aria-hidden />
                              </span>
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile list */}
            <ul className="divide-y divide-edge-subtle xl:hidden">
              {filteredJobs.map((job) => {
                const outcome = deriveOutcome(job.status, job.error);
                const printer = printerById.get(job.printerId);
                return (
                  <li key={job.id} className="px-4 py-3.5">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => openJobDetails(job)}
                        className="min-w-0 flex-1 rounded-xs text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 focus-visible:ring-offset-2"
                      >
                        <span className="block truncate text-sm font-[550] text-ink">
                          {job.destination ?? shortId(job.id)}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-2xs text-ink-3">{shortId(job.id)}</span>
                      </button>
                      <StatusBadge tone={sharedJobTone(job.status, outcome)} label={jobDisplayLabel(job.status, job.error, locale)} size="sm" />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                      <span>{job.printerName ?? printer?.name ?? t("job.unknownPrinter")}</span>
                      <span aria-hidden>·</span>
                      <span title={formatDateTime(job.createdAt)}>{formatRelativeTime(job.createdAt)}</span>
                      <span aria-hidden>·</span>
                      <span>{job.documentType?.replace(/_/g, " ") ?? t("job.unknownType")}</span>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => openJobDetails(job)} icon={<Eye className="h-3.5 w-3.5" />}>
                        {t("job.inspect")}
                      </Button>
                      <Menu
                        label={t("job.actionsForJob", { id: shortId(job.id) })}
                        items={jobActions(job)}
                        placement="above"
                        trigger={
                          <span className="inline-flex h-9 items-center gap-1 rounded-sm border border-edge px-2.5 text-sm font-[550] text-ink-2">
                            {t("job.more")}
                            <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
                          </span>
                        }
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {jobsLoading && jobs.length > 0 && (
          <div className="border-t border-edge-subtle px-4 py-2 text-xs text-ink-3" role="status">
            {t("job.refreshing")}
          </div>
        )}
      </Card>

      {/* ── Register agent ────────────────────────────────────────── */}
      <Modal
        open={registerOpen}
        onClose={() => {
          if (!busy) {
            setRegisterOpen(false);
            setActivePairing(null);
            setCopiedCode(false);
          }
        }}
        title={activePairing ? t("agent.pairTitle") : t("agent.registerTitle")}
        description={
          activePairing ? t("agent.pairDescription") : t("agent.pairHint")
        }
        footer={
          activePairing ? (
            <Button variant="primary" onClick={() => { setRegisterOpen(false); setActivePairing(null); setCopiedCode(false); }}>
              {t("common.done")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setRegisterOpen(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busy || agentName.trim().length < 2}
                loading={busy}
                onClick={() => void handleCreateAgent(agentName.trim())}
              >
                {busy ? t("agent.generatingCode") : t("agent.generateCode")}
              </Button>
            </>
          )
        }
      >
        {activePairing ? (
          <div className="space-y-4">
            <div className="rounded-sg border border-edge-accent bg-brand-subtle px-4 py-4">
              <div className="label-caps text-brand-subtle-text">{t("agent.pairingCode")}</div>
              <div className="mt-2 flex items-center gap-3">
                <code className="select-all font-mono text-3xl font-[650] tracking-[0.12em] text-ink">
                  {activePairing.code}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void copyPairingCode(activePairing.code)}
                  icon={<Copy className="h-3.5 w-3.5" />}
                >
                  {copiedCode ? t("success.copied") : t("common.copy")}
                </Button>
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm text-ink-2">
                <Clock className="h-3.5 w-3.5 text-ink-4" aria-hidden />
                {t("agent.expiresIn")}{" "}
                <span className="font-[600] tabular text-ink">{countdownText}</span>
              </div>
            </div>
            <ol className="space-y-3">
              {[
                t("agent.openManagerStep"),
                t("agent.pairStep1"),
                t("agent.pairStep2"),
              ].map((step, index) => (
                <li key={step} className="flex gap-3 text-sm text-ink-2">
                  <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-edge bg-surface-2 text-2xs font-[650] text-ink-3 tabular">
                    {index + 1}
                  </span>
                  <span className="leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
            <Callout tone="info">{t("agent.codeSingleUse")}</Callout>
          </div>
        ) : (
          <div className="space-y-4">
            <Field
              label={t("agent.name")}
              htmlFor="agent-name"
              hint={t("agent.nameHint")}
              required
            >
              <Input
                id="agent-name"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={t("agent.namePlaceholder")}
                maxLength={80}
                autoFocus
                disabled={busy}
              />
            </Field>
            <Callout tone="info" icon={<Info className="h-4 w-4" />}>
              {t("agent.registrationInfo")}
            </Callout>
          </div>
        )}
      </Modal>

      {/* ── Job inspector ─────────────────────────────────────────── */}
      <Modal
        open={selectedJob !== null}
        onClose={() => closeJobDetails()}
        title={selectedJobView ? t("job.detailTitle", { id: selectedJobView.id.slice(0, 12) }) : t("job.job")}
        description={selectedJobView ? `${jobDisplayLabel(selectedJobView.status, selectedJobView.error, locale)} · ${formatDateTime(selectedJobView.createdAt)}` : undefined}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => closeJobDetails()}>
              {t("common.close")}
            </Button>
            {selectedJobView && selectedJobView.status.toLowerCase() !== "success" && !isJobInFlight(selectedJobView.status) && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  const job = selectedJobView;
                  closeJobDetails();
                  setReprintCandidate(job);
                }}
                icon={<RotateCcw className="h-4 w-4" />}
              >
                {deriveOutcome(selectedJobView.status, selectedJobView.error) === "unknown"
                  ? t("job.reprintVerify")
                  : t("job.reprintQueue")}
              </Button>
            )}
          </>
        }
      >
        {selectedJobView && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={sharedJobTone(selectedJobView.status, deriveOutcome(selectedJobView.status, selectedJobView.error))}
                label={jobDisplayLabel(selectedJobView.status, selectedJobView.error, locale)}
              />
              <span className="font-mono text-xs text-ink-4">{selectedJobView.id}</span>
              <CopyButton value={selectedJobView.id} label={t("job.copyJobId")} />
            </div>

            <p className="text-sm leading-relaxed text-ink-2">
              {jobGuidance(selectedJobView.status, deriveOutcome(selectedJobView.status, selectedJobView.error), locale)}
            </p>

            {deriveOutcome(selectedJobView.status, selectedJobView.error) === "unknown" && (
              <Callout tone="warn" title={t("job.reprintWarning")}>
                {t("job.reprintDuplicates")}
              </Callout>
            )}

            {selectedJobView.error && (() => {
              const classified = jobFailurePresentation(selectedJobView.error, locale);
              return (
                <Callout tone="bad" title={classified?.title ?? t("job.reportedError")}>
                  <span className="break-words text-sm">{classified?.guidance ?? selectedJobView.error}</span>
                </Callout>
              );
            })()}

            <KeyValueList
              rows={[
                { label: t("job.printer"), value: selectedJobView.printerName ?? printerById.get(selectedJobView.printerId)?.name ?? selectedJobView.printerId },
                { label: t("printer.agent"), value: selectedJobView.agentName ?? agentById.get(selectedJobView.agentId)?.name ?? selectedJobView.agentId },
                { label: t("job.document"), value: selectedJobView.documentType?.replace(/_/g, " ") ?? "—" },
                { label: t("job.destination"), value: selectedJobView.destination ?? "—" },
                { label: t("job.deliveryAttempts"), value: String(selectedJobView.deliveryAttempts ?? 0) },
                { label: t("job.retries"), value: String(selectedJobView.retries ?? 0) },
                { label: t("job.claimedAt"), value: formatDateTime(selectedJobView.claimedAt) },
                { label: t("job.success"), value: formatDateTime(selectedJobView.deliveredAt) },
                { label: t("job.acknowledged"), value: formatDateTime(selectedJobView.ackedAt) },
              ]}
            />

            <div>
              <h3 className="mb-3 text-sm font-[600] text-ink">{t("job.timeline")}</h3>
              <JobTimeline jobId={selectedJobView.id} />
            </div>

            <details className="group rounded-sg border border-edge-subtle bg-surface-2">
              <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-[550] text-ink-2">
                <span className="inline-flex items-center gap-2">
                  <FileText className="h-4 w-4 text-ink-4" aria-hidden />
                  {t("job.diagnosticPayload")}
                </span>
                <ChevronRight className="h-4 w-4 text-ink-4 transition-transform duration-200 rtl:-scale-x-100 group-open:rotate-90 rtl:group-open:-rotate-90" aria-hidden />
              </summary>
              <div className="border-t border-edge-subtle p-3">
                {!selectedJobPayloadLoading && !selectedJobPayloadError && (
                  <div className="mb-2 flex justify-end">
                    <CopyButton
                      value={stringifyDiagnosticPayload(
                        selectedJobPayload?.jobId === selectedJobView.id ? selectedJobPayload.value : selectedJobView.payload,
                        t,
                      )}
                      label={t("job.copyPayload")}
                    />
                  </div>
                )}
                {selectedJobPayloadError ? (
                  <div className="flex flex-col items-start gap-2 rounded-sm border border-bad-edge bg-bad-bg p-3 text-sm text-bad">
                    <span>{t("job.payloadLoadFailed")}</span>
                    <Button variant="secondary" size="sm" onClick={retrySelectedJobPayload}>
                      {t("common.retry")}
                    </Button>
                  </div>
                ) : (
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-2">
                    {selectedJobPayloadLoading
                      ? t("loading.payload")
                      : diagnosticPayloadPreview(
                          stringifyDiagnosticPayload(
                            selectedJobPayload?.jobId === selectedJobView.id ? selectedJobPayload.value : selectedJobView.payload,
                            t,
                          ),
                          t,
                        )}
                  </pre>
                )}
              </div>
            </details>
          </div>
        )}
      </Modal>

      {/* ── Certify printer ───────────────────────────────────────── */}
      <Modal
        open={certifyPrinter !== null}
        onClose={() => setCertifyPrinter(null)}
        title={certifyPrinter ? `${t("printer.certify")} ${certifyPrinter.name}` : t("printer.certification")}
        description={t("printer.certifyDescription")}
        wide
        footer={
          <Button variant="secondary" onClick={() => setCertifyPrinter(null)}>
            {t("common.close")}
          </Button>
        }
      >
        {certifyPrinter && (
          <PrintCertificationWizard printerId={certifyPrinter.id} />
        )}
      </Modal>

      {/* ── Reprint confirmation ──────────────────────────────────── */}
      <Modal
        open={reprintCandidate !== null}
        onClose={() => setReprintCandidate(null)}
        title={t("job.reprintTitle")}
        description={t("job.reprintBody")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReprintCandidate(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void confirmReprint()}
              disabled={busy}
              loading={busy}
              icon={<RotateCcw className="h-4 w-4" />}
            >
              {t("job.reprintConfirmAction")}
            </Button>
          </>
        }
      >
        {reprintCandidate && (
          <div className="space-y-4">
            <KeyValueList
              rows={[
                { label: t("job.job"), value: <span className="font-mono text-xs">{reprintCandidate.id}</span> },
                { label: t("job.printer"), value: reprintCandidate.printerName ?? printerById.get(reprintCandidate.printerId)?.name ?? reprintCandidate.printerId },
                { label: t("job.document"), value: reprintCandidate.destination ?? "—" },
                { label: t("job.originalResult"), value: jobLabel(reprintCandidate.status, deriveOutcome(reprintCandidate.status, reprintCandidate.error), locale) },
              ]}
            />
            {deriveOutcome(reprintCandidate.status, reprintCandidate.error) === "unknown" && (
              <Callout tone="warn" title={t("job.reprintConfirmLabel")}>
                {t("job.reprintClearPrinter")}
              </Callout>
            )}
            <Callout tone="info">{t("job.reprintCreditsNote")}</Callout>
          </div>
        )}
      </Modal>

      {/* ── Agent lifecycle confirmation ──────────────────────────── */}
      <Modal
        open={pendingAgentAction !== null}
        onClose={() => setPendingAgentAction(null)}
        title={pendingAgentAction?.next === "retired" ? t("agent.retireTitle") : t("agent.disableTitle")}
        description={pendingAgentAction?.agent.name}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingAgentAction(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={pendingAgentAction?.next === "retired" ? "danger" : "primary"}
              onClick={() => void confirmAgentAction()}
              disabled={busy}
              loading={busy}
            >
              {pendingAgentAction?.next === "retired" ? t("agent.retireConfirm") : t("agent.disableConfirm")}
            </Button>
          </>
        }
      >
        {pendingAgentAction?.next === "disabled" ? (
          <div className="space-y-4">
            <Callout tone="warn" title={t("agent.retireEffect")}>
              {t("agent.disablePrintersStop", {
                printers: tc("printer.count", pendingAgentAction.agent.printerCount ?? 0),
              })}
            </Callout>
            <p className="text-sm leading-relaxed text-ink-2">{t("agent.disableReEnable")}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <Callout tone="bad" title={t("agent.retireAudit")}>
              {t("agent.retireHistory")}
            </Callout>
            <p className="text-sm leading-relaxed text-ink-2">{t("agent.retireAdvice")}</p>
          </div>
        )}
      </Modal>

      {/* ── Delete agent ──────────────────────────────────────────── */}
      <Modal
        open={agentToDelete !== null}
        onClose={() => setAgentToDelete(null)}
        title={t("agent.deleteTitle")}
        description={agentToDelete?.name}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAgentToDelete(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                if (!agentToDelete) return;
                const id = agentToDelete.id;
                const result = await runAction(() => deleteAgent(id), t("success.agentDeleted"));
                if (result) setAgentToDelete(null);
              }}
              disabled={busy}
              icon={<Trash2 className="h-4 w-4" />}
            >
              {t("agent.deleteConfirm")}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm text-ink-2">
          {message?.type === "err" && <Callout tone="bad" title={t("errors.operationFailed")}>{message.text}</Callout>}
          <Callout tone="bad" title={t("common.cannotUndo")}>
            {t("agent.deleteRequiresOffline")}
          </Callout>
          <p>
            {t("agent.deleteQuestionPrefix")} <strong className="font-[600] text-ink">{agentToDelete?.name}</strong>{" "}
            <Mono>{agentToDelete?.id}</Mono>{t("agent.deleteQuestionSuffix")}
          </p>
        </div>
      </Modal>

      {/* ── Upgrade limit ─────────────────────────────────────────── */}
      <UpgradeLimitDialog
        open={upgradeLimit !== null}
        onClose={() => setUpgradeLimit(null)}
        resource={upgradeLimit?.resource ?? "agents"}
        used={upgradeLimit?.used ?? null}
        limit={upgradeLimit?.limit ?? null}
        periodEnd={upgradeLimit?.periodEnd ?? null}
        retryAfterSeconds={upgradeLimit?.retryAfterSeconds ?? null}
      />
    </div>
  );
}
