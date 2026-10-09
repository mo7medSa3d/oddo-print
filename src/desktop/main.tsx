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
  probeGatewayHealth,
  fetchGatewayJobs,
  getAgentStatus,
  getAppVersion,
  getAutostart,
  isRunningAsAdmin,
  relaunchAsAdmin,
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
  getManagerSession,
  loginManager,
  logoutManager,
  onManagerAuthChanged,
  restartAgent as ipcRestartAgent,
  setGatewayUrl,
  startAgent as ipcStartAgent,
  stopAgent as ipcStopAgent,
  normalizeGatewayUrl,
  discoverPrinters,
  testGatewayPrinter,
  setAutostart,
  setTrayLocale,
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
  printerHealthCounts,
  printerEndpoint,
  printerIsStale,
  printerTone,
  jobTimeMs,
  jobTimestamp,
} from "./lib/printers";
import { DiagnosticOperations, diagnosticScope, diagnosticMessageKey, diagnosticMessageType } from "../shared/diagnostic-test";
import { generateIdempotencyKey } from "../lib/idempotency";
import type {
  AgentStatusView,
  DesktopState,
  JobRecord,
  JobTab,
  ManagerAccountView,
  Page,
  PrinterStatusFilter,
  ToastMessage,
} from "./types";
import "../app/globals.css";
import { I18nProvider, useI18n } from "../i18n/react";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, resolveLocale, type Locale } from "../i18n/config";
import {
  emptyGatewayConnectivityEvidence,
  noteGatewayConnectivityFailure,
  noteGatewayConnectivitySuccess,
  type GatewayConnectivityEvidence,
} from "./lib/gateway-connectivity";
/* Desktop Manager uses the shared light/dark theme tokens. */
import "./theme-light.css";

