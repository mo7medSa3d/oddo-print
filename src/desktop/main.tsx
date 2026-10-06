/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ClipboardList,
  Cpu,
  Info,
  LayoutDashboard,
  Menu,
  Printer as PrinterIcon,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  X,
  Play,
} from "lucide-react";
import {
  Button,
  Drawer,
  MetaRow,
  Modal,
  Mono,
  StatusBadge,
  StatusDot,
  Toast as ToastView,
} from "../components/ui";
import { ThemeToggle } from "../components/ThemeToggle";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { PageHeader } from "./ui";
import { JobTimeline } from "./components/JobTimeline";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { AddPrinterDialog } from "./components/AddPrinterDialog";
import { EditPrinterDialog } from "./components/EditPrinterDialog";
import { AdminPrivilegeDialog } from "./components/AdminPrivilegeDialog";
import { OverviewPage } from "./pages/Overview";
import { PrintersPage } from "./pages/Printers";
import { JobsPage } from "./pages/Jobs";
import { AgentsPage } from "./pages/Agents";
import { SettingsPage } from "./pages/Settings";
import {
  fetchGatewayHealth,
  fetchGatewayJobs,
  getAgentStatus,
  getAppVersion,
  getAutostart,
  isRunningAsAdmin,
  getGatewayUrl,
  getPrinters,
  fetchGatewayPrinters,
  updateGatewayPrinter,
  getRuntimePaths,
  isTauri,
  onTrayNavigate,
  onTrayRestartAgent,
  onGatewayConfigChanged,
  pairAgent,
  clearManagerSession,
  restartAgent as ipcRestartAgent,
  setGatewayUrl,
  startAgent as ipcStartAgent,
  stopAgent as ipcStopAgent,
  normalizeGatewayUrl,
  discoverPrinters,
  testGatewayPrinter,
  setAutostart,
  type PrinterInfo,
} from "./lib/ipc";
import {
  deriveOutcome,
  printerAgentView,
  errMsg,
  friendlyPrinterError,
  jobFailurePresentation,
  humanConnection,
  humanType,
  isProductionPrinter,
  jobDestination,
  jobDocType,
  jobGuidance,
  jobId,
  jobPrinterId,
  jobStatus,
  friendlyAgentError,
  friendlyGatewayError,
  labelJob,
  toneJob,
  labelPrinter,
  printerDisplayStatus,
  printerEndpoint,
  printerIsStale,
  printerTone,
  jobTimestamp,
} from "./lib/printers";
import type {
  AgentStatusView,
  DesktopState,
  JobRecord,
  JobTab,
  Page,
  PrinterStatusFilter,
  ToastMessage,
} from "./types";
import "../app/globals.css";
import { I18nProvider, useI18n } from "../i18n/react";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, resolveLocale, type Locale } from "../i18n/config";
/* Desktop Manager uses the shared light/dark theme tokens. */
import "./theme-light.css";

const PAGES: Page[] = ["dashboard", "printers", "jobs", "agents", "settings"];

