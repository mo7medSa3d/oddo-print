import { PrinterVerificationDetails } from "../components/PrinterVerificationDetails";
/* eslint-disable react-hooks/exhaustive-deps */
import { PrinterGeometryDetails } from "../components/PrinterGeometrySettings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ClipboardList,
  Info,
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Globe2,
  Moon,
  Search,
  Printer as PrinterIcon,
  RefreshCw,
  Settings as SettingsIcon,
  Square,
  Play,
  ShieldAlert,
  LogOut,
} from "lucide-react";
import {
  Button,
  Drawer,
  MetaRow,
  Modal,
  Menu as ActionMenu,
  Mono,
  StatusBadge,
  StatusDot,
  Toast as ToastView,
} from "../components/ui";
import { ThemeToggle, toggleTheme } from "../components/ThemeToggle";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { JobTimeline } from "./components/JobTimeline";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { AddPrinterDialog } from "./components/AddPrinterDialog";
import { PrinterAvailabilityControl } from "./components/PrinterAvailabilityControl";
import { OverviewPage } from "./pages/Overview";
import { PrintersPage } from "./pages/Printers";
import { JobsPage } from "./pages/Jobs";
import { SettingsPage } from "./pages/Settings";
import {
  probeGatewayHealth,
  getAgentStatus,
  getAppVersion,
  getAutostart,
  isRunningAsAdmin,
  relaunchAsAdmin,
  closeApp,
  getGatewayUrl,
  getPrinters,
  setPrinterVisibility,
  getRuntimePaths,
  isTauri,
  onTrayNavigate,
  onTrayRestartAgent,
  onGatewayConfigChanged,
  pairAgent,
  restartAgent as ipcRestartAgent,
  setGatewayUrl,
  startAgent as ipcStartAgent,
  stopAgent as ipcStopAgent,
  normalizeGatewayUrl,
  discoverPrinters,
  setTrayLocale,
  type PrinterInfo,
} from "./lib/ipc";
import {
  agentServiceState,
  deriveOutcome,
  printerAgentView,
  errMsg,
  friendlyPrinterError,
  jobFailurePresentation,
  humanConnection,
  humanType,
  isProductionPrinter,
  isMainInventoryPrinter,
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
  printerPresentation,
  printerDisplayName,
  printerStatusDetail,
  printerDisplayStatus,
  printerHealthCounts,
  printerEndpoint,
  printerIsStale,
  mergePrinterInventories,
  jobTimestamp,
} from "./lib/printers";
import { lifecycleLabel } from "../lib/lifecycle-labels";
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
import { DEFAULT_LOCALE, LOCALE_LABELS, LOCALE_STORAGE_KEY, resolveLocale, type Locale } from "../i18n/config";
import {
  emptyGatewayConnectivityEvidence,
  noteGatewayConnectivityFailure,
  noteGatewayConnectivitySuccess,
  type GatewayConnectivityEvidence,
} from "./lib/gateway-connectivity";
/* Desktop Manager uses the shared light/dark theme tokens. */
import "./theme-light.css";