const PAGES: Page[] = ["dashboard", "printers", "jobs", "agents", "settings"];
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
  const { t, locale, formatDateTime } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    void setTrayLocale(locale).catch((error) => {
      console.warn("Could not synchronize tray locale:", error);
    });
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
  const jobsGeneration = useRef(0);
  const healthGeneration = useRef(0);
  const gatewayProbeFlightRef = useRef<string | null>(null);
  const gatewayConnectivityRef = useRef<GatewayConnectivityEvidence>(emptyGatewayConnectivityEvidence());
  const configurationFlight = useRef(false);
  const [pairCode, setPairCode] = useState("");
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
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [adminDismissed, setAdminDismissed] = useState<boolean>(false);
  const [agentStartupGraceElapsed, setAgentStartupGraceElapsed] = useState(false);
  const busyRef = useRef(false);
  // One synchronous operation owner: uncertain Gateway outcomes preserve the
  // key across retries, scoped to a verified Manager actor and saved origin.
  const diagnosticOps = useRef(new DiagnosticOperations(generateIdempotencyKey));
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

  // A Gateway probe proves connectivity, not an authenticated Manager. Never
  // infer a Manager role from Agent pairing or from a locally cached JWT.
  const [managerAccount, setManagerAccount] = useState<ManagerAccountView>({
    origin: "", status: "unconfigured", session: null,
  });
  const managerProbeSeq = useRef(0);
  const probeManagerAccount = useCallback(async (origin: string): Promise<void> => {
    const generation = ++managerProbeSeq.current;
    if (!origin) {
      setManagerAccount({ origin: "", status: "unconfigured", session: null });
      return;
    }
    setManagerAccount({ origin, status: "checking", session: null });
    try {
      const session = await getManagerSession(origin);
      if (generation !== managerProbeSeq.current || savedOriginRef.current !== origin) return;
      setManagerAccount({ origin, status: session.authenticated ? "authenticated" : "signed-out",
        session: session.authenticated ? session : null });
    } catch {
      // A transient identity-check failure is NOT proof that the user signed
      // out. Fail closed for privileged controls and expose a retry in Settings.
      if (generation !== managerProbeSeq.current || savedOriginRef.current !== origin) return;
      setManagerAccount({ origin, status: "unavailable", session: null });
    }
  }, []);
  useEffect(() => {
    const origin = savedGatewayUrl;
    const stop = onManagerAuthChanged(() => { void probeManagerAccount(origin); });
    void probeManagerAccount(origin);
    return () => { managerProbeSeq.current++; stop(); };
  }, [savedGatewayUrl, probeManagerAccount]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const managerAuthenticated = managerAccount.origin === savedGatewayUrl &&
    !!savedGatewayUrl && managerAccount.status === "authenticated" &&
    managerAccount.session?.authenticated === true &&
    !!managerAccount.session.tenantId && !!managerAccount.session.role &&
    !!managerAccount.session.expiresAt &&
    Date.parse(managerAccount.session.expiresAt) > nowMs;
  const managerRole = managerAuthenticated ? managerAccount.session?.role : undefined;
  const managerCanTest = managerRole === "owner" || managerRole === "admin" || managerRole === "operator";
  const managerCanManage = managerRole === "owner" || managerRole === "admin";
  useEffect(() => {
    if (!managerCanManage) { setShowAdd(false); setEditingPrinter(null); }
  }, [managerCanManage]);
  const managerActorScope = managerAuthenticated
    ? `${managerAccount.session!.tenantId}:${managerAccount.session!.userId ?? "legacy"}:${managerRole}`
    : "unauthenticated";

  const managerLogin = useCallback(async (username: string, password: string) => {
    const origin = savedGatewayUrl;
    if (!origin || savedOriginRef.current !== origin) throw new Error("Gateway origin is not configured");
    const session = await loginManager(origin, username, password);
    // Cross-origin configuration changes invalidate the attempted login;
    // never relabel that credential as belonging to the new Gateway.
    if (savedOriginRef.current !== origin || !session.authenticated || !session.tenantId) {
      throw new Error("Manager session changed while signing in");
    }
    ++managerProbeSeq.current;
    setManagerAccount({ origin, status: "authenticated", session });
  }, [savedGatewayUrl]);
  const managerLogout = useCallback(async () => {
    const origin = savedGatewayUrl;
    if (!origin) return;
    try {
      await logoutManager(origin);
    } finally {
      ++managerProbeSeq.current;
      if (savedOriginRef.current === origin) {
        setManagerAccount({ origin, status: "signed-out", session: null });
      }
    }
  }, [savedGatewayUrl]);
  const managerRefresh = useCallback(() => { void probeManagerAccount(savedGatewayUrl); },
    [savedGatewayUrl, probeManagerAccount]);
  const managerAuthorityError = useCallback((permission: "test" | "manage") => {
    setMsg({ text: t(managerAuthenticated ? "desktop.manager.roleDenied" : "desktop.manager.requireSignIn"), type: "error" });
    navigate("settings");
  }, [managerAuthenticated, navigate, t]);
  const requestAddPrinter = useCallback((open: boolean) => {
    if (open && !managerCanManage) { managerAuthorityError("manage"); return; }
    setShowAdd(open);
  }, [managerCanManage, managerAuthorityError]);

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
      service: "yaseir-print-gateway",
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
      observeGatewaySuccess(savedGatewayUrl);
      setPrinters(list.filter(isProductionPrinter));
      return true;
    } catch (e) {
      if (!current()) return false;
      setPrintersError(friendlyPrinterError(errMsg(e), locale));
      return false;
    } finally {
      if (current()) setPrintersLoading(false);
    }
  }, [savedGatewayUrl, t, locale, observeGatewaySuccess]);

  const refreshJobs = useCallback(async (options?: { status?: string; search?: string; limit?: number; printerId?: string; merge?: boolean }) => {
    if (!savedGatewayUrl) return;
    const generation = ++jobsGeneration.current;
    const current = () => generation === jobsGeneration.current && savedOriginRef.current === savedGatewayUrl;
    setJobsLoading(true);
    try {
      const data = await fetchGatewayJobs(savedGatewayUrl, options);
      if (!current()) return;
      observeGatewaySuccess(savedGatewayUrl);
      const rows = Array.isArray(data) ? data : [];
      if (options?.merge) {
        // Filtered fetch supplements the snapshot instead of replacing it:
        // server-matched older jobs merge in so local search/tabs cannot
        // hide them, while unrelated snapshot rows (counts, overview) stay.
        // The union is trimmed newest-first so memory stays bounded.
        setJobs((prev) => {
          const byId = new Map(prev.map((j) => [jobId(j), j] as const));
          for (const j of rows) byId.set(jobId(j), j);
          const union = [...byId.values()];
          union.sort((a, b) => jobTimeMs(b) - jobTimeMs(a));
          return union.slice(0, 400);
        });
      } else {
        setJobs(rows);
      }
      setJobsError(null);
    } catch (e: unknown) {
      if (!current()) return;
      setJobs([]);
      const status = Number((e as { status?: number })?.status ?? 0);
      setJobsError(
        status === 401 || status === 403
          ? t("desktop.app.gatewayJobAccessUnavailable")
          : friendlyGatewayError(e, locale)
      );
    } finally {
      if (current()) setJobsLoading(false);
    }
  }, [savedGatewayUrl, t, locale, observeGatewaySuccess]);

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
        savedOriginRef.current = durable;
        setSavedGatewayUrl(durable);
        let normalizedDurable = "";
        try { normalizedDurable = normalizeGatewayUrl(durable); } catch { /* invalid durable state stays non-matching */ }
        if (normalizedDurable !== target) throw saveError;
        saveWarning = t("desktop.app.gatewaySavedAfterReconcile");
      }

      // The candidate is now both positively observed and durably selected.
      // Update the renderer even if the native config-change event was lost.
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
  }, [gatewayUrl, t, locale, observeGatewayFailure, observeGatewaySuccess, savedOriginMatches]);

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
    if (!managerCanManage) { managerAuthorityError("manage"); return; }
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
  }, [savedGatewayUrl, refreshPrinters, setBusyBoth, t, locale, managerCanManage, managerAuthorityError]);

  const handleTest = useCallback(
    async (id: string) => {
      if (!managerCanTest) { managerAuthorityError("test"); return; }
      if (!savedGatewayUrl) {
        setMsg({ text: t("desktop.app.gatewayUrlMissing"), type: "error" });
        return;
      }
      const scope = diagnosticScope(savedGatewayUrl, managerActorScope, id);
      if (diagnosticOps.current.observed(scope)) {
        if (!window.confirm(t("diagnostic.repeatConfirm"))) return;
        diagnosticOps.current.confirmRepeat(scope);
      }
      const key = diagnosticOps.current.begin(scope);
      if (!key) return; // same-tick or overlapping UI calls share one owner
      try {
        setBusyBoth(true);
        const result = await testGatewayPrinter(savedGatewayUrl, id, key);
        diagnosticOps.current.accept(scope, result);
        setMsg({
          text: t(diagnosticMessageKey(result), { printer: "" }),
          type: diagnosticMessageType(result) === "ok" ? "success" : "error",
        });
        if (result.jobId) void refreshJobs();
      } catch (e) {
        // HTTP errors, JSON errors and transport loss are all inconclusive
        // about a prior committed job. Keep the identical key for retry.
        diagnosticOps.current.uncertain(scope);
        const status = (e as { status?: unknown } | null)?.status;
        setMsg({
          text: status === 401 ? t("diagnostic.authRequired") :
                status === 403 ? t("diagnostic.permissionDenied") :
                status === 429 ? friendlyPrinterError(errMsg(e), locale) :
                t("diagnostic.admissionUnknown"),
          type: "error",
        });
      } finally {
        diagnosticOps.current.uncertain(scope);
        setBusyBoth(false);
      }
    },
    [savedGatewayUrl, managerCanTest, managerActorScope, managerAuthorityError, refreshJobs, setBusyBoth, t, locale]
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
      if (isAdmin === false) setAdminDismissed(false);
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth, t, locale, isAdmin]);

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
      if (isAdmin === false) setAdminDismissed(false);
      setMsg({ text: friendlyAgentError(errMsg(e), locale), type: "error" });
    } finally {
      setBusyBoth(false);
    }
  }, [refreshStatus, setBusyBoth, t, locale, isAdmin]);

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
    // Elevated startup may start/repair the Windows service on a background
    // thread. Give that privileged startup a short grace period before showing
    // the separate elevated "Agent stopped" recovery banner. Unelevated
    // launches do not auto-start the Agent and use the Administrator dialog
    // as soon as the first local status observation arrives.
    const timer = window.setTimeout(() => {
      setAgentStartupGraceElapsed(true);
      void refreshStatus();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [refreshStatus]);

  useEffect(() => {
    if (!isTauri) return;
    getAppVersion()
      .then(setVersion)
      .catch(() => {});
    getGatewayUrl()
      .then((v) => {
        let canonical = v;
        try { canonical = normalizeGatewayUrl(v); } catch { /* keep invalid persisted value visible for repair */ }
        savedOriginRef.current = canonical;
        gatewayConnectivityRef.current = emptyGatewayConnectivityEvidence(canonical);
        setGw(canonical);
        setSavedGatewayUrl(canonical);
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
      let canonicalUrl = url;
      try { canonicalUrl = normalizeGatewayUrl(url); } catch { /* preserve invalid value for visible repair */ }
      // The manager session is a bearer credential for ONE gateway origin.
      // Switching gateways must not send the old JWT to the new origin:
      // drop it (and stale per-gateway caches) before probing the new URL.
      void clearManagerSession();
      savedOriginRef.current = canonicalUrl;
      gatewayConnectivityRef.current = emptyGatewayConnectivityEvidence(canonicalUrl);
      ++printersGeneration.current; ++jobsGeneration.current; ++healthGeneration.current;
      setPrintersLoading(false); setJobsLoading(false);
      setPrintersError(null); setJobsError(null); setSelectedPrinter(null); setEditingPrinter(null); setSelectedJob(null); void refreshLocalPrinters();
      setSavedGatewayUrl(canonicalUrl);
      setGw(canonicalUrl);
      setJobs([]);
      setPrinters([]);
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
  }, [probeGateway, refreshStatus, refreshLocalPrinters, t]);

  // Affirmative observations only: an empty/missing health object, an agent
  // status without running:true, or a probe older than the freshness window
  // must read as unavailable — never as healthy/online (C046).
  // Gateway connectivity refreshes every 10s, but presentation is not tied to
  // a short freshness expiry. Confirmed negative evidence drives disconnect;
  // focus/online events force immediate probes after sleep or network changes.
  // Affirmative observations only: an empty/missing health object, an agent
  // status without running:true, or a probe older than the freshness window
  // must read as unavailable — never as healthy/online (C046).
  const isOnline =
    !!agentStatus && !(agentStatus as Record<string, unknown>).error && (agentStatus as { running?: boolean }).running === true;
  const agentServiceNeedsAdmin =
    isAdmin === false &&
    agentStatus !== null &&
    agentStatus.note_code !== "service_running";
  useEffect(() => {
    // Re-open the Administrator guidance when the Agent transitions from a
    // healthy Windows service to a missing/stopped/fallback state. Dismissing
    // the dialog remains respected while the same state is unchanged.
    if (agentServiceNeedsAdmin) setAdminDismissed(false);
  }, [agentServiceNeedsAdmin, agentStatus?.note_code]);

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
  const gatewaySubLabel = !savedGatewayUrl
    ? t("desktop.app.setGatewayUrlInSettings")
    : gatewayConnected
      ? t("desktop.settings.reachable")
      : t("desktop.app.failedLastCheckLong");
  const physicalPrinters = useMemo(() => printers.filter(isProductionPrinter), [printers]);
  const totalPrinters = physicalPrinters.length;
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
      return dest === "unassigned" || pid === "unassigned" || !printers.some((p) => p.id === pid);
    }
    if (tab === "delivered") return st === "success";
    // "Unknown outcome" must exclude success rows. deriveOutcome() reports
    // "unknown" for success by design (transport success is not proof of
    // paper), so a bare outcome check makes this tab a superset of
    // "Delivered" and inflates the counter. This mirrors the Gateway's own
    // marker-based status=unknown filter (src/app/api/jobs/route.ts) and
    // the guard inside jobTone (src/shared/job-vocabulary.ts).
    if (tab === "unknown") return st !== "success" && outcome === "unknown";
    if (tab === "failed") return st === "failed" && outcome === "not_printed";
    if (tab === "expired") return st === "expired" && outcome !== "unknown";
    return true;
  }, [printers]);

  const pendingJobs = jobs.filter((j) => ["queued", "claimed"].includes(jobStatus(j))).length;
  // Attention-worthy failures mirror the Failed + Expired tabs exactly, so
  // the banner count and the tab counters can never disagree (C052).
  const failedJobs = jobs.filter((j) => jobMatchesTab(j, "failed") || jobMatchesTab(j, "expired")).length;
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
      list = list.filter((p) => statusFilter === "stale" ? printerIsStale(p, nowMs) : printerDisplayStatus(p, nowMs) === statusFilter);
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [physicalPrinters, printersFilter, statusFilter, nowMs]);

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
      list = list.filter((j) => jobMatchesTab(j, jobTab));
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
    { id: "dashboard", label: t("desktop.nav.overview"), icon: LayoutDashboard },
    { id: "printers", label: t("desktop.nav.printers"), icon: PrinterIcon },
    { id: "jobs", label: t("desktop.nav.printJobs"), icon: ClipboardList },
    { id: "agents", label: t("desktop.nav.agents"), icon: Cpu },
    { id: "settings", label: t("desktop.nav.settings"), icon: SettingsIcon },
  ];

  // Headings carry no subtitle where the panels already state their content.
  // The two that remain answer a question the operator cannot read off screen:
  // whose Agent this is, and what is configured here.
  const pageMeta: Record<Page, { title: string; subtitle?: string }> = {
    dashboard: { title: t("desktop.nav.overview") },
    printers: { title: t("desktop.nav.printers") },
    jobs: { title: t("desktop.nav.printJobs") },
    agents: { title: t("desktop.nav.agents"), subtitle: t("desktop.page.agentsSubtitle") },
    settings: { title: t("desktop.nav.settings"), subtitle: t("desktop.page.settingsSubtitle") },
  };

  // Selections resolve by stable ID against refreshed state: a drawer must
  // never present a superseded snapshot after the lists change. Gateway rows
  // win over local discovery rows for the same ID (they carry lifecycle and
  // management source). A selection with no live row resolves to null —
  // explicit missing handling instead of a stale drawer.
  const resolvedSelectedPrinter = selectedPrinter
    ? printers.find((p) => p.id === selectedPrinter.id)
      ?? discoveredPrinters.find((p) => p.id === selectedPrinter.id)
      ?? null
    : null;
  const resolvedSelectedJob = selectedJob
    ? jobs.find((j) => jobId(j) === jobId(selectedJob)) ?? null
    : null;
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
    gatewayUrl: savedGatewayUrl,
    managerAccount,
    managerLogin,
    managerLogout,
    managerRefresh,
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
    nowMs,
    refreshPrinters,
    handleDiscover,
    handleTest,
    updatePrinterLifecycle,
    showAdd,
    setShowAdd: requestAddPrinter,
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

  return (
    <div className="min-h-screen bg-app text-ink">
      <AdminPrivilegeDialog
        open={agentServiceNeedsAdmin && !adminDismissed}
        onClose={() => setAdminDismissed(true)}
        onRelaunch={relaunchAsAdmin}
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
        gatewayUrl={savedGatewayUrl}
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
        <header className="sticky top-0 z-20 border-b border-edge/80 bg-surface/88 px-3 py-3 backdrop-blur-xl sm:px-4 lg:px-7">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setCollapsed(false);
                setSidebarOpen(true);
              }}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-edge bg-surface text-ink-2 transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden"
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
                        if (savedGatewayUrl) refreshJobs();
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

        {isAdmin === false && (
          <div
            className="flex items-center justify-between gap-3 border-b border-warn-edge bg-warn-bg px-5 py-3 text-sm text-warn lg:px-8"
            role="status"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                <strong>
                  {agentServiceNeedsAdmin
                    ? t("desktop.app.agentAdminRequiredTitle")
                    : t("desktop.app.readOnlyMode")}
                </strong>{" "}
                {agentServiceNeedsAdmin
                  ? t("desktop.app.agentAdminRequiredBody")
                  : t("desktop.app.readOnlyBody")}
              </span>
            </div>
            <button
              onClick={() => setAdminDismissed(false)}
              className="min-h-9 rounded-sm px-2 font-medium underline transition hover:text-warn/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/35 cursor-pointer"
            >
              {t("desktop.app.viewDetails")}
            </button>
          </div>
        )}

        {isAdmin === true && agentStartupGraceElapsed && agentStatus !== null && !isOnline && (
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
              disabled={busy}
              icon={<Play className="h-3.5 w-3.5" />}
              className="shrink-0"
            >
              {t("desktop.app.startAgentNow")}
            </Button>
          </div>
        )}

        <main className="w-full min-w-0 max-w-full flex-1 px-3 py-5 sm:px-5 sm:py-7 lg:px-8 lg:py-8">
          {page === "dashboard" && <OverviewPage s={state} />}
          {page === "printers" && <PrintersPage s={state} />}
          {page === "jobs" && <JobsPage s={state} />}
          {page === "agents" && <AgentsPage s={state} />}
          {page === "settings" && <SettingsPage s={state} />}
        </main>
      </div>

      <AddPrinterDialog
        open={showAdd && managerCanManage}
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
        open={!!editingPrinter && managerCanManage}
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
            <div className="flex items-center gap-3 rounded-md border border-edge bg-surface-2 px-4 py-4">
              <StatusDot tone={printerTone(printerDisplayStatus(selectedPrinter, nowMs))} />
              <span className="text-lg font-semibold text-ink">
                {labelPrinter(printerDisplayStatus(selectedPrinter, nowMs), locale)}
              </span>
              {printerIsStale(selectedPrinter, nowMs) ? <StatusBadge tone="warn" label={t("status.stale")} /> : null}
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
                  onClick={() => {
                    if (!managerCanManage) { managerAuthorityError("manage"); return; }
                    setEditingPrinter(selectedPrinter);
                  }}
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
                deliveredAt={selectedJob.deliveredAt ? String(selectedJob.deliveredAt) : null}
                ackedAt={selectedJob.ackedAt ? String(selectedJob.ackedAt) : null}
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
              <div className={`rounded-md border p-4 ${jobStatus(selectedJob) === "success" ? "border-info-edge bg-info-bg" : "border-bad-edge bg-bad-bg"}`}>
                {(() => {
                  const outcome = deriveOutcome(jobStatus(selectedJob), String(selectedJob.error));
                  const succeeded = jobStatus(selectedJob) === "success";
                  // A success row can still carry a residual error (for example
                  // the Gateway's "LATE_SUCCESS: ..." note). Its physical outcome
                  // is still unverified, but it is NOT an ambiguous failure, so
                  // it must not render the "outcome unknown" banner — nor the
                  // "Print failed" verdict (C039).
                  const unknown = !succeeded && outcome === "unknown";
                  const classified = jobFailurePresentation(String(selectedJob.error), locale);
                  return (
                    <>
                      <div className={`flex items-center gap-2 text-md font-semibold ${succeeded ? "text-info" : unknown ? "text-warn" : "text-bad"}`}>
                        <AlertTriangle className="h-5 w-5" aria-hidden />
                        {succeeded
                          ? (classified?.title ?? t("desktop.drawer.printSucceeded"))
                          : (classified?.title ?? (unknown ? t("desktop.drawer.outcomeUnknown") : t("desktop.drawer.printFailed")))}
                      </div>
                      <p className="mt-2 text-base leading-relaxed text-ink-2">
                        {classified?.guidance ?? friendlyPrinterError(String(selectedJob.error), locale)}
                      </p>
                      {!unknown && !succeeded && (
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