function useHashPage(defaultPage: Page): [Page, (p: Page) => void] {
  const getHash = (): Page => {
    const h = window.location.hash.replace("#", "") as Page;
    return PAGES.includes(h) ? h : defaultPage;
  };
  const [page, setPage] = useState<Page>(() => getHash());
  useEffect(() => {
    const onHash = () => setPage(getHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((p: Page) => {
    window.location.hash = p;
    setPage(p);
  }, []);
  return [page, navigate];
}

/* ---------- App ---------- */

export default function App() {
  const { t, locale, formatDateTime } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [page, navigate] = useHashPage("dashboard");
  const [version, setVersion] = useState("");
  const [gatewayUrl, setGw] = useState("");
  // Keep the editable URL draft separate from the last successfully saved URL.
  // Network refresh effects must never be driven by keystrokes in Settings.
  const [savedGatewayUrl, setSavedGatewayUrl] = useState("");
  const savedOriginRef = useRef(savedGatewayUrl);
  useEffect(() => { savedOriginRef.current = savedGatewayUrl; }, [savedGatewayUrl]);
  const printersGeneration = useRef(0);
  const localPrintersGeneration = useRef(0);
  const jobsGeneration = useRef(0);
  const healthGeneration = useRef(0);
  const configurationFlight = useRef(false);
  const [pairCode, setPairCode] = useState("");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatusView | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<DesktopState["runtimePaths"]>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMessage>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [adminDismissed, setAdminDismissed] = useState<boolean>(false);
  const busyRef = useRef(false);
  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [discoveredPrinters, setDiscoveredPrinters] = useState<PrinterInfo[]>([]);
  const [discoveryWarning, setDiscoveryWarning] = useState<string | null>(null);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState<string | null>(null);
  const [printersFilter, setPrintersFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<PrinterStatusFilter>("all");
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobTab, setJobTab] = useState<JobTab>("all");
  const [jobSearch, setJobSearch] = useState("");
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [lastStatusCheck, setLastStatusCheck] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<PrinterInfo | null>(null);
  const [editingPrinter, setEditingPrinter] = useState<PrinterInfo | null>(null);
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [gatewayChecking, setGatewayChecking] = useState(false);
  const [checkedGatewayUrl, setCheckedGatewayUrl] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [jobPrinterFilter, setJobPrinterFilter] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!isTauri) return;
    try {
      const s = await getAgentStatus();
      setAgentStatus(s);
      setLastStatusCheck(new Date().toISOString());
    } catch (e) {
      setAgentStatus({ error: friendlyAgentError(errMsg(e), locale) });
    }
  }, [locale]);

  const refreshLocalPrinters = useCallback(async () => {
    if (!isTauri) return false;
    const generation = ++localPrintersGeneration.current;
    try {
      const list = await getPrinters();
      if (generation !== localPrintersGeneration.current) return false;
      setDiscoveredPrinters(list.filter(isProductionPrinter));
      return true;
    } catch {
      // Local inventory is supplementary to the Gateway view. Do not turn a
      // local registry read failure into a false remote printer outage.
      return false;
    }
  }, []);

  const refreshPrinters = useCallback(async () => {
    if (!savedGatewayUrl) {
      setPrintersError(t("desktop.app.gatewayUrlMissing"));
      return false;
    }
    const generation = ++printersGeneration.current;
    const current = () => generation === printersGeneration.current && savedOriginRef.current === savedGatewayUrl;
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      const list = await fetchGatewayPrinters(savedGatewayUrl);
      if (!current()) return false;
      setPrinters(list.filter(isProductionPrinter));
      return true;
    } catch (e) {
      if (!current()) return false;
      setPrintersError(friendlyPrinterError(errMsg(e), locale));
      return false;
    } finally {
      if (current()) setPrintersLoading(false);
    }
  }, [savedGatewayUrl, t, locale]);

  const refreshJobs = useCallback(async (options?: { status?: string; search?: string; limit?: number }) => {
    if (!savedGatewayUrl) return;
    const generation = ++jobsGeneration.current;
    const current = () => generation === jobsGeneration.current && savedOriginRef.current === savedGatewayUrl;
    setJobsLoading(true);
    try {
      const data = await fetchGatewayJobs(savedGatewayUrl, options);
      if (!current()) return;
      setJobs(Array.isArray(data) ? data : []);
      setJobsError(null);
    } catch (e: unknown) {
      if (!current()) return;
      setJobs([]);
      const status = Number((e as { status?: number })?.status ?? 0);
      setJobsError(
        status === 401 || status === 403
          ? t("desktop.app.gatewayJobAccessUnavailable")
          : friendlyGatewayError(errMsg(e), locale)
      );
    } finally {
      if (current()) setJobsLoading(false);
    }
  }, [savedGatewayUrl, t, locale]);

  const probeGateway = useCallback(async (targetUrl: string): Promise<boolean> => {
    const generation = ++healthGeneration.current;
    const current = () => generation === healthGeneration.current && savedOriginRef.current === targetUrl;
    try {
      const h = await fetchGatewayHealth(targetUrl);
      if (!current()) return false;
      setHealth(h);
      setCheckedGatewayUrl(targetUrl);
      const gatewayError = (h as { error?: unknown })?.error;
      if (gatewayError) {
        setHealthError(friendlyGatewayError(errMsg(gatewayError), locale));
        return false;
      }
      setHealthError(null);
      return true;
    } catch (e) {
      if (!current()) return false;
      setHealth(null);
      setCheckedGatewayUrl(targetUrl);
      setHealthError(friendlyGatewayError(errMsg(e), locale));
      return false;
    }
  }, [locale]);

  const checkHealth = useCallback(async () => {
    // Check the operator's current draft, not the last persisted origin.
    // The candidate is persisted immediately before probing so the Tauri
    // request uses exactly this normalized URL, with rollback on failure.
    const raw = gatewayUrl.trim();
    if (!raw) {
      setHealth(null);
      setCheckedGatewayUrl("");
      setHealthError(t("desktop.app.gatewayUrlMissing"));
      return;
    }

    let target: string;
    try {
      target = normalizeGatewayUrl(raw);
    } catch (e) {
      setHealth(null);
      setCheckedGatewayUrl("");
      setHealthError(errMsg(e));
      return;
    }

    if (configurationFlight.current) return;
    configurationFlight.current = true;
    setGatewayChecking(true);
    setHealthError(null);

    // gateway_request is intentionally pinned to the persisted Gateway origin.
    // Persist the candidate before probing so the health request tests exactly
    // the URL the operator entered, then restore the previous origin on failure.
    // /api/health is public, so this pre-authentication check sends no manager
    // credential.
    const previousGatewayUrl = savedGatewayUrl;
    try {
      await setGatewayUrl(target);
      setGw(target);
      savedOriginRef.current = target;
      setSavedGatewayUrl(target);

      const reachable = await probeGateway(target);
      if (!reachable) {
        if (previousGatewayUrl && previousGatewayUrl !== target) {
          await setGatewayUrl(previousGatewayUrl);
          setGw(previousGatewayUrl);
          savedOriginRef.current = previousGatewayUrl;
          setSavedGatewayUrl(previousGatewayUrl);
        }
        return;
      }

      setMsg({ text: t("desktop.app.connectionVerified"), type: "success" });
    } catch (e) {
      try {
        if (previousGatewayUrl && previousGatewayUrl !== target) {
          await setGatewayUrl(previousGatewayUrl);
          setGw(previousGatewayUrl);
          savedOriginRef.current = previousGatewayUrl;
          setSavedGatewayUrl(previousGatewayUrl);
        }
      } catch {
        // Preserve the primary connection error if restoration also fails.
      }
      setMsg({ text: friendlyGatewayError(errMsg(e), locale), type: "error" });
    } finally {
      configurationFlight.current = false;
      setGatewayChecking(false);
    }
  }, [gatewayUrl, probeGateway, savedGatewayUrl, t, locale]);

  const handleDiscover = useCallback(async () => {
    if (!isTauri) return;
    setPrintersLoading(true);
    setPrintersError(null);
    setDiscoveryWarning(null);
    try {
      const res = await discoverPrinters();
      const list = res.printers.filter(isProductionPrinter);
      setDiscoveredPrinters(list);
      const warning = res.errors.length > 0 ? t("desktop.app.discoveryWarningsSummary", { count: res.errors.length }) : null;
      setDiscoveryWarning(warning);
      const refreshed = await refreshPrinters();
      setMsg({
        text: list.length === 0
          ? t("desktop.app.noPhysicalPrinters")
          : warning
            ? t("desktop.app.discoveryPartial", { count: list.length })
            : t("desktop.app.discoveryFound", { count: list.length }),
        type: warning || !refreshed ? "info" : list.length > 0 ? "success" : "info",
      });
    } catch (e) {
      setPrintersError(friendlyPrinterError(errMsg(e), locale));
    } finally {
      setPrintersLoading(false);
    }
  }, [refreshPrinters, t, locale]);

  const updatePrinterLifecycle = useCallback(async (id: string, lifecycle: "active" | "disabled" | "retired") => {
    if (!savedGatewayUrl) {
      setMsg({ text: t("desktop.app.gatewayUrlMissing"), type: "error" });
      return;
    }
    if (lifecycle === "retired" && !window.confirm(t("desktop.app.retireConfirmPrompt"))) return;
    try {
      setBusyBoth(true);
      await updateGatewayPrinter(savedGatewayUrl, id, { lifecycle });
      await refreshPrinters();
      setSelectedPrinter((current) => current?.id === id ? null : current);
      setMsg({ text: lifecycle === "disabled" ? t("desktop.app.printerDisabled") : lifecycle === "retired" ? t("desktop.app.printerRetired") : t("desktop.app.printerEnabled"), type: "success" });
    } catch (e) {
      setMsg({ text: friendlyPrinterError(errMsg(e), locale), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [savedGatewayUrl, refreshPrinters, setBusyBoth, t, locale]);

  const handleTest = useCallback(
    async (id: string) => {
      try {
        setBusyBoth(true);
        if (!savedGatewayUrl) {
          throw new Error(t("desktop.app.gatewayUrlMissing"));
        }
        const result = await testGatewayPrinter(savedGatewayUrl, id);
        const jobId = typeof result.jobId === "string" ? result.jobId : null;
        setMsg({
          text: jobId
            ? t("desktop.app.testQueuedWithJobs")
            : t("desktop.app.testQueued"),
          type: "success",
        });
        if (jobId) void refreshJobs();
      } catch (e) {
        setMsg({ text: friendlyPrinterError(errMsg(e), locale), type: "error" });
      } finally {
        setBusyBoth(false);
      }
    },
    [savedGatewayUrl, refreshJobs, setBusyBoth, t, locale]
  );

  const handleEditSaved = useCallback(async () => {
    setEditingPrinter(null);
    await refreshPrinters();
    setMsg({ text: t("desktop.app.printerConfigUpdated"), type: "success" });
  }, [refreshPrinters, t, locale]);



  const startAgent = useCallback(async () => {
    try {
      setBusyBoth(true);
      await ipcStartAgent();
      setMsg({ text: t("desktop.app.agentStarted"), type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth, t, locale]);

  const stopAgent = useCallback(async () => {
    setConfirmStop(false);
    try {
      setBusyBoth(true);
      await ipcStopAgent();
      setMsg({ text: t("desktop.app.agentStopped"), type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth, t, locale]);

  const restartAgent = useCallback(async () => {
    try {
      setBusyBoth(true);
      await ipcRestartAgent();
      setMsg({ text: t("desktop.app.agentRestarted"), type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth, t, locale]);

  const pair = useCallback(async () => {
    if (!pairCode.trim()) {
      setMsg({ text: t("desktop.app.enterPairingCode"), type: "error" });
      return;
    }
    if (!savedGatewayUrl) {
      setMsg({ text: t("desktop.app.setGatewayFirst"), type: "error" });
      return;
    }
    try {
      setBusyBoth(true);
      await pairAgent(pairCode.trim(), savedGatewayUrl);
      setMsg({ text: t("desktop.app.agentPaired"), type: "success" });
      setPairCode("");
      refreshStatus();
      await Promise.all([refreshPrinters(), refreshJobs()]);
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [pairCode, savedGatewayUrl, refreshJobs, refreshPrinters, refreshStatus, setBusyBoth, t, locale]);

  useEffect(() => {
    if (!isTauri) return;
    isRunningAsAdmin().then((admin) => setIsAdmin(admin));
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    getAppVersion()
      .then(setVersion)
      .catch(() => {});
    getGatewayUrl()
      .then((v) => {
        setGw(v);
        setSavedGatewayUrl(v);
      })
      .catch(() => {
        setMsg({ text: t("desktop.app.gatewaySettingsReadFailed"), type: "error" });
      });
    getRuntimePaths()
      .then(setRuntimePaths)
      .catch(() => {});
    getAutostart()
      .then((st) => setAutostartState(st.enabled))
      .catch(() => {});
    refreshStatus();
    void refreshLocalPrinters();
    const id = setInterval(refreshStatus, 30000);
    return () => clearInterval(id);
  }, [refreshStatus, refreshLocalPrinters, t]);

  useEffect(() => {
    if (!isTauri || !savedGatewayUrl) return;

    const raw = savedGatewayUrl.trim();
    if (!raw) {
      setHealth(null);
      setCheckedGatewayUrl("");
      setHealthError(null);
      return;
    }

    let target: string;
    try {
      target = normalizeGatewayUrl(raw);
    } catch {
      setHealth(null);
      setCheckedGatewayUrl("");
      setHealthError(null);
      return;
    }

    // Auto-probe only the already-persisted Gateway. A newly edited URL must
    // go through the explicit Check connection action, which persists the
    // candidate before the transport probe.
    if (target !== savedGatewayUrl) return;

    const timer = window.setTimeout(() => {
      void probeGateway(target);
    }, 450);

    return () => window.clearTimeout(timer);
  }, [savedGatewayUrl, probeGateway]);

  useEffect(() => {
    if (savedGatewayUrl) refreshPrinters();
  }, [savedGatewayUrl, refreshPrinters]);

  useEffect(() => {
    if (savedGatewayUrl) refreshJobs();
  }, [savedGatewayUrl, refreshJobs]);

  useEffect(() => {
    if (!isTauri) return;
    // Both tray subscriptions resolve asynchronously: capture the unlisten
    // functions and release them on disposal, otherwise every re-run would
    // stack another restart/navigate handler behind the same tray event.
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const track = (promise: Promise<() => void>) => {
      promise
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistens.push(unlisten);
        })
        .catch(() => {});
    };
    track(
      onTrayNavigate((anchor) => {
        const p = anchor.replace("#", "") as Page;
        if (PAGES.includes(p)) navigate(p);
      }),
    );
    track(onTrayRestartAgent(() => restartAgent()));
    return () => {
      disposed = true;
      unlistens.splice(0).forEach((unlisten) => unlisten());
    };
  }, [navigate, restartAgent]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onGatewayConfigChanged((url) => {
      // The manager session is a bearer credential for ONE gateway origin.
      // Switching gateways must not send the old JWT to the new origin:
      // drop it (and stale per-gateway caches) before probing the new URL.
      void clearManagerSession();
      savedOriginRef.current = url;
      ++printersGeneration.current; ++jobsGeneration.current; ++healthGeneration.current;
      setPrintersLoading(false); setJobsLoading(false);
      setPrintersError(null); setJobsError(null); setSelectedPrinter(null); setEditingPrinter(null); setSelectedJob(null); void refreshLocalPrinters();
      setSavedGatewayUrl(url);
      setGw(url);
      setJobs([]);
      setPrinters([]);
      if (url) {
        void probeGateway(url);
      } else {
        setHealth(null);
        setCheckedGatewayUrl("");
        setHealthError(t("desktop.app.gatewayUrlMissing"));
      }
      refreshStatus();
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = undefined;
    };
  }, [probeGateway, refreshStatus, refreshLocalPrinters, t]);

  const isOnline =
    !!agentStatus && !(agentStatus as Record<string, unknown>).error && (agentStatus as { running?: boolean }).running !== false;
  const healthOk = Boolean(health && (health as { ok?: boolean }).ok !== false && !healthError);
  let normalizedGatewayUrl = "";
  try {
    normalizedGatewayUrl = normalizeGatewayUrl(savedGatewayUrl);
  } catch {
    // The URL is still being edited; an invalid/partial draft is never connected.
  }
  const gatewayConnected = Boolean(
    normalizedGatewayUrl &&
      checkedGatewayUrl === normalizedGatewayUrl &&
      healthOk
  );
  const gatewaySubLabel = !savedGatewayUrl
    ? t("desktop.app.setGatewayUrlInSettings")
    : gatewayConnected
      ? t("desktop.settings.reachable")
      : t("desktop.app.failedLastCheckLong");
  const physicalPrinters = useMemo(() => printers.filter(isProductionPrinter), [printers]);
  const totalPrinters = physicalPrinters.length;
  const onlinePrinters = physicalPrinters.filter((p) => p.status === "online").length;
  const offlinePrinters = physicalPrinters.filter(
    (p) => p.status === "offline" || p.status === "error"
  ).length;
  const pendingJobs = jobs.filter((j) => ["queued", "claimed"].includes(jobStatus(j))).length;
  const failedJobs = jobs.filter((j) => ["failed", "expired"].includes(jobStatus(j)) && deriveOutcome(jobStatus(j), typeof j.error === "string" ? j.error : null) === "not_printed").length;
  const fleetAgents = (health as { agents?: { total?: number; online?: number } } | null)?.agents;
  // /api/health deliberately reports liveness only. Fabricating 0/0 here lied
  // to operators; absent data renders as an explicit dash instead.
  const fleetTotal: number | null = fleetAgents ? Number(fleetAgents.total ?? 0) : null;
  const fleetOnline: number | null = fleetAgents ? Number(fleetAgents.online ?? 0) : null;
  const printerFilterName =
    printers.find((pp) => pp.id === jobPrinterFilter)?.name ?? jobPrinterFilter ?? "";

  const filteredPrinters = useMemo(() => {
    let list = physicalPrinters;
    if (printersFilter) {
      const q = printersFilter.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          ((p.connection_type || p.connectionType) || "").toLowerCase().includes(q) ||
          ((p.printer_type || p.printerType) || "").toLowerCase().includes(q) ||
          printerEndpoint(p).toLowerCase().includes(q)
      );
    }
    if (statusFilter !== "all") {
      list = list.filter((p) => statusFilter === "stale" ? p.freshness === "stale" : p.status === statusFilter);
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [physicalPrinters, printersFilter, statusFilter]);

  const jobsFiltered = useMemo(() => {
    let list = jobs;
    if (jobPrinterFilter) {
      const target = (printers.find((pp) => pp.id === jobPrinterFilter)?.name || "").toLowerCase();
      list = list.filter((j) => {
        const pid = jobPrinterId(j);
        return (
          pid === jobPrinterFilter ||
          (!!target && String(j.printerName ?? "").toLowerCase() === target)
        );
      });
    }
    if (jobTab !== "all") {
      list = list.filter((j) => {
        const st = jobStatus(j).toLowerCase();
        const outcome = deriveOutcome(st, String(j.error ?? ""));
        if (jobTab === "in_flight") return st === "claimed" || st === "printing";
        if (jobTab === "queued") return st === "queued";
        if (jobTab === "unassigned") {
          const dest = String(j.destination ?? "");
          const pid = jobPrinterId(j);
          return dest === "unassigned" || pid === "unassigned" || !printers.some((p) => p.id === pid);
        }
        if (jobTab === "delivered") return st === "success";
        // "Unknown outcome" must exclude success rows. deriveOutcome() reports
        // "unknown" for success by design (transport success is not proof of
        // paper), so a bare outcome check makes this tab a superset of
        // "Delivered" and inflates the counter. This mirrors the Gateway's own
        // marker-based status=unknown filter (src/app/api/jobs/route.ts) and
        // the guard inside jobTone (src/shared/job-vocabulary.ts).
        if (jobTab === "unknown") return st !== "success" && outcome === "unknown";
        if (jobTab === "failed") return st === "failed" && outcome === "not_printed";
        if (jobTab === "expired") return st === "expired" && outcome !== "unknown";
        return true;
      });
    }
    if (jobSearch) {
      const q = jobSearch.toLowerCase();
      list = list.filter(
        (j) =>
          jobId(j).toLowerCase().includes(q) ||
          jobDocType(j).toLowerCase().includes(q) ||
          jobPrinterId(j).toLowerCase().includes(q)
      );
    }
    return list;
  }, [jobs, jobTab, jobSearch, jobPrinterFilter, printers]);

  const jobCounts = useMemo(
    () => ({
      all: jobs.length,
      in_flight: jobs.filter((j) => ["claimed", "printing"].includes(jobStatus(j))).length,
      queued: jobs.filter((j) => jobStatus(j) === "queued").length,
      unassigned: jobs.filter((j) => {
        const dest = String(j.destination ?? "");
        const pid = jobPrinterId(j);
        return dest === "unassigned" || pid === "unassigned" || !printers.some((p) => p.id === pid);
      }).length,
      delivered: jobs.filter((j) => jobStatus(j) === "success").length,
      unknown: jobs.filter(
        (j) => jobStatus(j) !== "success" && deriveOutcome(jobStatus(j), String(j.error ?? "")) === "unknown"
      ).length,
      failed: failedJobs,
      expired: jobs.filter((j) => jobStatus(j) === "expired" && deriveOutcome("expired", String(j.error ?? "")) !== "unknown").length,
    }),
    [jobs, printers, failedJobs]
  );

  const nav: NavItem[] = [
    { id: "dashboard", label: t("desktop.nav.overview"), icon: LayoutDashboard },
    { id: "printers", label: t("desktop.nav.printers"), icon: PrinterIcon },
    { id: "jobs", label: t("desktop.nav.printJobs"), icon: ClipboardList },
    { id: "agents", label: t("desktop.nav.agents"), icon: Cpu },
    { id: "settings", label: t("desktop.nav.settings"), icon: SettingsIcon },
  ];

  // Headings carry no subtitle where the panels already state their content.
  // The two that remain answer a question the operator cannot read off screen:
  // whose Agent this is, and what is configured here.
  // Staleness is derived from the heartbeat (90s by default), so an honest
  // status needs a clock that advances while the screen stays open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const pageMeta: Record<Page, { title: string; subtitle?: string }> = {
    dashboard: { title: t("desktop.nav.overview") },
    printers: { title: t("desktop.nav.printers") },
    jobs: { title: t("desktop.nav.printJobs") },
    agents: { title: t("desktop.nav.agents"), subtitle: t("desktop.page.agentsSubtitle") },
    settings: { title: t("desktop.nav.settings"), subtitle: t("desktop.page.settingsSubtitle") },
  };

  const state: DesktopState = {
    page,
    navigate,
    collapsed,
    setCollapsed,
    sidebarOpen,
    setSidebarOpen,
    version,
    agentStatus,
    isOnline,
    lastStatusCheck,
    autostart,
    setAutostartState,
    refreshStatus,
    startAgent,
    requestStopAgent: () => setConfirmStop(true),
    restartAgent,
    gatewayUrl,
    setGw,
    health,
    healthError,
    gatewayConnected,
    gatewayChecking,
    checkHealth,
    pairCode,
    setPairCode,
    pair,
    printers: physicalPrinters,
    discoveredPrinters,
    discoveryWarning,
    printersLoading,
    printersError,
    printersFilter,
    setPrintersFilter,
    statusFilter,
    setStatusFilter,
    filteredPrinters,
    totalPrinters,
    onlinePrinters,
    offlinePrinters,
    refreshPrinters,
    handleDiscover,
    handleTest,
    updatePrinterLifecycle,
    showAdd,
    setShowAdd,
    selectedPrinter,
    setSelectedPrinter,
    jobs,
    jobsLoading,
    jobsError,
    jobTab,
    setJobTab,
    jobSearch,
    setJobSearch,
    jobsFiltered,
    jobCounts,
    pendingJobs,
    failedJobs,
    refreshJobs,
    jobPrinterFilter,
    setJobPrinterFilter,
    printerFilterName,
    selectedJob,
    setSelectedJob,
    runtimePaths,
    advancedOpen,
    setAdvancedOpen,
    busy,
    msg,
    setMsg,
    fleetTotal,
    fleetOnline,
  };

  return (
    <div className="min-h-screen bg-app text-ink">
      <AdminPrivilegeDialog
        open={isAdmin === false && !adminDismissed}
        onClose={() => setAdminDismissed(true)}
      />
      <Sidebar
        page={page}
        navigate={navigate}
        items={nav}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        gatewayConnected={gatewayConnected}
        gatewayUrl={gatewayUrl}
        isOnline={isOnline}
        version={version}
        lastStatusCheck={lastStatusCheck}
      />
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 lg:hidden"
          style={{ backgroundColor: "var(--overlay)" }}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <div
        className={`flex min-h-screen min-w-0 flex-col transition-[padding] duration-180 ${collapsed ? "lg:ps-[72px]" : "lg:ps-[248px]"}`}
      >
        <header className="sticky top-0 z-20 border-b border-edge/80 bg-surface/88 px-4 py-4 backdrop-blur-xl lg:px-7">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setCollapsed(false);
                setSidebarOpen(true);
              }}
              className="rounded-md border border-edge bg-surface p-2.5 text-ink-2 shadow-xs transition hover:bg-surface-2 lg:hidden"
              aria-label={t("desktop.app.openNavigation")}
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <PageHeader
                title={pageMeta[page].title}
                subtitle={pageMeta[page].subtitle}
                actions={
                  <>
                    <StatusBadge
                      tone={isOnline ? "ok" : "bad"}
                      label={isOnline ? t("desktop.status.agentRunning") : t("desktop.status.agentStopped")}
                    />
                    <Button
                      variant="secondary"
                      onClick={() => {
                        refreshStatus();
                        refreshPrinters();
                        if (gatewayUrl) refreshJobs();
                      }}
                      icon={<RefreshCw className="h-[18px] w-[18px]" />}
                      aria-label={t("desktop.app.refreshAll")}
                    >
                      <span className="hidden sm:inline">{t("desktop.app.refresh")}</span>
                    </Button>
                      <LanguageSwitcher />
                      <ThemeToggle />
                  </>
                }
              />
            </div>
          </div>
        </header>

        {isAdmin === false && adminDismissed && (
          <div
            className="flex items-center justify-between gap-3 border-b border-warn-edge bg-warn-bg px-5 py-3 text-xs text-warn lg:px-8"
            role="status"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                <strong>{t("desktop.app.readOnlyMode")}</strong> {t("desktop.app.readOnlyBody")}
              </span>
            </div>
            <button
              onClick={() => setAdminDismissed(false)}
              className="font-medium underline hover:text-warn/80 cursor-pointer"
            >
              {t("desktop.app.viewDetails")}
            </button>
          </div>
        )}

        <main className="w-full flex-1 px-5 py-7 lg:px-8 lg:py-8">
          {page === "dashboard" && <OverviewPage s={state} />}
          {page === "printers" && <PrintersPage s={state} />}
          {page === "jobs" && <JobsPage s={state} />}
          {page === "agents" && <AgentsPage s={state} />}
          {page === "settings" && <SettingsPage s={state} />}
        </main>
      </div>

      <AddPrinterDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onSuccess={() => {
          refreshPrinters();
          setMsg({ text: t("desktop.app.printerAdded"), type: "success" });
        }}
        printers={discoveredPrinters}
        gatewayUrl={savedGatewayUrl}
      />

      <EditPrinterDialog
        key={editingPrinter ? `edit-${editingPrinter.id}-${editingPrinter.desiredRevision ?? 0}` : "edit-none"}
        open={!!editingPrinter}
        printer={editingPrinter}
        gatewayUrl={savedGatewayUrl}
        onClose={() => setEditingPrinter(null)}
        onSaved={handleEditSaved}
        onError={(message) => setMsg({ text: friendlyPrinterError(message, locale), type: "error" })}
      />

      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title={t("desktop.app.stopAgentTitle")}
        description={t("desktop.app.stopAgentDescription")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmStop(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={stopAgent}
              icon={<Square className="h-4 w-4" />}
            >
              {t("desktop.app.stopAgent")}
            </Button>
          </>
        }
      >
        <p className="text-base leading-relaxed text-ink-2">{t("desktop.app.stopAgentBody")}</p>
        <p className="mt-3 text-base leading-relaxed text-ink-2">
          <strong className="font-[620] text-warn">{t("desktop.app.unknownPartial")}</strong>
        </p>
      </Modal>

      <Drawer
        open={!!selectedPrinter}
        onClose={() => setSelectedPrinter(null)}
        title={t("desktop.drawer.printerTitle")}
        description={selectedPrinter?.name}
      >
        {selectedPrinter && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 rounded-xl border border-edge-accent bg-surface-accent px-5 py-4">
              <StatusDot tone={printerTone(printerDisplayStatus(selectedPrinter))} />
              <span className="text-lg font-semibold text-ink">
                {labelPrinter(printerDisplayStatus(selectedPrinter), locale)}
              </span>
              {printerIsStale(selectedPrinter) ? <StatusBadge tone="warn" label={t("status.stale")} /> : null}
              <span className="ms-auto text-sm text-ink-3">
                {humanType(selectedPrinter, locale)}
              </span>
            </div>
            <div className="divide-y divide-edge">
              <MetaRow label={t("desktop.drawer.name")}>
                <span className="block truncate">{selectedPrinter.name}</span>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.connection")}>{humanConnection(selectedPrinter, locale)}</MetaRow>
              <MetaRow label={t("desktop.drawer.protocol")}>{selectedPrinter.protocol || "—"}</MetaRow>
              <MetaRow label={t("desktop.drawer.address")}>
                <Mono>{printerEndpoint(selectedPrinter)}</Mono>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.stableId")}>
                <Mono>{selectedPrinter.id}</Mono>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.lifecycle")}>{selectedPrinter.lifecycle ?? "active"}</MetaRow>
              <MetaRow label={t("desktop.drawer.management")}>
                {selectedPrinter.managementSource === "manager" ? t("desktop.drawer.gatewayDesired") : t("desktop.drawer.agentOwned")}
              </MetaRow>
              {/* Internal revision counters (desired/applied/observed) are an
                  implementation detail: operators need the setup state and the
                  next step, not the state-machine numbers. */}
              <MetaRow label={t("desktop.drawer.setup")}>
                {selectedPrinter.managementSource !== "manager"
                  ? t("desktop.drawer.agentOwned")
                  : selectedPrinter.configurationConverged
                    ? t("desktop.drawer.applied")
                    : t("desktop.drawer.pending")}
              </MetaRow>
              <MetaRow label={t("desktop.drawer.agent")}>
                {selectedPrinter.agentName ?? selectedPrinter.agentId ?? "—"} ·{" "}
                {printerAgentView(selectedPrinter, nowMs, locale).label}
              </MetaRow>
              <MetaRow label={t("desktop.drawer.agentHeartbeat")}>
                {selectedPrinter.agentLastSeenAt ? formatDateTime(selectedPrinter.agentLastSeenAt) : "—"}
              </MetaRow>

              {selectedPrinter.usbVid && (
                <MetaRow label="USB">
                  <Mono>
                    {selectedPrinter.usbVid}:{selectedPrinter.usbPid}{" "}
                    {selectedPrinter.usbSerial || ""}
                  </Mono>
                </MetaRow>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(selectedPrinter.managementSource === "manager" || selectedPrinter.managementSource === undefined) &&
                selectedPrinter.lifecycle !== "retired" && (
                <Button
                  variant="secondary"
                  onClick={() => setEditingPrinter(selectedPrinter)}
                >
                  {t("desktop.drawer.editConfig")}
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => handleTest(selectedPrinter.id)}
                icon={<Play className="h-4 w-4" />}
              >
                {t("desktop.drawer.localTest")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setJobPrinterFilter(selectedPrinter.id);
                  setSelectedPrinter(null);
                  navigate("jobs");
                }}
                icon={<ClipboardList className="h-4 w-4" />}
              >
                {t("desktop.drawer.viewJobs")}
              </Button>
            </div>
            <p className="text-sm leading-relaxed text-ink-3">
              {t("desktop.drawer.testPageNote")}
            </p>
          </div>
        )}
      </Drawer>

      <Drawer
        open={!!selectedJob}
        onClose={() => setSelectedJob(null)}
        title={t("desktop.drawer.jobTitle")}
        description={selectedJob ? jobDocType(selectedJob, locale) : undefined}
      >
        {selectedJob && (
          <div className="space-y-6">
            <div className="space-y-4">
              <StatusBadge
                tone={toneJob(jobStatus(selectedJob), selectedJob.error)}
                label={labelJob(jobStatus(selectedJob), selectedJob.error, locale)}
              />
              <JobTimeline
                status={jobStatus(selectedJob)}
                error={selectedJob.error ? String(selectedJob.error) : null}
                claimedAt={selectedJob.claimedAt ? String(selectedJob.claimedAt) : null}
              />
            </div>
            <div className="divide-y divide-edge">
              <MetaRow label={t("desktop.drawer.jobId")}>
                <Mono>{jobId(selectedJob)}</Mono>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.printer")}>
                <span className="block truncate">
                  {String(
                    printers.find((p) => p.id === jobPrinterId(selectedJob))?.name ||
                      jobPrinterId(selectedJob) ||
                      "—"
                  )}
                </span>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.destination")}>
                <span className="block truncate">{jobDestination(selectedJob) || "—"}</span>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.retries")}>{String(selectedJob.retries ?? 0)}</MetaRow>
              <MetaRow label={t("desktop.drawer.created")}>
                {formatDateTime(jobTimestamp(selectedJob, "createdAt"))}
              </MetaRow>
              <MetaRow label={t("desktop.drawer.updated")}>
                {formatDateTime(jobTimestamp(selectedJob, "updatedAt"))}
              </MetaRow>
            </div>
            {selectedJob.error ? (
              <div className="rounded-xl border border-bad-edge bg-bad-bg p-5">
                {(() => {
                  const outcome = deriveOutcome(jobStatus(selectedJob), String(selectedJob.error));
                  // A success row can still carry a residual error (for example
                  // the Gateway's "LATE_SUCCESS: ..." note). Its physical outcome
                  // is still unverified, but it is NOT an ambiguous failure, so
                  // it must not render the "outcome unknown" banner.
                  const unknown = jobStatus(selectedJob) !== "success" && outcome === "unknown";
                  const classified = jobFailurePresentation(String(selectedJob.error), locale);
                  return (
                    <>
                      <div className={`flex items-center gap-2 text-md font-semibold ${unknown ? "text-warn" : "text-bad"}`}>
                        <AlertTriangle className="h-5 w-5" aria-hidden />
                        {classified?.title ?? (unknown ? t("desktop.drawer.outcomeUnknown") : t("desktop.drawer.printFailed"))}
                      </div>
                      <p className="mt-2 text-base leading-relaxed text-ink-2">
                        {classified?.guidance ?? friendlyPrinterError(String(selectedJob.error), locale)}
                      </p>
                      {!unknown && (
                        <p className="mt-3 text-sm text-ink-3">
                          {t("desktop.drawer.failedBeforePrinting")}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-info-edge bg-info-bg px-5 py-4 text-base text-info">
                <Info className="h-5 w-5 flex-shrink-0" aria-hidden />
                {jobGuidance(jobStatus(selectedJob), deriveOutcome(jobStatus(selectedJob), null), locale) ||
                  t("desktop.drawer.noErrorRecorded")}
              </div>
            )}
          </div>
        )}
      </Drawer>

      <ToastView toast={msg} onDismiss={() => setMsg(null)} />
    </div>
  );
}

/**
 * Start on the stored language.
 *
 * Unlike the console, the desktop bundle is never server-rendered, so there is
 * no hydration to keep in step: reading storage during startup cannot mismatch
 * anything, and it saves the app from rendering one English frame before the
 * provider adopts the preference.
 */
function initialDesktopLocale(): Locale {
  try {
    return resolveLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider initialLocale={initialDesktopLocale()}>
    <App />
  </I18nProvider>,
);