const PAGES: Page[] = ["dashboard", "printers", "jobs", "settings"];
const GATEWAY_AUTO_PROBE_INTERVAL_MS = 10_000;
const LOCAL_AGENT_STATUS_INTERVAL_MS = 10_000;

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
  const { t, locale, setLocale, formatDateTime } = useI18n();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [navSearchOpen, setNavSearchOpen] = useState(false);
  const [navSearchQuery, setNavSearchQuery] = useState("");
  useEffect(() => {
    if (isTauri && isAdmin !== true) return;
    const openWithKeyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setNavSearchQuery("");
        setNavSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openWithKeyboard);
    return () => window.removeEventListener("keydown", openWithKeyboard);
  }, [isAdmin]);
  useEffect(() => {
    void setTrayLocale(locale).catch(() => {});
  }, [locale]);
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
  const localPrinterReadFlight = useRef(false);
  const localInventoryReadyRef = useRef(false);
  const sharingFlights = useRef(new Set<string>());
  const jobsGeneration = useRef(0);
  const healthGeneration = useRef(0);
  const agentStatusGeneration = useRef(0);
  const gatewayProbeFlightRef = useRef<string | null>(null);
  const gatewayConnectivityRef = useRef<GatewayConnectivityEvidence>(emptyGatewayConnectivityEvidence());
  const configurationFlight = useRef(false);
  const [pairCode, setPairCode] = useState("");
  const [pairedOrigin, setPairedOrigin] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  // Errors from checking the editable Settings draft are separate from the
  // health observation for the persisted Gateway. A bad draft must not make
  // a previously observed saved Gateway appear offline.
  const [gatewayDraftError, setGatewayDraftError] = useState<string | null>(null);
  // Connectivity is controlled by the evidence state machine: positive
  // evidence wins immediately; an established connection is declared down
  // only after a confirmed outage, never because a timer/probe became stale.
  const [agentStatus, setAgentStatus] = useState<AgentStatusView | null>(null);
  const [runtimePaths, setRuntimePaths] = useState<DesktopState["runtimePaths"]>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMessage>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [adminRelaunching, setAdminRelaunching] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [agentStartupGraceElapsed, setAgentStartupGraceElapsed] = useState(false);

  const [discoveredPrinters, setDiscoveredPrinters] = useState<PrinterInfo[]>([]);
  const [localPrinters, setLocalPrinters] = useState<PrinterInfo[]>([]);
  const [localPrintersLoading, setLocalPrintersLoading] = useState(false);
  const [localPrintersError, setLocalPrintersError] = useState<string | null>(null);
  const [localInventoryReady, setLocalInventoryReady] = useState(false);
  const [availabilityPendingPrinterIds, setSharingPendingPrinterIds] = useState<ReadonlySet<string>>(() => new Set());
  const [availabilityErrors, setSharingErrors] = useState<Record<string, string>>({});
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
  const [selectedPrinterSnapshot, setSelectedPrinter] = useState<PrinterInfo | null>(null);
  const [selectedJobSnapshot, setSelectedJob] = useState<JobRecord | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [gatewayChecking, setGatewayChecking] = useState(false);
  const [checkedGatewayUrl, setCheckedGatewayUrl] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [jobPrinterFilter, setJobPrinterFilter] = useState<string | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const invalidateGatewayInventory = useCallback((nextUrl: string) => {
    if (savedOriginRef.current === nextUrl) return;
    // A native save may commit even when its change event is lost. Every
    // durable origin transition must discard the previous Gateway's rows,
    // selections and in-flight reads before the new origin becomes active.
    gatewayConnectivityRef.current = emptyGatewayConnectivityEvidence(nextUrl);
    ++printersGeneration.current; ++jobsGeneration.current; ++healthGeneration.current;
    setPrintersLoading(false); setJobsLoading(false);
    setPrintersError(null); setJobsError(null);
    setJobs([]);
    setSelectedPrinter(null); setSelectedJob(null);
    setPairedOrigin(null); setJobPrinterFilter(null);
    setShowAdd(false);
  }, []);
  const savedOriginMatches = useCallback((targetUrl: string): boolean => {
    try {
      return normalizeGatewayUrl(savedOriginRef.current) === normalizeGatewayUrl(targetUrl);
    } catch {
      return false;
    }
  }, []);

  const observeGatewaySuccess = useCallback((
    targetUrl: string,
    observation?: Record<string, unknown>,
  ): boolean => {
    let canonical: string;
    try {
      canonical = normalizeGatewayUrl(targetUrl);
    } catch {
      return false;
    }
    if (!savedOriginMatches(canonical)) return false;

    const observedAt = Date.now();
    gatewayConnectivityRef.current = noteGatewayConnectivitySuccess(
      gatewayConnectivityRef.current,
      canonical,
      observedAt,
    );
    setHealth((previous) => observation ?? previous ?? {
      ok: true,
      service: "odoo-direct-print-agent",
      evidence: "authenticated-api",
    });
    setCheckedGatewayUrl(canonical);
    setHealthError(null);
    return true;
  }, [savedOriginMatches]);

  const observeGatewayFailure = useCallback((
    targetUrl: string,
    presentedError: string,
  ): boolean => {
    let canonical: string;
    try {
      canonical = normalizeGatewayUrl(targetUrl);
    } catch {
      return false;
    }
    if (!savedOriginMatches(canonical)) return false;

    const observedAt = Date.now();
    const outcome = noteGatewayConnectivityFailure(
      gatewayConnectivityRef.current,
      canonical,
      observedAt,
    );
    gatewayConnectivityRef.current = outcome.evidence;
    if (!outcome.confirmedOffline) return false;

    setHealth(null);
    setCheckedGatewayUrl(canonical);
    setHealthError(presentedError);
    return true;
  }, [savedOriginMatches]);

  const refreshStatus = useCallback(async () => {
    if (!isTauri) return;
    const generation = ++agentStatusGeneration.current;
    try {
      const s = await getAgentStatus();
      if (generation !== agentStatusGeneration.current) return;
      setAgentStatus(s);
      setLastStatusCheck(new Date().toISOString());
    } catch (e) {
      if (generation !== agentStatusGeneration.current) return;
      setAgentStatus({ error: friendlyAgentError(errMsg(e), locale) });
    }
  }, [locale]);

  const refreshLocalPrinters = useCallback(async (force = false) => {
    if (!isTauri) return false;
    if (localPrinterReadFlight.current && !force) return false;
    const generation = ++localPrintersGeneration.current;
    localPrinterReadFlight.current = true;
    // Keep confirmed inventory ready during routine background refreshes so
    // sharing buttons do not flash disabled every 60s or on window focus.
    // Mutations still clear readiness explicitly before forcing a re-read.
    if (!localInventoryReadyRef.current) setLocalInventoryReady(false);
    setLocalPrintersLoading(true);
    try {
      const list = await getPrinters();
      if (generation !== localPrintersGeneration.current) return false;
      const completedAt = Date.now();
      // The display clock may still hold its pre-read value from the last
      // 15-second tick. Advance it with native observation evidence; otherwise
      // a just-confirmed local printer looks stale (and sharing stays disabled)
      // until the next tick because its observation time is in the future.
      setNowMs((previous) => Math.max(previous, completedAt));
      setLocalPrinters(list.filter(isProductionPrinter).map((p) => ({ ...p, localObservedAt: completedAt, availableToOdoo: p.availableToOdoo ?? true })));
      localInventoryReadyRef.current = true;
      setLocalInventoryReady(true);
      setLocalPrintersError(null);
      return true;
    } catch (error) {
      if (generation === localPrintersGeneration.current) setLocalPrintersError(friendlyAgentError(errMsg(error), locale));
      // Preserve confirmed choices/observations; no stale-file success fallback.
      return false;
    } finally {
      if (generation === localPrintersGeneration.current) {
        localPrinterReadFlight.current = false;
        setLocalPrintersLoading(false);
      }
    }
  }, [locale]);

  const handlePrinterVisibility = useCallback(async (id: string, shared: boolean) => {
    if (sharingFlights.current.has(id)) return;
    if (!isTauri || isAdmin !== true || !localInventoryReadyRef.current || !localPrinters.some((p) => p.id === id && !printerIsStale(p, Date.now()))) {
      setSharingErrors((current) => ({ ...current, [id]: t(isAdmin !== true ? "desktop.printers.sharingAdminRequired" : "desktop.printers.sharingRefreshRequired") }));
      return;
    }
    sharingFlights.current.add(id);
    setSharingPendingPrinterIds(new Set(sharingFlights.current));
    setSharingErrors((current) => { const next = { ...current }; delete next[id]; return next; });
    try {
      const reply = await setPrinterVisibility(id, shared);
      ++localPrintersGeneration.current;
      localInventoryReadyRef.current = false;
      setLocalInventoryReady(false);
      // Only a validated durable acknowledgment updates the local choice.
      setLocalPrinters((current) => current.map((p) => p.id === reply.printerId ? { ...p, availableToOdoo: reply.availableToOdoo, sharedWithGateway: reply.availableToOdoo } : p));
      setMsg({ text: t("desktop.printers.sharingSaved"), type: "success" });
      await refreshLocalPrinters(true);
    } catch (error) {
      setSharingErrors((current) => ({ ...current, [id]: friendlyAgentError(errMsg(error), locale) }));
      // A lost acknowledgment may follow a committed choice. Read the policy
      // again before allowing another mutation, without an optimistic update.
      await refreshLocalPrinters(true);
    } finally {
      sharingFlights.current.delete(id);
      setSharingPendingPrinterIds(new Set(sharingFlights.current));
    }
  }, [isAdmin, localPrinters, t, locale, refreshLocalPrinters]);

  // Printer inventory is local to this Agent. Odoo receives the same inventory
  // through authenticated Agent heartbeats; the Desktop never reads or writes
  // a Cloud printer fleet.
  const refreshPrinters = useCallback(async () => {
    setPrintersError(null);
    return refreshLocalPrinters(true);
  }, [refreshLocalPrinters]);

  // Odoo owns the authoritative print queue and job history. The Desktop
  // intentionally does not mirror a second Cloud queue.
  const refreshJobs = useCallback(async (_options?: { status?: string; search?: string; limit?: number; printerId?: string; merge?: boolean }) => {
    ++jobsGeneration.current;
    setJobs([]);
    setJobsError(null);
    setJobsLoading(false);
  }, []);

  const probeGateway = useCallback(async (targetUrl: string): Promise<boolean> => {
    // Keep the periodic checker single-flight. A slow network probe must not
    // accumulate concurrent 10-second requests behind the timer.
    if (gatewayProbeFlightRef.current === targetUrl) return false;
    gatewayProbeFlightRef.current = targetUrl;
    const generation = ++healthGeneration.current;
    const current = () => {
      if (generation !== healthGeneration.current) return false;
      try {
        return normalizeGatewayUrl(savedOriginRef.current) === targetUrl;
      } catch {
        return false;
      }
    };

    try {
      // The connection card answers "can this Manager reach the Yaseir
      // Gateway?", so use the public identity/liveness endpoint. Database
      // readiness belongs to /api/health and must not make connectivity flap.
      const h = await probeGatewayHealth(targetUrl);
      if (!current()) return false;
      return observeGatewaySuccess(targetUrl, h);
    } catch (e) {
      if (!current()) return false;
      observeGatewayFailure(targetUrl, friendlyGatewayError(e, locale));
      return false;
    } finally {
      if (gatewayProbeFlightRef.current === targetUrl) {
        gatewayProbeFlightRef.current = null;
      }
    }
  }, [locale, observeGatewayFailure, observeGatewaySuccess]);

  const checkHealth = useCallback(async () => {
    // Probe the operator's draft without mutating the persisted Gateway.
    // Persisting first used to invalidate the Manager session even when the
    // candidate was unreachable (C050).
    const raw = gatewayUrl.trim();
    if (!raw) {
      setGatewayDraftError(t("desktop.app.gatewayUrlMissing"));
      return;
    }

    let target: string;
    try {
      target = normalizeGatewayUrl(raw);
    } catch (e) {
      setGatewayDraftError(friendlyGatewayError(e, locale));
      return;
    }

    if (configurationFlight.current) return;
    configurationFlight.current = true;
    setGatewayChecking(true);
    setGatewayDraftError(null);

    let candidateObserved = false;
    try {
      const candidateHealth = await probeGatewayHealth(target);
      const candidateError = (candidateHealth as { error?: unknown }).error;
      if (candidateError) throw new Error(errMsg(candidateError));
      if ((candidateHealth as { ok?: unknown }).ok !== true) {
        throw new Error(t("desktop.app.gatewayHealthNotReady"));
      }
      candidateObserved = true;

      let saveWarning: string | null = null;
      try {
        await setGatewayUrl(target);
      } catch (saveError) {
        // set_gateway_config writes before emitting its notification. If the
        // emit fails, the command reports an error even though disk already
        // contains the new origin. Re-read the durable source of truth before
        // deciding whether the save failed or merely returned ambiguously.
        let durable: string;
        try {
          durable = await getGatewayUrl();
        } catch (reconcileError) {
          throw new Error(t("desktop.app.gatewayReconcileFailed", {
            save: errMsg(saveError),
            reconcile: errMsg(reconcileError),
          }));
        }
        invalidateGatewayInventory(durable);
        savedOriginRef.current = durable;
        setSavedGatewayUrl(durable);
        let normalizedDurable = "";
        try { normalizedDurable = normalizeGatewayUrl(durable); } catch { /* invalid durable state stays non-matching */ }
        if (normalizedDurable !== target) throw saveError;
        saveWarning = t("desktop.app.gatewaySavedAfterReconcile");
      }

      // The candidate is now both positively observed and durably selected.
      // Update the renderer even if the native config-change event was lost.
      invalidateGatewayInventory(target);
      savedOriginRef.current = target;
      setSavedGatewayUrl(target);
      setGw(target);
      observeGatewaySuccess(target, candidateHealth);
      setGatewayDraftError(null);
      setMsg({
        text: saveWarning ?? t("desktop.app.connectionVerified"),
        type: saveWarning ? "info" : "success",
      });
    } catch (e) {
      // Candidate probe failures do not touch durable configuration. Save
      // failures are reconciled above before reaching this point. Keep the
      // draft visible for correction/retry while operational flows continue
      // using savedGatewayUrl.
      const presented = friendlyGatewayError(e, locale);
      if (!candidateObserved && savedOriginMatches(target)) {
        // Manual checks use the same outage confirmation as background probes.
        // A user clicking "Check connection" during one DNS/TLS hiccup must
        // not tear down a connection that the Agent/other API calls still prove.
        observeGatewayFailure(target, presented);
      }
      setGatewayDraftError(presented);
      setMsg({ text: presented, type: "error" });
    } finally {
      configurationFlight.current = false;
      setGatewayChecking(false);
    }
  }, [gatewayUrl, t, locale, observeGatewayFailure, observeGatewaySuccess, savedOriginMatches, invalidateGatewayInventory]);

  const handleDiscover = useCallback(async () => {
    if (!isTauri) return;
    setPrintersLoading(true);
    setPrintersError(null);
    try {
      const res = await discoverPrinters();
      const list = res.printers.filter(isProductionPrinter);
      setDiscoveredPrinters(list);
      // Partial-source diagnostics are retained in the protected native log.
      // Only a failed CLI discovery itself is an actionable UI error.
      const refreshed = await refreshPrinters();
      // Unlike per-source reachability notices, an inability to persist the
      // inventory is actionable. Present a calm local-save error, not raw Win32
      // diagnostics, and keep the successfully observed printer candidates.
      const persistFailed = res.errors.some((item) => item.includes("Failed to persist discovery:"));
      setMsg({
        text: persistFailed ? t("desktop.printers.localSaveFailed")
          : list.length === 0 ? t("desktop.app.noPhysicalPrinters")
          : t("desktop.app.discoveryFound", { count: list.length }),
        type: persistFailed ? "error" : !refreshed ? "info" : list.length > 0 ? "success" : "info",
      });
    } catch (e) {
      setPrintersError(friendlyPrinterError(errMsg(e), locale));
    } finally {
      setPrintersLoading(false);
    }
  }, [refreshPrinters, t, locale]);

  // Re-probe only the persisted Gateway origin without saving or touching any
  // unsaved Settings draft. Used by the Overview "Retry check" banner.
  const retrySavedGateway = useCallback(async () => {
    const raw = savedOriginRef.current.trim();
    if (!raw || configurationFlight.current) return;
    let target: string;
    try {
      target = normalizeGatewayUrl(raw);
    } catch (e) {
      setHealthError(friendlyGatewayError(e, locale));
      return;
    }
    setGatewayChecking(true);
    try {
      await probeGateway(target);
    } finally {
      setGatewayChecking(false);
    }
  }, [locale, probeGateway]);

  // Quiet discovery for the Add Printer dialog: same scan and state
  // updates as handleDiscover, but no page-level toast — the dialog
  // renders its own searching/empty/error states and its picker fills
  // from the state updated here.
  const handleDialogDiscover = useCallback(async () => {
    const res = await discoverPrinters();
    setDiscoveredPrinters(res.printers.filter(isProductionPrinter));
    await refreshLocalPrinters(true);
  }, [refreshLocalPrinters]);

  const startAgent = useCallback(async () => {
    try {
      setBusy(true);
      await ipcStartAgent();
      setMsg({ text: t("desktop.app.agentStarted"), type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, t, locale]);

  const stopAgent = useCallback(async () => {
    setConfirmStop(false);
    try {
      setBusy(true);
      await ipcStopAgent();
      setMsg({ text: t("desktop.app.agentStopped"), type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, t, locale]);

  const restartAgent = useCallback(async () => {
    try {
      setBusy(true);
      await ipcRestartAgent();
      setMsg({ text: t("desktop.app.agentRestarted"), type: "success" });
      refreshStatus();
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, t, locale]);

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
      setBusy(true);
      await pairAgent(pairCode.trim(), savedGatewayUrl);
      if (savedOriginRef.current !== savedGatewayUrl) return;
      setPairedOrigin(savedGatewayUrl);
      setMsg({ text: t("desktop.app.agentPaired"), type: "success" });
      setPairCode("");
      refreshStatus();
      await refreshPrinters();
    } catch (e) {
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusy(false);
    }
  }, [pairCode, savedGatewayUrl, refreshPrinters, refreshStatus, t, locale]);

  useEffect(() => () => {
    ++agentStatusGeneration.current;
    ++localPrintersGeneration.current;
    ++healthGeneration.current;
    ++printersGeneration.current;
    ++jobsGeneration.current;
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    isRunningAsAdmin()
      .then((admin) => { if (!disposed) setIsAdmin(admin); })
      .catch(() => { if (!disposed) setIsAdmin(false); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!isTauri || isAdmin !== true) return;
    // Elevated startup may start/repair the Windows service on a background
    // thread. Give that privileged startup a short grace period before showing
    // the separate elevated "Agent stopped" recovery banner.
    const timer = window.setTimeout(() => {
      setAgentStartupGraceElapsed(true);
      void refreshStatus();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [isAdmin, refreshStatus]);

  useEffect(() => {
    if (!isTauri || isAdmin !== true) return;
    let disposed = false;
    getAppVersion()
      .then((v) => { if (!disposed) setVersion(v); })
      .catch(() => {});
    getGatewayUrl()
      .then((v) => {
        if (disposed) return;
        let canonical = v;
        try { canonical = normalizeGatewayUrl(v); } catch { /* keep invalid persisted value visible for repair */ }
        savedOriginRef.current = canonical;
        gatewayConnectivityRef.current = emptyGatewayConnectivityEvidence(canonical);
        setGw(canonical);
        setSavedGatewayUrl(canonical);
      })
      .catch(() => {
        if (!disposed) setMsg({ text: t("desktop.app.gatewaySettingsReadFailed"), type: "error" });
      });
    getRuntimePaths()
      .then((paths) => { if (!disposed) setRuntimePaths(paths); })
      .catch(() => {});
    getAutostart()
      .then((st) => { if (!disposed) setAutostartState(st.enabled); })
      .catch(() => {});
    // Persisted startup configuration is read once after elevation is confirmed.
    // Locale-aware polling below may restart when presentation changes, without replacing a draft.
    return () => { disposed = true; };
  }, [isAdmin]);

  useEffect(() => {
    if (!isTauri || isAdmin !== true) return;
    refreshStatus();
    void refreshLocalPrinters();
    const id = setInterval(refreshStatus, LOCAL_AGENT_STATUS_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isAdmin, refreshStatus, refreshLocalPrinters]);

  useEffect(() => {
    if (!isTauri || isAdmin !== true) return;
    const refresh = () => { if (document.visibilityState === "visible") void refreshLocalPrinters(); };
    const timer = setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isAdmin, refreshLocalPrinters]);

  useEffect(() => {
    if (!isTauri || isAdmin !== true || !savedGatewayUrl) return;

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

    // Auto-probe only the already-persisted Gateway. A newly edited URL is
    // checked through the explicit non-mutating candidate probe first.
    // Older releases may have persisted the same origin with a trailing slash,
    // so the canonical target above is the comparison/transport identity.
    let disposed = false;
    const runProbe = () => {
      if (!disposed) void probeGateway(target);
    };
    const timer = window.setTimeout(runProbe, 250);
    const interval = window.setInterval(runProbe, GATEWAY_AUTO_PROBE_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") runProbe();
    };
    window.addEventListener("online", runProbe);
    window.addEventListener("focus", runProbe);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("online", runProbe);
      window.removeEventListener("focus", runProbe);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isAdmin, savedGatewayUrl, probeGateway]);


  useEffect(() => {
    if (!isTauri || isAdmin !== true) return;
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
  }, [isAdmin, navigate, restartAgent]);

  useEffect(() => {
    if (!isTauri || isAdmin !== true) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onGatewayConfigChanged((url) => {
      let canonicalUrl = url;
      try { canonicalUrl = normalizeGatewayUrl(url); } catch { /* preserve invalid value for visible repair */ }
      // Invalidate stale Gateway inventory on origin change. The paired CLI
      // binds all requests to the current Agent configuration.
      invalidateGatewayInventory(canonicalUrl);
      savedOriginRef.current = canonicalUrl;
      void refreshLocalPrinters();
      setSavedGatewayUrl(canonicalUrl);
      setGw(canonicalUrl);
      if (canonicalUrl) {
        void probeGateway(canonicalUrl);
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
  }, [isAdmin, probeGateway, refreshStatus, refreshLocalPrinters, t, invalidateGatewayInventory]);

  // Affirmative observations only: an empty/missing health object, an agent
  // status without running:true, or a probe older than the freshness window
  // must read as unavailable — never as healthy/online (C046).
  // Gateway connectivity refreshes every 10s, but presentation is not tied to
  // a short freshness expiry. Confirmed negative evidence drives disconnect;
  // focus/online events force immediate probes after sleep or network changes.
  const serviceState = agentServiceState(agentStatus);
  const isOnline = serviceState === "running";
  const serviceTone = serviceState === "unknown" ? "neutral" : isOnline ? "ok" : "bad";
  const serviceLabel = serviceState === "unknown" ? t("desktop.agents.statusUnavailable") : isOnline ? t("desktop.status.agentRunning") : t("desktop.status.agentStopped");
  const healthOk = Boolean(health && (health as { ok?: boolean }).ok === true && !healthError);
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
  let normalizedGatewayDraft = "";
  try {
    normalizedGatewayDraft = normalizeGatewayUrl(gatewayUrl);
  } catch {
    // Invalid/partial drafts are intentionally distinct from saved config.
  }
  const gatewayDraftMatchesSaved = gatewayUrl.trim().length === 0
    ? normalizedGatewayUrl.length === 0
    : normalizedGatewayDraft.length > 0 && normalizedGatewayDraft === normalizedGatewayUrl;
  const physicalPrinters = useMemo(() => mergePrinterInventories([], localPrinters), [localPrinters]);
  const totalPrinters = physicalPrinters.filter(isMainInventoryPrinter).length;
  // Counts are liveness evidence, not snapshot status: a printer whose
  // observations went stale while the screen stays open must not count as
  // online (C045). nowMs ticks every 15s to re-derive these on open screens.
  const { online: onlinePrinters, offline: offlinePrinters } = printerHealthCounts(physicalPrinters, nowMs);
  // Single predicate behind the jobs tab filter, the tab counters, and the
  // failed-jobs attention count: one definition keeps filter/count semantics
  // identical by construction (C052).
  const jobMatchesTab = useCallback((j: JobRecord, tab: JobTab): boolean => {
    if (tab === "all") return true;
    const st = jobStatus(j).toLowerCase();
    const outcome = deriveOutcome(st, String(j.error ?? ""));
    if (tab === "in_flight") return st === "claimed" || st === "printing";
    if (tab === "queued") return st === "queued";
    if (tab === "unassigned") {
      const dest = String(j.destination ?? "");
      const pid = jobPrinterId(j);
      return dest === "unassigned" || pid === "unassigned" || !physicalPrinters.some((p) => p.id === pid);
    }
    if (tab === "delivered") return st === "success";
    // Only explicit unknown jobs and terminal ambiguous failures need
    // duplicate-print review. Claimed, printing and success belong in their
    // own progress/delivered tabs rather than Unknown.
    if (tab === "unknown") return st === "unknown" || ((st === "failed" || st === "expired") && outcome === "unknown");
    if (tab === "failed") return st === "failed" && outcome === "not_printed";
    if (tab === "expired") return st === "expired" && outcome !== "unknown";
    return true;
  }, [physicalPrinters]);

  const pendingJobs = jobs.filter((j) => ["queued", "claimed"].includes(jobStatus(j))).length;
  // Attention-worthy failures mirror the Failed + Expired tabs exactly, so
  // the banner count and the tab counters can never disagree (C052).
  const failedJobs = jobs.filter((j) => jobMatchesTab(j, "failed") || jobMatchesTab(j, "expired")).length;
  const fleetAgents = (health as { agents?: { total?: number; online?: number } } | null)?.agents;
  // /api/health deliberately reports liveness only. Fabricating 0/0 here lied
  // to operators; absent data renders as an explicit dash instead.
  const fleetTotal: number | null = fleetAgents ? Number(fleetAgents.total ?? 0) : null;
  const fleetOnline: number | null = fleetAgents ? Number(fleetAgents.online ?? 0) : null;
  const queuePrinter = physicalPrinters.find((pp) => pp.id === jobPrinterFilter);
  const printerFilterName = queuePrinter ? printerDisplayName(queuePrinter, locale) : jobPrinterFilter ? t("printer.presentation.unnamed") : "";

  const filteredPrinters = useMemo(() => {
    let list = physicalPrinters;
    if (printersFilter) {
      const q = printersFilter.toLowerCase();
      list = list.filter(
        (p) =>
          printerDisplayName(p, locale).toLowerCase().includes(q) ||
          ((p.connection_type || p.connectionType) || "").toLowerCase().includes(q) ||
          ((p.printer_type || p.printerType) || "").toLowerCase().includes(q) ||
          printerEndpoint(p).toLowerCase().includes(q)
      );
    }
    list = list.filter((p) => statusFilter === "saved" ? !isMainInventoryPrinter(p) : isMainInventoryPrinter(p));
    if (statusFilter !== "all" && statusFilter !== "saved") {
      list = list.filter((p) => printerPresentation(p, undefined, nowMs).state === statusFilter);
    }
    return [...list].sort((a, b) => printerDisplayName(a, locale).localeCompare(printerDisplayName(b, locale), locale));
  }, [physicalPrinters, printersFilter, statusFilter, nowMs, locale]);

  const jobsFiltered = useMemo(() => {
    let list = jobs;
    if (jobPrinterFilter) {
      const target = (physicalPrinters.find((pp) => pp.id === jobPrinterFilter)?.name || "").toLowerCase();
      list = list.filter((j) => {
        const pid = jobPrinterId(j);
        return (
          pid === jobPrinterFilter ||
          (!!target && String(j.printerName ?? "").toLowerCase() === target)
        );
      });
    }
    if (jobTab !== "all") {
      list = list.filter((j) => jobMatchesTab(j, jobTab));
    }
    if (jobSearch) {
      const q = jobSearch.trim().toLowerCase();
      list = list.filter(
        (j) =>
          jobId(j).toLowerCase().includes(q) ||
          jobDocType(j).toLowerCase().includes(q) ||
          jobPrinterId(j).toLowerCase().includes(q)
      );
    }
    return list;
  }, [jobs, jobTab, jobSearch, jobPrinterFilter, physicalPrinters]);

  const jobCounts = useMemo(
    () => ({
      all: jobs.length,
      in_flight: jobs.filter((j) => jobMatchesTab(j, "in_flight")).length,
      queued: jobs.filter((j) => jobMatchesTab(j, "queued")).length,
      unassigned: jobs.filter((j) => jobMatchesTab(j, "unassigned")).length,
      delivered: jobs.filter((j) => jobMatchesTab(j, "delivered")).length,
      unknown: jobs.filter((j) => jobMatchesTab(j, "unknown")).length,
      failed: jobs.filter((j) => jobMatchesTab(j, "failed")).length,
      expired: jobs.filter((j) => jobMatchesTab(j, "expired")).length,
    }),
    [jobs, jobMatchesTab]
  );

  const nav: NavItem[] = [
    { id: "dashboard", label: t("v4.experience.home"), icon: LayoutDashboard },
    { id: "printers", label: t("desktop.nav.printers"), icon: PrinterIcon },
    { id: "jobs", label: t("v4.experience.activity"), icon: ClipboardList },
    { id: "settings", label: t("desktop.nav.settings"), icon: SettingsIcon },
  ];

  // Headings carry no subtitle where the panels already state their content.
  // The two that remain answer a question the operator cannot read off screen:
  // whose Agent this is, and what is configured here.
  const pageMeta: Record<Page, { title: string; subtitle?: string }> = {
    dashboard: { title: t("v4.experience.home") },
    printers: { title: t("desktop.nav.printers") },
    jobs: { title: t("v4.experience.activity") },
    settings: { title: t("desktop.nav.settings"), subtitle: t("desktop.page.settingsSubtitle") },
  };

  // Selections resolve by stable ID against refreshed state: a drawer must
  // never present a superseded snapshot after the lists change. Gateway rows
  // win over local discovery rows for the same ID (they carry lifecycle and
  // management source). A selection with no live row resolves to null —
  // explicit missing handling instead of a stale drawer.
  const resolvedSelectedPrinter = selectedPrinterSnapshot
    ? physicalPrinters.find((p) => p.id === selectedPrinterSnapshot.id)
      ?? discoveredPrinters.find((p) => p.id === selectedPrinterSnapshot.id)
      ?? null
    : null;
  const selectedPrinter = resolvedSelectedPrinter;
  const selectedPrinterView = selectedPrinter ? printerPresentation(selectedPrinter, undefined, nowMs) : null;
  const resolvedSelectedJob = selectedJobSnapshot
    ? jobs.find((j) => jobId(j) === jobId(selectedJobSnapshot)) ?? null
    : null;
  const selectedJob = resolvedSelectedJob;
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
    restartAgent: () => setConfirmRestart(true),
    gatewayUrl: savedGatewayUrl,
    gatewayDraftUrl: gatewayUrl,
    setGatewayDraftUrl: (value: string) => { setGw(value); setGatewayDraftError(null); },
    checkedGatewayUrl,
    gatewayDraftMatchesSaved,
    gatewayDraftError,
    health,
    healthError,
    gatewayConnected,
    gatewayChecking,
    checkHealth,
    retrySavedGateway,
    pairingConfirmed: pairedOrigin === savedGatewayUrl && !!savedGatewayUrl,
    pairCode,
    setPairCode,
    pair,
    printers: physicalPrinters,
    gatewayPrinters: undefined,
    discoveredPrinters,
    localPrinters,
    localPrintersLoading,
    localPrintersError,
    localInventoryReady,
    canManagePrinterVisibility: isTauri && isAdmin === true,
    availabilityPendingPrinterIds,
    availabilityErrors,
    refreshLocalPrinters,
    handlePrinterVisibility,
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
    nowMs,
    refreshPrinters: () => { void refreshPrinters(); },
    handleDiscover,
    showAdd,
    setShowAdd,
    selectedPrinter: resolvedSelectedPrinter,
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
    selectedJob: resolvedSelectedJob,
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

  if (isTauri && isAdmin === null) {
    return <div className="min-h-screen bg-app text-ink" />;
  }

  if (isTauri && isAdmin === false) {
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="admin-gate-title"
        aria-describedby="admin-gate-body"
        className="flex min-h-screen flex-col bg-app text-ink"
      >
        <div className="flex items-center justify-end gap-2 p-4">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-2xl border border-edge bg-surface p-7 shadow-xl">
            <div className="flex flex-col items-center text-center">
              <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-edge bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="./brand/print-agent.svg" alt="" aria-hidden="true" draggable={false} className="h-10 w-10" />
                <span className="absolute -bottom-1.5 -end-1.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface bg-warn text-white">
                  <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              <StatusBadge tone="warn" label={t("desktop.adminGate.badge")} />
              <h1 id="admin-gate-title" className="mt-4 text-xl font-semibold text-ink">
                {t("desktop.adminGate.title")}
              </h1>
              <p id="admin-gate-body" className="mt-2.5 text-sm leading-relaxed text-ink-2">
                {t("desktop.adminGate.body")}
              </p>
              <p className="mt-3 rounded-lg border border-edge-subtle bg-surface-2 px-3.5 py-2.5 text-xs leading-relaxed text-ink-3">
                {t("desktop.adminGate.hint")}
              </p>
              {adminError && (
                <div role="alert" className="mt-3 w-full rounded-lg border border-bad/35 bg-bad/10 px-3.5 py-2.5 text-xs text-bad">
                  {adminError}
                </div>
              )}
              <div className="mt-6 flex w-full flex-col gap-2.5">
                <Button
                  variant="primary"
                  loading={adminRelaunching}
                  icon={<ShieldAlert className="h-5 w-5" />}
                  className="w-full justify-center"
                  onClick={async () => {
                    setAdminRelaunching(true);
                    setAdminError(null);
                    try {
                      await relaunchAsAdmin();
                    } catch {
                      setAdminError(t("desktop.adminGate.relaunchFailed"));
                      setAdminRelaunching(false);
                    }
                  }}
                >
                  {t("desktop.adminGate.relaunch")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={adminRelaunching}
                  icon={<LogOut className="h-4 w-4" />}
                  className="w-full justify-center"
                  onClick={() => { void closeApp().catch(() => {}); }}
                >
                  {t("desktop.adminGate.close")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tg-shell-root min-h-screen bg-app text-ink">
      <Sidebar
        page={page}
        navigate={navigate}
        items={nav}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        gatewayConnected={gatewayConnected}
        gatewayUrl={savedGatewayUrl || gatewayUrl}
        isOnline={isOnline}
        serviceState={serviceState}
        version={version}
        lastStatusCheck={lastStatusCheck}
      />
      <div
        className={`flex min-h-screen min-w-0 flex-col transition-[padding] duration-200 ${collapsed ? "lg:ps-[calc(var(--sidebar-collapsed)+0.75rem)]" : "lg:ps-[calc(var(--sidebar-width)+0.75rem)]"}`}
      >
        <header className="tg-desktop-topbar tg-desktop-header sticky top-2 z-20 mx-2 mb-2 mt-2 flex min-h-16 min-w-0 items-center gap-2 px-3 py-2 sm:top-3 sm:mx-3 sm:mt-3 sm:gap-3 sm:px-5 lg:mx-3 lg:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label={t("desktop.app.openNavigation")}
            title={t("desktop.app.openNavigation")}
            aria-expanded={sidebarOpen}
            aria-controls="desktop-mobile-nav"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-edge bg-surface text-ink-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <h1 className="tg-desktop-header-title min-w-0 flex-1 break-words text-4xl font-medium leading-snug tracking-tight text-ink">{pageMeta[page].title}</h1>
          <div className="tg-desktop-header-actions flex shrink-0 items-center gap-1 sm:gap-2">
            <span className="inline-flex sm:hidden" role="status" aria-live="polite" title={serviceLabel} aria-label={serviceLabel}>
              <StatusDot tone={serviceTone} pulse={isOnline} />
            </span>
            <span className="hidden sm:inline-flex"><StatusBadge tone={serviceTone} label={serviceLabel} /></span>
            <button type="button" onClick={() => { setNavSearchQuery(""); setNavSearchOpen(true); }}
              aria-label={t("common.search")} title={t("common.search")}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-edge bg-surface text-ink-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
              <Search className="h-5 w-5" aria-hidden />
            </button>
            <div className="hidden items-center gap-1 sm:flex">
              <Button variant="ghost" onClick={() => { refreshStatus(); refreshPrinters(); if (savedGatewayUrl) void refreshJobs(); }}
                icon={<RefreshCw className="h-5 w-5" />} aria-busy={printersLoading || localPrintersLoading} aria-label={t("desktop.app.refreshAll")} title={t("desktop.app.refreshAll")}>
                <span className="hidden xl:inline">{t("desktop.app.refresh")}</span>
              </Button>
              <LanguageSwitcher />
              <ThemeToggle />
            </div>
            <div className="sm:hidden">
              <ActionMenu
                label={t("common.actions")}
                align="end"
                placement="below"
                trigger={
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2">
                    <MoreHorizontal className="h-5 w-5" aria-hidden />
                  </span>
                }
                items={[
                  { key: "refresh", label: t("desktop.app.refreshAll"), icon: <RefreshCw className="h-4 w-4" />, onSelect: () => { refreshStatus(); refreshPrinters(); if (savedGatewayUrl) void refreshJobs(); } },
                  { key: "theme", label: t("nav.toggleTheme"), icon: <Moon className="h-4 w-4" />, onSelect: toggleTheme, separatorBefore: true },
                  ...(["en", "ar"] as const).map((code) => ({
                    key: `locale-${code}`,
                    label: LOCALE_LABELS[code],
                    icon: <Globe2 className="h-4 w-4" />,
                    disabled: locale === code,
                    onSelect: () => setLocale(code),
                  })),
                ]}
              />
            </div>
          </div>
        </header>
        <Modal open={navSearchOpen} onClose={() => setNavSearchOpen(false)} title={t("common.search")}>
          <div className="space-y-3">
            <label htmlFor="desktop-nav-search" className="sr-only">{t("common.search")}</label>
            <input id="desktop-nav-search" value={navSearchQuery}
              onChange={(event) => setNavSearchQuery(event.target.value)}
              placeholder={t("common.search")}
              className="h-11 w-full rounded-lg border border-edge bg-surface-2 px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/35" />
            <nav className="space-y-1" aria-label={t("nav.consoleNavigation")}>
              {nav.filter(item => item.label.toLowerCase().includes(navSearchQuery.trim().toLowerCase())).map(item => {
                const Icon = item.icon;
                return <button key={item.id} type="button" onClick={() => { setNavSearchOpen(false); navigate(item.id); }}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-sm text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">
                  <Icon className="h-4 w-4 shrink-0" />{item.label}
                </button>;
              })}
            </nav>
          </div>
        </Modal>

        {isAdmin === true && agentStartupGraceElapsed && serviceState === "stopped" && (
          <div
            className="flex flex-col gap-3 border-b border-warn-edge bg-warn-bg px-5 py-3 text-sm text-warn sm:flex-row sm:items-center sm:justify-between lg:px-8"
            role="alert"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                <strong>{t("desktop.app.agentNeedsStartTitle")}</strong>{" "}
                {t("desktop.app.agentNeedsStartBody")}
              </span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={startAgent}
              loading={busy}
              disabled={busy}
              icon={<Play className="h-3.5 w-3.5" />}
              className="shrink-0"
            >
              {t("desktop.app.startAgentNow")}
            </Button>
          </div>
        )}

        <main className="w-full min-w-0 max-w-full flex-1 px-3 py-5 sm:px-5 sm:py-7 lg:px-8 lg:py-8">
          <div key={page} className="tg-view-reveal mx-auto w-full max-w-[1680px]">
          {page === "dashboard" && <OverviewPage s={state} />}
          {page === "printers" && <PrintersPage s={state} />}
          {page === "jobs" && <JobsPage s={state} />}
          {page === "settings" && <SettingsPage s={state} />}
          </div>
        </main>
      </div>

      <AddPrinterDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onSuccess={() => {
          refreshPrinters();
          setMsg({ text: t("desktop.app.printerAdded"), type: "success" });
        }}
        printers={mergePrinterInventories(discoveredPrinters, localPrinters)}
        onDiscoverRequest={handleDialogDiscover}
      />

      <Modal open={confirmRestart} onClose={() => setConfirmRestart(false)} title={t("v4.experience.restart.title")}
        footer={<><Button variant="secondary" onClick={() => setConfirmRestart(false)}>{t("common.cancel")}</Button><Button variant="danger" disabled={busy} onClick={() => { setConfirmRestart(false); void restartAgent(); }}>{t("desktop.agents.restart")}</Button></>}>
        <p className="text-sm leading-relaxed text-ink-2">{t("v4.experience.restart.body")}</p>
      </Modal>
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
              loading={busy}
              disabled={busy}
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
        description={selectedPrinter ? printerDisplayName(selectedPrinter, locale) : undefined}
      >
        {selectedPrinter && selectedPrinterView && (
          <div className="space-y-6">
            <div className="flex items-center gap-3 rounded-md border border-edge bg-surface-2 px-4 py-4">
              <StatusDot tone={selectedPrinterView.tone} />
              <span className="text-lg font-semibold text-ink">
                {t(selectedPrinterView.labelKey)}
              </span>
              <span className="ms-auto text-sm text-ink-3">
                {humanType(selectedPrinter, locale)}
              </span>
            </div>
            <p className="text-sm text-ink-3">{t(selectedPrinterView.reasonKey)}</p>
            <PrinterAvailabilityControl s={state} printer={selectedPrinter} />
            <PrinterVerificationDetails printer={selectedPrinter} />
            <PrinterGeometryDetails printer={selectedPrinter} managerHint />
            <details className="rounded-md border border-edge px-4 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35">{t("printer.presentation.details")}</summary>
            <div className="mt-3 divide-y divide-edge">
              <MetaRow label={t("desktop.drawer.name")}>
                <span className="block truncate">{printerDisplayName(selectedPrinter, locale)}</span>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.connection")}>{humanConnection(selectedPrinter, locale)}</MetaRow>
              <MetaRow label={t("desktop.drawer.protocol")}>{selectedPrinter.protocol ? <span dir="ltr" className="font-mono [unicode-bidi:isolate]">{selectedPrinter.protocol}</span> : "—"}</MetaRow>
              <MetaRow label={t("desktop.drawer.address")}>
                <Mono>{printerEndpoint(selectedPrinter)}</Mono>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.stableId")}>
                <Mono>{selectedPrinter.id}</Mono>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.lifecycle")}>{lifecycleLabel(t, selectedPrinter.lifecycle)}</MetaRow>
              <MetaRow label={t("common.status")}>{labelPrinter(printerDisplayStatus(selectedPrinter, nowMs), locale)}{printerIsStale(selectedPrinter, nowMs) ? <StatusBadge tone="warn" label={t("status.stale")} /> : null}</MetaRow>
              <MetaRow label={t("printer.presentation.reportedStatus")}><Mono>{selectedPrinter.reportedStatus || selectedPrinter.status}</Mono></MetaRow>
              <MetaRow label={t("agent.lastSeen")}><span className="tabular-nums">{selectedPrinter.lastSeenAt ? formatDateTime(selectedPrinter.lastSeenAt) : "—"}</span></MetaRow>
              {selectedPrinter.localObservedAt != null && <MetaRow label={t("desktop.printers.localObservation")}><span className="tabular-nums">{formatDateTime(new Date(selectedPrinter.localObservedAt).toISOString())}</span></MetaRow>}
              {printerStatusDetail(selectedPrinter, locale) && <MetaRow label={t("printer.presentation.diagnostic")}>{printerStatusDetail(selectedPrinter, locale)}</MetaRow>}
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
                <span className="tabular-nums">{selectedPrinter.agentLastSeenAt ? formatDateTime(selectedPrinter.agentLastSeenAt) : "—"}</span>
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
            </details>
            <div className="flex min-w-0 flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setJobPrinterFilter(selectedPrinter.id);
                  setJobTab("all");
                  setJobSearch("");
                  setSelectedPrinter(null);
                  navigate("jobs");
                }}
                icon={<ClipboardList className="h-4 w-4" />}
              >
                {t("desktop.drawer.viewJobs")}
              </Button>
            </div>
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
                label={labelJob(jobStatus(selectedJob), selectedJob.error, locale, selectedJob)}
              />
              {selectedJob.outputMedium !== "file" && <JobTimeline
                status={jobStatus(selectedJob)}
                error={selectedJob.error ? String(selectedJob.error) : null}
                claimedAt={selectedJob.claimedAt ? String(selectedJob.claimedAt) : null}
                deliveredAt={selectedJob.deliveredAt ? String(selectedJob.deliveredAt) : null}
                ackedAt={selectedJob.ackedAt ? String(selectedJob.ackedAt) : null}
              />}
            </div>
            <div className="divide-y divide-edge">
              <MetaRow label={t("desktop.drawer.jobId")}>
                <Mono>{jobId(selectedJob)}</Mono>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.printer")}>
                <span className="block truncate">
                  {String(
                    physicalPrinters.find((p) => p.id === jobPrinterId(selectedJob))?.name ||
                      jobPrinterId(selectedJob) ||
                      "—"
                  )}
                </span>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.destination")}>
                <span dir={jobDestination(selectedJob) ? "ltr" : undefined} className="block truncate text-start [unicode-bidi:isolate]">{jobDestination(selectedJob) || "—"}</span>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.retries")}><span className="tabular-nums">{String(selectedJob.retries ?? 0)}</span></MetaRow>
              <MetaRow label={t("desktop.drawer.created")}>
                <span className="tabular-nums">{formatDateTime(jobTimestamp(selectedJob, "createdAt"))}</span>
              </MetaRow>
              <MetaRow label={t("desktop.drawer.updated")}>
                <span className="tabular-nums">{formatDateTime(jobTimestamp(selectedJob, "updatedAt"))}</span>
              </MetaRow>
            </div>
            {selectedJob.outputMedium !== "file" && (selectedJob.error ? (
              <div className={`rounded-md border p-4 ${jobStatus(selectedJob).toLowerCase() === "success" ? "border-info-edge bg-info-bg" : "border-bad-edge bg-bad-bg"}`}>
                {(() => {
                  const selectedJobStatus = jobStatus(selectedJob).toLowerCase();
                  const outcome = deriveOutcome(selectedJobStatus, String(selectedJob.error));
                  const succeeded = selectedJobStatus === "success";
                  const canceled = selectedJobStatus === "canceled";
                  const reconciledSuccess = succeeded && /^LATE_SUCCESS(?:_POST_EXPIRATION)?:/.test(String(selectedJob.error));
                  // A success row can still carry a residual error (for example
                  // the Gateway's "LATE_SUCCESS: ..." note). Its physical outcome
                  // is still unverified, but it is NOT an ambiguous failure, so
                  // it must not render the "outcome unknown" banner — nor the
                  // "Print failed" verdict (C039).
                  const unknown = !succeeded && !canceled && (selectedJobStatus === "unknown" || outcome === "unknown");
                  const classified = jobFailurePresentation(String(selectedJob.error), locale);
                  return (
                    <>
                      <div className={`flex items-center gap-2 text-md font-semibold ${succeeded ? "text-info" : unknown ? "text-warn" : canceled ? "text-ink-2" : "text-bad"}`}>
                        <AlertTriangle className="h-5 w-5" aria-hidden />
                        {reconciledSuccess || canceled ? labelJob(selectedJobStatus, selectedJob.error, locale, selectedJob) : succeeded
                          ? (classified?.title ?? t("desktop.drawer.printSucceeded"))
                          : (classified?.title ?? (unknown ? t("desktop.drawer.outcomeUnknown") : t("desktop.drawer.printFailed")))}
                      </div>
                      <p className="mt-2 text-base leading-relaxed text-ink-2">
                        {reconciledSuccess ? jobGuidance(selectedJobStatus, outcome, locale) : classified?.guidance ?? friendlyPrinterError(String(selectedJob.error), locale)}
                      </p>
                      {!unknown && !succeeded && !canceled && (
                        <p className="mt-3 text-sm text-ink-3">
                          {t("desktop.drawer.failedBeforePrinting")}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-info-edge bg-info-bg px-4 py-4 text-base text-info">
                <Info className="h-5 w-5 flex-shrink-0" aria-hidden />
                {jobGuidance(jobStatus(selectedJob), deriveOutcome(jobStatus(selectedJob), null), locale) ||
                  t("desktop.drawer.noErrorRecorded")}
              </div>
            ))}
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
