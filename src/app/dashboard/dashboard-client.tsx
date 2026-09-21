"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  createAgent,
  deleteAgent,
  getDashboardJobs,
  getDashboardState,
  reprintJob,
  setAgentLifecycle,
  setPrinterLifecycle,
} from "../actions";
import {
  Activity,
  Check,
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
  Clock,
  AlertTriangle,
  RotateCcw,
  Eye,
  Trash2,
  Cpu,
  Zap,
  ShieldCheck,
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  StatCard,
  Input,
  Select,
  StatusBadge,
  Mono,
  Drawer,
  Modal,
  CopyButton,
} from "../../components/ui";
import {
  agentLiveView,
  deriveOutcome,
  jobGuidance,
  jobLabel,
  jobTone as sharedJobTone,
  printerLabel,
  printerTone as sharedPrinterTone,
  effectivePrinterStatus,
} from "../../shared/job-vocabulary";
import { copyTextToClipboard } from "../../lib/clipboard";
import { generateIdempotencyKey } from "../../lib/idempotency";
import PrinterCapabilityMatrix from "../../components/PrinterCapabilityMatrix";
import AgentHealthMatrix from "../../components/AgentHealthMatrix";
import PrintCertificationWizard from "../../components/PrintCertificationWizard";
import JobTimeline from "../../components/JobTimeline";

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
  metadata?: unknown;
};

export type Printer = {
  id: string;
  agentId: string;
  name: string;
  printerType: string;
  deviceClass?: string | null;
  connectionType: string;
  protocol?: string | null;
  lifecycle: string;
  status: string;
  config?: unknown;
  capabilities?: unknown;
  lastSeenAt?: Date | null;
};

export type Job = {
  id: string;
  agentId: string;
  printerId: string;
  status: string;
  destination?: string | null;
  documentType?: string | null;
  error?: string | null;
  payload?: unknown;
  retries?: number;
  deliveryAttempts?: number;
  claimedAt?: Date | null;
  deliveredAt?: Date | null;
  ackedAt?: Date | null;
  createdAt: Date;
  updatedAt?: Date | null;
};

function formatRelativeTime(dateInput: Date | string | null | undefined): string {
  if (!dateInput) return "Never";
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return "Unknown";
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 10) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

const MAX_DIAGNOSTIC_PREVIEW_CHARS = 64 * 1024;

function stringifyDiagnosticPayload(payload: unknown): string {
  if (payload === undefined) return "Loading payload…";
  if (payload === null) return "No payload stored.";
  try {
    return JSON.stringify(payload, null, 2) || "No payload stored.";
  } catch {
    return "Payload could not be rendered.";
  }
}

function diagnosticPayloadPreview(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_PREVIEW_CHARS) return text;
  return text.slice(0, MAX_DIAGNOSTIC_PREVIEW_CHARS) +
    "\n\n… Preview truncated at 64 KiB. Use Copy Payload for the complete diagnostic payload.";
}

function formatCountdown(expiresAt: Date | string | null | undefined): { text: string; expired: boolean } {
  if (!expiresAt) return { text: "10:00", expired: false };
  const exp = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const now = new Date();
  const diffMs = exp.getTime() - now.getTime();
  if (diffMs <= 0) return { text: "Expired", expired: true };
  const min = Math.floor(diffMs / 60000);
  const sec = Math.floor((diffMs % 60000) / 1000);
  return {
    text: `${min}:${sec.toString().padStart(2, "0")}`,
    expired: false,
  };
}

async function sendGatewayTestPage(printerId: string): Promise<{ jobId?: string; status?: string }> {
  const response = await fetch(`/api/printers/${encodeURIComponent(printerId)}/test-print`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": generateIdempotencyKey(),
    },
    credentials: "same-origin",
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const obj = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const code = typeof obj.code === "string" ? obj.code : "";
    const message = typeof obj.error === "string" ? obj.error : `Test page request failed (HTTP ${response.status}).`;
    throw new Error(code ? `${code}: ${message}` : message);
  }
  const obj = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return {
    jobId: typeof obj.jobId === "string" ? obj.jobId : undefined,
    status: typeof obj.status === "string" ? obj.status : undefined,
  };
}

