import type { AgentStatus, PrinterInfo, RuntimePaths } from "./lib/ipc";

export type Page = "dashboard" | "printers" | "jobs" | "settings";
export type JobTab = "all" | "in_flight" | "queued" | "unassigned" | "delivered" | "failed" | "unknown" | "expired";
export type PrinterStatusFilter = "all" | "ready" | "printing" | "attention" | "unavailable" | "saved";

export type AgentStatusView = Partial<AgentStatus> & { error?: string };
export type ToastMessage = { text: string; type: "success" | "error" | "info" } | null;
export type JobRecord = Record<string, unknown>;

/**
 * Everything the desktop pages need. The App shell owns the state and the
 * IPC effects; pages are pure presentation over this bag, which keeps the
 * five screens consistent and makes each one readable on its own.
 */
export interface DesktopState {
  /* navigation */
  page: Page;
  navigate: (p: Page) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;

  /* local agent */
  version: string;
  agentStatus: AgentStatusView | null;
  isOnline: boolean;
  lastStatusCheck: string | null;
  autostart: boolean | null;
  setAutostartState: (v: boolean) => void;
  refreshStatus: () => void;
  startAgent: () => void;
  requestStopAgent: () => void;
  restartAgent: () => void;

  /* gateway */
  /** Persisted Gateway origin used by operational requests. */
  gatewayUrl: string;
  /** Editable Settings draft; never drives operational requests until verified and saved. */
  gatewayDraftUrl: string;
  setGatewayDraftUrl: (v: string) => void;
  /** Origin associated with the latest saved-Gateway health observation. */
  checkedGatewayUrl: string;
  gatewayDraftMatchesSaved: boolean;
  /** Safe, localized copy; pages must render it without translating again. */
  gatewayDraftError: string | null;
  health: Record<string, unknown> | null;
  /** Safe, localized copy; pages must render it without translating again. */
  healthError: string | null;
  gatewayConnected: boolean;
  gatewayChecking: boolean;
  checkHealth: () => void;
  /** Re-probe the persisted Gateway origin without saving or touching the Settings draft. */
  retrySavedGateway?: () => void;
  /** True only after a successful native pairing or authenticated inventory reply for this origin. */
  pairingConfirmed?: boolean;
  pairCode: string;
  setPairCode: (v: string) => void;
  pair: () => void;

  /* printers */
  printers: PrinterInfo[];
  /** Raw Gateway rows, before merging with the local inventory. The
   * merged `printers` list overlays the LOCAL sharing choice, so only
   * this list can confirm whether the Gateway has flipped after a
   * heartbeat. Optional so existing state builders keep compiling;
   * absent means "Gateway confirmation unknown", never "confirmed". */
  gatewayPrinters?: PrinterInfo[];
  discoveredPrinters: PrinterInfo[];
  localPrinters: PrinterInfo[];
  localPrintersLoading: boolean;
  localPrintersError: string | null;
  localInventoryReady: boolean;
  canManagePrinterVisibility: boolean;
  canManagePrinterSharing?: boolean;
  availabilityPendingPrinterIds: ReadonlySet<string>;
  sharingPendingPrinterIds?: ReadonlySet<string>;
  availabilityErrors: Record<string, string>;
  sharingErrors?: Record<string, string>;
  refreshLocalPrinters: () => Promise<boolean>;
  handlePrinterVisibility: (id: string, shared: boolean) => Promise<void>;
  handlePrinterSharing?: (id: string, shared: boolean) => Promise<void>;
  printersLoading: boolean;
  printersError: string | null;
  printersFilter: string;
  setPrintersFilter: (v: string) => void;
  statusFilter: PrinterStatusFilter;
  setStatusFilter: (v: PrinterStatusFilter) => void;
  filteredPrinters: PrinterInfo[];
  totalPrinters: number;
  onlinePrinters: number;
  offlinePrinters: number;
  /** Advancing wall clock (15s tick) so freshness re-derives on open screens. */
  nowMs: number;
  refreshPrinters: () => void;
  handleDiscover: () => void;
  showAdd: boolean;
  setShowAdd: (v: boolean) => void;
  selectedPrinter: PrinterInfo | null;
  setSelectedPrinter: (p: PrinterInfo | null) => void;

  /* jobs */
  jobs: JobRecord[];
  jobsLoading: boolean;
  jobsError: string | null;
  jobTab: JobTab;
  setJobTab: (t: JobTab) => void;
  jobSearch: string;
  setJobSearch: (v: string) => void;
  jobsFiltered: JobRecord[];
  jobCounts: Record<JobTab | "all", number>;
  pendingJobs: number;
  failedJobs: number;
  refreshJobs: (options?: { status?: string; search?: string; limit?: number; printerId?: string; merge?: boolean }) => Promise<void> | void;
  jobPrinterFilter: string | null;
  setJobPrinterFilter: (v: string | null) => void;
  printerFilterName: string;
  selectedJob: JobRecord | null;
  setSelectedJob: (j: JobRecord | null) => void;

  /* misc */
  runtimePaths: RuntimePaths | null;
  advancedOpen: boolean;
  setAdvancedOpen: (v: boolean) => void;
  busy: boolean;
  msg: ToastMessage;
  setMsg: (m: ToastMessage) => void;
  // null = the health endpoint does not report fleet counts (it reports
  // liveness only). Rendering "0 / 0" for unknown data was a lie; consumers
  // must render an explicit dash instead.
  fleetTotal: number | null;
  fleetOnline: number | null;
}