export default function DashboardClient({
  initialAgents,
  initialPrinters,
  initialJobs,
  databaseError,
}: {
  initialAgents: Agent[];
  initialPrinters: Printer[];
  initialJobs: Job[];
  databaseError: string | null;
}) {
  const [agents, setAgents] = useState<Agent[]>(initialAgents);
  const [printers, setPrinters] = useState<Printer[]>(initialPrinters);
  const [kpiJobs, setKpiJobs] = useState<Job[]>(initialJobs);
  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [jobsLoading, setJobsLoading] = useState(false);
  const router = useRouter();

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

  const [agentName, setAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [activePairing, setActivePairing] = useState<{ id?: string; code: string; expiresAt: Date } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [countdownText, setCountdownText] = useState("10:00");
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
  const [pendingAgentAction, setPendingAgentAction] = useState<{ agent: Agent; next: "disabled" | "retired" } | null>(null);
  const [reprintCandidate, setReprintCandidate] = useState<Job | null>(null);

  const [printerViewMode, setPrinterViewMode] = useState<"grid" | "table">("grid");
  const [printerSearch, setPrinterSearch] = useState("");
  const [printerStatusFilter, setPrinterStatusFilter] = useState<string>("all");

  const [jobSearch, setJobSearch] = useState("");
  const [debouncedJobSearch, setDebouncedJobSearch] = useState("");
  const [jobStatusFilter, setJobStatusFilter] = useState<string>("all");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedJobPayload, setSelectedJobPayload] = useState<unknown>(undefined);
  const selectedJobPayloadLoading =
    selectedJob !== null && selectedJob.payload === undefined && selectedJobPayload === undefined;

  useEffect(() => {
    if (!selectedJob || selectedJob.payload !== undefined) return;
    let cancelled = false;
    void fetch(`/api/jobs/${encodeURIComponent(selectedJob.id)}`, { credentials: "include", cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setSelectedJobPayload(null);
          return;
        }
        const row = (await res.json()) as { payload?: unknown };
        setSelectedJobPayload(row?.payload ?? null);
      })
      .catch(() => {
        if (!cancelled) setSelectedJobPayload(null);
      });
    return () => {
      cancelled = true;
      setSelectedJobPayload(undefined);
    };
  }, [selectedJob?.id]);

  const filterRef = React.useRef({ status: "all", search: "" });
  useEffect(() => {
    filterRef.current = { status: jobStatusFilter, search: debouncedJobSearch };
  }, [jobStatusFilter, debouncedJobSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedJobSearch(jobSearch), 250);
    return () => clearTimeout(timer);
  }, [jobSearch]);

  useEffect(() => {
    let cancelled = false;
    async function loadFilteredJobs() {
      setJobsLoading(true);
      try {
        const res = await getDashboardJobs({
          status: jobStatusFilter,
          search: debouncedJobSearch,
          limit: 100,
        });
        if (!cancelled) {
          setJobs(res as unknown as Job[]);
        }
      } catch (err) {
        console.error("Dashboard jobs query failed:", err);
      } finally {
        if (!cancelled) {
          setJobsLoading(false);
        }
      }
    }
    void loadFilteredJobs();
    return () => {
      cancelled = true;
    };
  }, [jobStatusFilter, debouncedJobSearch]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const refreshData = React.useCallback(async () => {
    try {
      const data = await getDashboardState();
      if (data) {
        setAgents(data.agents as Agent[]);
        setPrinters(data.printers as Printer[]);
        setKpiJobs(data.jobs as Job[]);

        const current = filterRef.current;
        if (current.status === "all" && !current.search) {
          setJobs(data.jobs as Job[]);
        } else {
          void getDashboardJobs({
            status: current.status,
            search: current.search,
            limit: 100,
          }).then((res) => {
            setJobs(res as unknown as Job[]);
          });
        }

        setActivePairing((currentPairing) => {
          if (!currentPairing) return null;
          const target = data.agents.find(
            (a) =>
              (currentPairing.id && a.id === currentPairing.id) ||
              a.pairingCode === currentPairing.code
          );
          if (
            target &&
            (target.status === "online" ||
              target.lastSeenAt !== null ||
              target.pairingCodeExpiresAt === null)
          ) {
            setMessage({
              text: `Agent ${target.name} paired successfully and is now online.`,
              type: "ok",
            });
            return null;
          }
          return currentPairing;
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("session has expired")) {
        router.push("/login");
      }
    }
  }, [router]);

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
      const { text, expired } = formatCountdown(activePairing.expiresAt);
      setCountdownText(text);
      if (expired) {
        clearInterval(interval);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [activePairing]);

  const kpis = useMemo(() => {
    const totalAgents = agents.length;
    const onlineAgents = agents.filter((a) => agentLiveView(a, nowMs).tone === "ok").length;

    const totalPrinters = printers.length;
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    const onlinePrinters = printers.filter((p) => {
      const parentAgent = agentMap.get(p.agentId);
      return effectivePrinterStatus(p, parentAgent, nowMs) === "online";
    }).length;

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
    const successRate =
      kpiJobs.length > 0 ? Math.round((completedJobs / kpiJobs.length) * 100) : null;

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
  }, [agents, printers, kpiJobs, nowMs]);

  const runAction = async (operation: () => Promise<unknown>, successMsg?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await operation();
      if (successMsg) setMessage({ text: successMsg, type: "ok" });
      void refreshData();
      return result;
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Operation failed. Try again, and check the Gateway logs if it persists.",
        type: "err",
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const handleGatewayTestPrint = async (printerId: string, printerName: string) => {
    setTestingPrinterId(printerId);
    setMessage(null);
    try {
      await sendGatewayTestPage(printerId);
      setMessage({
        text: `Test page submitted for ${printerName}. Track its delivery in Recent Print Jobs.`,
        type: "ok",
      });
      void refreshData();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Test page failed. Check the agent and printer status.",
        type: "err",
      });
    } finally {
      setTestingPrinterId(null);
    }
  };

  const confirmAgentAction = async () => {
    if (!pendingAgentAction) return;
    const { agent, next } = pendingAgentAction;
    setPendingAgentAction(null);
    const result = await runAction(() => setAgentLifecycle(agent.id, next));
    if (result && next === "disabled") {
      setMessage({
        text: `Agent ${agent.name} disabled: its credentials were revoked and its ${agent.printerCount} printer(s) no longer receive jobs. Re-enabling requires pairing it again with a new code.`,
        type: "ok",
      });
    }
    if (result && next === "retired") {
      setMessage({ text: `Agent ${agent.name} retired. It is kept for audit history and cannot receive jobs.`, type: "ok" });
    }
  };

  const handleCreateAgent = async (name: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await createAgent(name);
      const expiresAt = result.expiresAt ? new Date(result.expiresAt) : (result.expires_at ? new Date(result.expires_at) : new Date(Date.now() + 1000 * 60 * 10));
      setActivePairing({ id: result.id, code: result.pairingCode, expiresAt });
      setAgentName("");
      setMessage({
        text: `Agent registered! Use pairing code ${result.pairingCode} before expiration.`,
        type: "ok",
      });
      void refreshData();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Agent registration failed",
        type: "err",
      });
    } finally {
      setBusy(false);
    }
  };

  const copyPairingCode = async (code: string) => {
    if (await copyTextToClipboard(code)) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } else {
      setMessage({ text: "Please copy the code manually.", type: "err" });
    }
  };

  const filteredPrinters = useMemo(() => {
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    return printers.filter((p) => {
      const parentAgent = agentMap.get(p.agentId);
      const effStatus = effectivePrinterStatus(p, parentAgent, nowMs).toLowerCase();
      if (printerStatusFilter !== "all" && effStatus !== printerStatusFilter) {
        return false;
      }
      if (printerSearch.trim()) {
        const q = printerSearch.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.connectionType.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [printers, agents, nowMs, printerStatusFilter, printerSearch]);

  const filteredJobs = useMemo(() => {
    if (!jobSearch.trim()) return jobs;
    const q = jobSearch.toLowerCase();
    return jobs.filter((j) => {
      return (
        j.id.toLowerCase().includes(q) ||
        j.printerId.toLowerCase().includes(q) ||
        (j.destination && j.destination.toLowerCase().includes(q)) ||
        (j.documentType && j.documentType.toLowerCase().includes(q))
      );
    });
  }, [jobs, jobSearch]);

  const getPrinterBadges = (printer: Printer) => {
    const badges: Array<{ label: string }> = [];
    const cls = (printer.deviceClass || "").toLowerCase();
    const conn = (printer.connectionType || "").toLowerCase();
    const proto = (printer.protocol || "").toLowerCase();

    if (cls === "thermal" || proto === "escpos") badges.push({ label: "ESC/POS" });
    if (cls === "label") badges.push({ label: "ZPL / TSPL" });
    if (conn === "spooler" || cls === "laser" || proto === "ipp") badges.push({ label: "PDF / Spooler" });
    return badges;
  };

  const getConnectionIcon = (connectionType: string) => {
    const c = connectionType.toLowerCase();
    if (c === "usb") return <Usb className="h-4 w-4 text-ink-3" aria-hidden="true" />;
    if (c === "network" || c === "tcp") return <Wifi className="h-4 w-4 text-ink-3" aria-hidden="true" />;
    return <Layers className="h-4 w-4 text-ink-3" aria-hidden="true" />;
  };

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
      {/* Header — operational context */}
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-[24px] font-bold tracking-[-0.02em] leading-tight text-ink">Operations</h1>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${databaseError ? "border-bad-edge bg-bad-bg text-bad" : "border-edge bg-surface text-ink-2"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${databaseError ? "bg-bad-solid" : "bg-ok-solid animate-pulse"}`} />
              {databaseError ? "Database unavailable" : "Live"}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">
            Runtime agents, printer fleet, and job execution — business context stays in Odoo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void refreshData()} icon={<RefreshCw className="h-4 w-4" />}>
            Refresh
          </Button>
          <div className="hidden h-6 w-px bg-edge sm:block" />
          <div className="hidden items-center gap-2 text-[12px] text-ink-3 sm:flex">
            <Clock className="h-3.5 w-3.5" />
            <span>Auto-refresh every 6s</span>
          </div>
        </div>
      </header>

      {/* KPI Layer — financial clarity + operational */}
      <section aria-label="Metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Agents"
          value={`${kpis.onlineAgents} / ${kpis.totalAgents}`}
          subtitle={`${kpis.onlineAgents} online • ${kpis.totalAgents - kpis.onlineAgents} offline`}
          icon={<Cpu className="h-5 w-5 text-brand" />}
          tone={kpis.onlineAgents > 0 ? "ok" : "warn"}
        />
        <StatCard
          title="Printers"
          value={`${kpis.onlinePrinters} / ${kpis.totalPrinters}`}
          subtitle={kpis.onlinePrinters === kpis.totalPrinters ? "All ready" : `${kpis.totalPrinters - kpis.onlinePrinters} need attention`}
          icon={<PrinterIcon className="h-5 w-5 text-brand" />}
          tone={kpis.onlinePrinters > 0 ? (kpis.onlinePrinters === kpis.totalPrinters ? "ok" : "warn") : "neutral"}
        />
        <StatCard
          title="In Flight"
          value={kpis.inFlightJobs}
          subtitle="Queued, claimed, printing"
          icon={<Zap className="h-5 w-5 text-info" />}
          tone="info"
        />
        <StatCard
          title="Success Rate"
          value={kpis.successRate === null ? "—" : `${kpis.successRate}%`}
          subtitle={
            kpiJobs.length === 0
              ? "No jobs yet"
              : kpis.attentionJobs > 0
                ? `${kpis.attentionJobs} unknown — verify printer`
                : kpis.failedJobs > 0
                  ? `${kpis.failedJobs} failed pre-dispatch`
                  : "All accounted for"
          }
          icon={<ShieldCheck className="h-5 w-5 text-ok" />}
          tone={kpis.successRate === null || kpis.attentionJobs > 0 ? (kpis.successRate === null ? "neutral" : "warn") : kpis.successRate >= 90 ? "ok" : "warn"}
        />
      </section>

      {message && (
        <div
          role={message.type === "ok" ? "status" : "alert"}
          className={`flex items-start justify-between gap-3 rounded-[12px] border px-4 py-3 text-[13px] shadow-card ${
            message.type === "ok" ? "border-ok-edge bg-ok-bg text-ok" : "border-bad-edge bg-bad-bg text-bad"
          }`}
        >
          <div className="flex items-start gap-2.5">
            {message.type === "ok" ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="leading-relaxed">{message.text}</span>
          </div>
          <button onClick={() => setMessage(null)} className="shrink-0 text-[12px] font-semibold underline opacity-80 hover:opacity-100">
            Dismiss
          </button>
        </div>
      )}

      {activePairing && (
        <div className="relative overflow-hidden rounded-[16px] border border-edge-accent bg-gradient-to-br from-white to-[#f8fbff] p-6 shadow-[0_4px_24px_rgba(37,99,235,0.08)]">
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-brand via-brand-400 to-transparent opacity-80" />
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full bg-brand-subtle border border-edge-accent px-2.5 py-1 text-[11px] font-semibold tracking-wide text-brand">
                <span className="h-1.5 w-1.5 rounded-full bg-brand animate-pulse" />
                PAIRING ACTIVE
              </div>
              <h3 className="mt-3 text-[18px] font-bold tracking-tight text-ink">Ready to pair edge agent</h3>
              <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink-3">
                Enter this code in the Windows Agent or Odoo pairing wizard. It expires automatically — the agent must connect before timeout.
              </p>
            </div>
            <div className="flex flex-col gap-2.5 lg:items-end">
              <div className="flex items-center gap-3">
                <div className="rounded-[12px] border border-edge bg-surface px-5 py-3 shadow-inner">
                  <span className="font-mono text-[28px] font-bold tracking-[0.32em] text-brand leading-none">
                    {activePairing.code}
                  </span>
                </div>
                <Button variant="primary" onClick={() => copyPairingCode(activePairing.code)} icon={copiedCode ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
                  {copiedCode ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
                <Clock className="h-3.5 w-3.5 text-warn" />
                Expires in <span className="font-semibold text-ink tabular-nums">{countdownText}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main workspace */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Agents */}
        <Card className="lg:col-span-4 flex flex-col overflow-hidden">
          <CardHeader
            title="Runtime Agents"
            subtitle={`${kpis.onlineAgents} online of ${kpis.totalAgents}`}
            icon={<Cpu className="h-4 w-4 text-brand" />}
            actions={
              <Button variant="ghost" size="sm" onClick={() => void refreshData()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                Refresh
              </Button>
            }
          />
          <div className="flex-1 space-y-4 px-5 pb-5">
            <form
              className="rounded-[12px] border border-edge bg-surface-2 p-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!agentName.trim()) return;
                void handleCreateAgent(agentName.trim());
              }}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Register new agent</div>
              <div className="mt-2.5 flex gap-2">
                <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. Warehouse-PC-01" disabled={busy || databaseError !== null} required maxLength={200} className="h-9" />
                <Button type="submit" variant="primary" size="sm" disabled={busy || !agentName.trim() || databaseError !== null} icon={<Plus className="h-4 w-4" />}>
                  Pair
                </Button>
              </div>
            </form>

            <div className="space-y-2.5">
              {agents.length === 0 ? (
                <div className="rounded-[12px] border border-dashed border-edge p-8 text-center">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-2 text-ink-3">
                    <Cpu className="h-5 w-5" />
                  </div>
                  <div className="mt-3 text-[13px] font-medium text-ink">No agents yet</div>
                  <div className="mt-1 text-[12px] text-ink-3">Register your first edge machine to start printing.</div>
                </div>
              ) : (
                agents.map((agent) => {
                  const meta = agent.metadata as { hostname?: string; os?: string } | undefined;
                  const view = agentLiveView(agent);
                  return (
                    <div key={agent.id} className="group rounded-[12px] border border-edge bg-surface p-4 transition-all hover:border-edge-strong hover:shadow-card">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">{agent.name}</div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-3">
                            <Mono className="truncate">{agent.id.slice(0, 12)}…</Mono>
                            {meta?.os && <span>• {meta.os}</span>}
                          </div>
                        </div>
                        <StatusBadge label={view.label} tone={view.tone} pulse={view.tone === "ok"} />
                      </div>
                      <div className="mt-3 flex items-center justify-between border-t border-edge-subtle pt-3 text-[11px] text-ink-3">
                        <span className="inline-flex items-center gap-1"><PrinterIcon className="h-3 w-3" /> {agent.printerCount} printers</span>
                        <span>{formatRelativeTime(agent.lastSeenAt)}</span>
                      </div>
                      <div className="mt-3 flex items-center gap-1.5">
                        {agent.lifecycle === "active" ? (
                          <Button size="sm" variant="secondary" onClick={() => setPendingAgentAction({ agent, next: "disabled" })} disabled={busy} icon={<PauseCircle className="h-3.5 w-3.5" />}>
                            Disable
                          </Button>
                        ) : agent.lifecycle === "disabled" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={async () => {
                              const result = (await runAction(() => setAgentLifecycle(agent.id, "active"))) as { pairingCode?: string | null } | undefined;
                              if (result?.pairingCode) {
                                setActivePairing({ code: result.pairingCode, expiresAt: new Date(Date.now() + 1000 * 60 * 10) });
                                setMessage({
                                  text: `Agent ${agent.name} re-enabled. Pair it within 10 minutes using the code below.`,
                                  type: "ok",
                                });
                              }
                            }}
                            disabled={busy}
                            icon={<PlayCircle className="h-3.5 w-3.5" />}
                          >
                            Re-enable
                          </Button>
                        ) : null}
                        {agent.lifecycle !== "retired" && (
                          <Button size="sm" variant="ghost" onClick={() => setPendingAgentAction({ agent, next: "retired" })} disabled={busy}>
                            Retire
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="ml-auto text-bad hover:bg-bad-bg hover:text-bad" onClick={() => setAgentToDelete(agent)} disabled={busy} icon={<Trash2 className="h-3.5 w-3.5" />}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Card>

        {/* Printers */}
        <Card className="lg:col-span-8 flex flex-col overflow-hidden">
          <CardHeader
            title="Runtime Printers"
            subtitle={`${kpis.onlinePrinters} online • ${filteredPrinters.length} shown`}
            icon={<PrinterIcon className="h-4 w-4 text-brand" />}
            actions={
              <div className="flex items-center gap-1 rounded-[10px] border border-edge bg-surface-2 p-0.5">
                <button type="button" aria-pressed={printerViewMode === "grid"} onClick={() => setPrinterViewMode("grid")} className={`rounded-[7px] p-1.5 transition ${printerViewMode === "grid" ? "bg-surface text-brand shadow-xs" : "text-ink-3 hover:text-ink"}`}>
                  <LayoutGrid className="h-4 w-4" />
                </button>
                <button type="button" aria-pressed={printerViewMode === "table"} onClick={() => setPrinterViewMode("table")} className={`rounded-[7px] p-1.5 transition ${printerViewMode === "table" ? "bg-surface text-brand shadow-xs" : "text-ink-3 hover:text-ink"}`}>
                  <List className="h-4 w-4" />
                </button>
              </div>
            }
          />
          <div className="flex-1 space-y-4 px-5 pb-5">
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
                <Input className="pl-9 h-9" placeholder="Search printers…" value={printerSearch} onChange={(e) => setPrinterSearch(e.target.value)} />
              </div>
              <Select value={printerStatusFilter} onChange={(e) => setPrinterStatusFilter(e.target.value)} className="sm:w-[148px]">
                <option value="all">All status</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="busy">Busy</option>
              </Select>
            </div>

            {filteredPrinters.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-edge p-10 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-2 text-ink-3">
                  <PrinterIcon className="h-5 w-5" />
                </div>
                <div className="mt-3 text-[13px] text-ink-3">No printers match. Check agent connectivity.</div>
              </div>
            ) : printerViewMode === "grid" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {filteredPrinters.map((printer) => {
                  const caps = getPrinterBadges(printer);
                  const parentAgent = agents.find((a) => a.id === printer.agentId);
                  const effStatus = effectivePrinterStatus(printer, parentAgent, nowMs);
                  return (
                    <div key={printer.id} className="group flex flex-col justify-between rounded-[12px] border border-edge bg-surface p-4 transition-all hover:border-edge-strong hover:shadow-card">
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-[14px] font-semibold text-ink">{printer.name}</div>
                            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-3">
                              {getConnectionIcon(printer.connectionType)}
                              <span className="capitalize">{printer.connectionType}</span>
                              <span>•</span>
                              <Mono className="truncate">{printer.id.slice(0, 10)}</Mono>
                            </div>
                          </div>
                          <StatusBadge label={printerLabel(effStatus)} tone={sharedPrinterTone(effStatus)} />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1">
                          {caps.map((c, i) => (
                            <span key={i} className="rounded-[6px] border border-edge bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-2">{c.label}</span>
                          ))}
                        </div>
                      </div>
                      <div className="mt-4 flex items-center justify-between border-t border-edge-subtle pt-3">
                        <Button size="sm" variant="secondary" onClick={() => void handleGatewayTestPrint(printer.id, printer.name)} loading={testingPrinterId === printer.id} disabled={busy || testingPrinterId !== null || printer.lifecycle !== "active"} icon={<PlayCircle className="h-3.5 w-3.5" />}>
                          {testingPrinterId === printer.id ? "Sending…" : "Send Test Page"}
                        </Button>
                        {printer.lifecycle === "active" ? (
                          <Button size="sm" variant="ghost" onClick={() => void runAction(() => setPrinterLifecycle(printer.id, "disabled"), "Printer disabled.")} disabled={busy}>
                            Disable
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => void runAction(() => setPrinterLifecycle(printer.id, "active"), "Printer enabled.")} disabled={busy}>
                            Enable
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-[12px] border border-edge">
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-edge bg-surface-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    <tr>
                      <th className="px-4 py-2.5">Printer</th>
                      <th className="px-4 py-2.5">Connection</th>
                      <th className="px-4 py-2.5">Caps</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {filteredPrinters.map((printer) => {
                      const caps = getPrinterBadges(printer);
                      const parentAgent = agents.find((a) => a.id === printer.agentId);
                      const effStatus = effectivePrinterStatus(printer, parentAgent, nowMs);
                      return (
                        <tr key={printer.id} className="hover:bg-surface-2/60 transition-colors">
                          <td className="px-4 py-3">
                            <div className="font-semibold text-ink text-[13px]">{printer.name}</div>
                            <Mono className="text-[11px]">{printer.id.slice(0, 16)}</Mono>
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1.5 capitalize text-ink-2">
                              {getConnectionIcon(printer.connectionType)} {printer.connectionType}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {caps.map((c, i) => (
                                <span key={i} className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold">{c.label}</span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3"><StatusBadge label={printerLabel(effStatus)} tone={sharedPrinterTone(effStatus)} /></td>
                          <td className="px-4 py-3 text-right">
                            <Button size="sm" variant="secondary" onClick={() => void handleGatewayTestPrint(printer.id, printer.name)} loading={testingPrinterId === printer.id} disabled={busy || testingPrinterId !== null || printer.lifecycle !== "active"}>
                              Test
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Jobs */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Recent Print Jobs"
          subtitle="Queue snapshot, execution tracking, diagnostics"
          icon={<Server className="h-4 w-4 text-brand" />}
          actions={<Button variant="secondary" size="sm" onClick={() => void refreshData()} icon={<RefreshCw className="h-3.5 w-3.5" />}>Refresh</Button>}
        />
        <div className="space-y-4 px-5 pb-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:w-[320px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input className="pl-9 h-9" placeholder="Search jobs…" value={jobSearch} onChange={(e) => setJobSearch(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {[
                { id: "all", label: "All" },
                { id: "active", label: "In Flight" },
                { id: "queued", label: "Queued" },
                { id: "success", label: "Printed" },
                { id: "failed", label: "Failed" },
                { id: "unknown", label: "Unknown" },
                { id: "expired", label: "Expired" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setJobStatusFilter(tab.id)}
                  className={`rounded-[9px] px-3 py-1.5 text-[12px] font-semibold transition ${jobStatusFilter === tab.id ? "bg-brand text-white shadow-sm" : "bg-surface-2 text-ink-3 hover:text-ink hover:bg-surface-3 border border-edge"}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {jobsLoading && filteredJobs.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-edge p-10 text-center text-[13px] text-ink-3">Loading jobs…</div>
          ) : filteredJobs.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-edge p-10 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] bg-surface-2 text-ink-3">
                <Server className="h-5 w-5" />
              </div>
              <div className="mt-3 text-[13px] text-ink-3">No jobs match filters.</div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-[12px] border border-edge">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 z-10 border-b border-edge bg-surface-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                  <tr>
                    <th className="px-4 py-2.5">Job</th>
                    <th className="px-4 py-2.5">Printer</th>
                    <th className="px-4 py-2.5">Document</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Created</th>
                    <th className="px-4 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {filteredJobs.map((job) => {
                    const outcome = deriveOutcome(job.status, job.error);
                    return (
                      <tr key={job.id} onClick={() => setSelectedJob(job)} tabIndex={0} className="cursor-pointer hover:bg-surface-2/60 transition-colors focus-visible:outline-none focus-visible:bg-surface-2">
                        <td className="px-4 py-3"><Mono>{job.id.slice(0, 12)}</Mono></td>
                        <td className="px-4 py-3"><Mono className="text-ink-2">{job.printerId.slice(0, 10)}</Mono></td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-ink text-[13px]">{job.destination || "Direct"}</div>
                          <div className="text-[11px] text-ink-3">{job.documentType || "—"}</div>
                        </td>
                        <td className="px-4 py-3"><StatusBadge label={jobLabel(job.status, outcome)} tone={sharedJobTone(job.status, outcome)} pulse={["printing","claimed"].includes(job.status.toLowerCase())} /></td>
                        <td className="px-4 py-3 text-[12px] text-ink-3">{formatRelativeTime(job.createdAt)}</td>
                        <td className="px-4 py-3 text-right">
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedJob(job); }} icon={<Eye className="h-3.5 w-3.5" />}>Inspect</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Drawer open={selectedJob !== null} onClose={() => setSelectedJob(null)} title={selectedJob ? `Job ${selectedJob.id.slice(0, 12)}` : "Job Details"} description="Runtime execution & diagnostics">
        {selectedJob && (() => {
          const outcome = deriveOutcome(selectedJob.status, selectedJob.error);
          const isTerminal = ["success", "failed", "expired"].includes(selectedJob.status.toLowerCase());
          return (
          <div className="space-y-5">
            <div className="flex items-center justify-between rounded-[12px] border border-edge bg-surface-2 p-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Current State</div>
                <div className="mt-1 text-[16px] font-bold text-ink">{jobLabel(selectedJob.status, outcome)}</div>
                {jobGuidance(selectedJob.status, outcome) && <p className="mt-1 max-w-md text-[12px] text-ink-3">{jobGuidance(selectedJob.status, outcome)}</p>}
              </div>
              <StatusBadge label={jobLabel(selectedJob.status, outcome)} tone={sharedJobTone(selectedJob.status, outcome)} pulse={["printing","claimed"].includes(selectedJob.status.toLowerCase())} />
            </div>

            {outcome === "unknown" && isTerminal && (
              <div className="rounded-[12px] border border-warn-edge bg-warn-bg p-4 space-y-3">
                <div className="flex items-start gap-2.5 text-warn">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <h4 className="text-[13px] font-bold">Outcome unknown — verify printer</h4>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-2">Paper may have printed. Automatic retry paused to avoid duplicates. Check tray before reprinting.</p>
                  </div>
                </div>
                <Button size="sm" variant="primary" onClick={() => setReprintCandidate(selectedJob)} disabled={busy} icon={<RotateCcw className="h-3.5 w-3.5" />}>Reprint…</Button>
              </div>
            )}

            {selectedJob.status.toLowerCase() === "failed" && outcome === "not_printed" && (
              <div className="rounded-[12px] border border-edge bg-surface-2 p-4 space-y-3">
                <p className="text-[12px] leading-relaxed text-ink-2">Failed before dispatch — safe to retry. Queues original document anew.</p>
                <Button size="sm" variant="secondary" onClick={() => setReprintCandidate(selectedJob)} disabled={busy} icon={<RotateCcw className="h-3.5 w-3.5" />}>Retry print…</Button>
              </div>
            )}

            {selectedJob.error && (
              <div className="rounded-[12px] border border-bad-edge bg-bad-bg p-4 space-y-1">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-bad"><AlertTriangle className="h-4 w-4" />Execution Error</div>
                <p className="text-[11px] leading-relaxed font-mono break-all text-ink-2">{selectedJob.error}</p>
              </div>
            )}

            <div className="rounded-[12px] border border-edge bg-surface divide-y divide-edge text-[12px]">
              <div className="flex justify-between p-3"><span className="text-ink-3">Printer</span><Mono>{selectedJob.printerId}</Mono></div>
              <div className="flex justify-between p-3"><span className="text-ink-3">Agent</span><Mono>{selectedJob.agentId}</Mono></div>
              <div className="flex justify-between p-3"><span className="text-ink-3">Document</span><span className="font-semibold text-ink">{selectedJob.destination || "Direct"} · {selectedJob.documentType || "Standard"}</span></div>
              <div className="flex justify-between p-3"><span className="text-ink-3">Retries</span><span className="font-semibold">{selectedJob.retries ?? 0}</span></div>
              <div className="flex justify-between p-3"><span className="text-ink-3">Created</span><span>{new Date(selectedJob.createdAt).toLocaleString()}</span></div>
              {selectedJob.deliveredAt && <div className="flex justify-between p-3"><span className="text-ink-3">Delivered</span><span>{new Date(selectedJob.deliveredAt).toLocaleString()}</span></div>}
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Job Timeline (Gateway→Spooler→Physical, claim redacted)</div>
              {selectedJob && <JobTimeline jobId={selectedJob.id} />}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Diagnostic Payload</span>
                <CopyButton value={(() => { const p = selectedJob.payload ?? selectedJobPayload; return p === undefined ? "" : stringifyDiagnosticPayload(p); })()} label="Copy" />
              </div>
              <div className="max-h-72 overflow-auto rounded-[12px] border border-edge bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink-2" aria-live="polite">
                {selectedJobPayloadLoading ? <span>Loading payload…</span> : <pre>{diagnosticPayloadPreview(stringifyDiagnosticPayload(selectedJob.payload ?? selectedJobPayload))}</pre>}
              </div>
            </div>
          </div>
          );
        })()}
      </Drawer>

      <Modal open={Boolean(reprintCandidate)} onClose={() => { if (!busy) setReprintCandidate(null); }} title="Reprint this document?" description="Sends ORIGINAL document again.">
        <div className="space-y-3 text-[13px] text-ink-2">
          <p>Printer: <strong className="text-ink">{reprintCandidate?.printerId}</strong> · Doc: {reprintCandidate?.documentType || "standard"}</p>
          {reprintCandidate && deriveOutcome(reprintCandidate.status, reprintCandidate.error) === "unknown" && (
            <div className="rounded-[10px] border border-warn-edge bg-warn-bg p-3 text-[12px]">Unknown outcome — duplicate possible. Check printer first.</div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setReprintCandidate(null)} disabled={busy}>Cancel</Button>
          <Button variant="danger" disabled={busy} loading={busy} onClick={async () => { const job = reprintCandidate; setReprintCandidate(null); if (!job) return; await runAction(() => reprintJob(job.id), `Reprint queued for ${job.printerId}`); }} icon={<RotateCcw className="h-4 w-4" />}>Reprint</Button>
        </div>
      </Modal>

      <Modal open={Boolean(pendingAgentAction)} onClose={() => { if (!busy) setPendingAgentAction(null); }} title={pendingAgentAction?.next === "retired" ? "Retire this agent?" : "Disable this agent?"} description={pendingAgentAction?.next === "retired" ? "Retirement is permanent, kept for audit." : "Disabling revokes credentials immediately."}>
        <div className="space-y-3 text-[13px] text-ink-2">
          {pendingAgentAction?.next === "disabled" ? (
            <ul className="list-disc pl-5 text-[12px] space-y-1">
              <li>Revokes secret — cannot reconnect.</li>
              <li>Disables its {pendingAgentAction.agent.printerCount} printer(s).</li>
              <li>Re-enabling needs fresh pairing code.</li>
            </ul>
          ) : (
            <p className="text-[12px]">Retiring <strong className="text-ink">{pendingAgentAction?.agent.name}</strong> keeps history for auditing. Cannot be re-activated.</p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPendingAgentAction(null)} disabled={busy}>Cancel</Button>
          <Button variant={pendingAgentAction?.next === "retired" ? "danger" : "primary"} disabled={busy} loading={busy} onClick={async () => { await confirmAgentAction(); }}>{pendingAgentAction?.next === "retired" ? "Retire agent" : "Disable agent"}</Button>
        </div>
      </Modal>

      {/* Enterprise Observability — P0 */}
      <Card className="overflow-hidden">
        <CardHeader title="Operations" subtitle="Agent status, printer readiness, and print certification" icon={<Server className="h-4 w-4 text-brand" />} />
        <div className="space-y-6 px-5 pb-5">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Agent Status</h3>
            <AgentHealthMatrix />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Printer Fleet</h3>
            <PrinterCapabilityMatrix />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Print Certification</h3>
            <p className="mb-2 text-[12px] text-ink-3">Run a real print-path certification for a selected printer.</p>
            <div className="grid gap-3 md:grid-cols-2">
              {printers.slice(0,4).map(p=>(
                <PrintCertificationWizard key={p.id} printerId={p.id} />
              ))}
              {printers.length===0 && <div className="text-xs text-ink-3">No printers to certify. Register an agent and printer first.</div>}
            </div>
          </div>
        </div>
      </Card>

      <Modal open={Boolean(agentToDelete)} onClose={() => { if (!busy) setAgentToDelete(null); }} title="Delete Agent" description="Permanently removes this agent from Gateway.">
        <div className="space-y-4 text-[13px] text-ink-2">
          <div className="rounded-[12px] border border-bad-edge bg-bad-bg p-4 text-[12px]">
            <div className="flex items-center gap-2 font-semibold text-bad"><AlertTriangle className="h-4 w-4" />Cannot be undone.</div>
            <p className="mt-2 text-ink-2">Agent must be offline. Historical records may require retiring instead.</p>
          </div>
          <p>Delete <strong className="text-ink">{agentToDelete?.name}</strong> (<Mono>{agentToDelete?.id}</Mono>)?</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAgentToDelete(null)} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={async () => { if (!agentToDelete) return; const id = agentToDelete.id; await runAction(() => deleteAgent(id), "Agent deleted."); setAgentToDelete(null); }} disabled={busy} loading={busy} icon={<Trash2 className="h-4 w-4" />}>Delete Agent</Button>
        </div>
      </Modal>
    </div>
  );
}
