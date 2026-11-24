// @vitest-environment jsdom
import { verifiedPrinterState } from "./helpers/printer-verification";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../src/i18n/react";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { AddPrinterDialog } from "../src/desktop/components/AddPrinterDialog";
import { PrinterSharingControl } from "../src/desktop/components/PrinterSharingControl";
import { PrintersPage } from "../src/desktop/pages/Printers";
import type { PrinterInfo } from "../src/desktop/lib/ipc";
import type { DesktopState } from "../src/desktop/types";
import {
  applySpoolerSelection,
  pickerAgentMismatchRows,
  pickerSpoolerRows,
  searchSpoolerRows,
  spoolerDriverName,
  spoolerPortName,
  spoolerRowLabel,
  validateTypedSpoolerNameAgainst,
} from "../src/desktop/lib/printers";
import { printerStatusDetail, printerStatusDetailCode } from "../src/shared/printer-presentation";

const now = Date.parse("2026-10-14T12:00:00Z");

// Local inventory row: NO agentId (this is exactly what `printers list`
// returns). Before WP4 the dialog's exact-match filter dropped it.
const localRow: PrinterInfo = {
  id: "local-hp", name: "HP LaserJet Pro M404", spoolerName: "HP LaserJet Pro M404",
  connectionType: "spooler", protocol: "spooler", status: "online", enabled: true,
  capabilities: { driver_name: "HP LaserJet Pro M404 PCL 6", port_name: "USB001" },
};
const discoveredRow: PrinterInfo = {
  ...localRow, id: "disc-canon", name: "Canon G4070", spoolerName: "Canon G4070",
  agentId: "agent-A", status: "error",
  capabilities: { driver_name: "Canon G4070 Driver", port_name: "IP_192.168.1.31", status_detail: "windows_paper_out" },
};
const otherAgentRow: PrinterInfo = {
  ...localRow, id: "other-brother", name: "Brother MFC", spoolerName: "Brother MFC",
  agentId: "agent-B", capabilities: { driver_name: "Brother Driver", port_name: "BRN0080777A1B2C" },
};
const pos80: PrinterInfo = {
  id: "pos80", name: "POS80 Printer (2)", spoolerName: "POS80 Printer (2)",
  connectionType: "spooler", protocol: "spooler", status: "online", enabled: true,
};

const noop = () => {};
function state(overrides: Record<string, unknown> = {}): DesktopState {
  return {
    page: "printers", navigate: noop, collapsed: false, setCollapsed: noop, sidebarOpen: false, setSidebarOpen: noop,
    version: "unit", agentStatus: null, isOnline: false, lastStatusCheck: null, autostart: null,
    setAutostartState: noop, refreshStatus: noop, startAgent: noop, requestStopAgent: noop, restartAgent: noop,
    gatewayUrl: "", gatewayDraftUrl: "", setGatewayDraftUrl: noop, checkedGatewayUrl: "", gatewayDraftMatchesSaved: true,
    gatewayDraftError: null, health: null, healthError: null, gatewayConnected: false, gatewayChecking: false,
    checkHealth: noop, pairCode: "", setPairCode: noop, pair: noop,
    printers: [], discoveredPrinters: [], localPrinters: [], localPrintersLoading: false,
    localPrintersError: null, localInventoryReady: true, canManagePrinterVisibility: true,
    availabilityPendingPrinterIds: new Set(), availabilityErrors: {}, refreshLocalPrinters: async () => true,
    handlePrinterVisibility: async () => {},
    printersLoading: false, printersError: null, printersFilter: "", setPrintersFilter: noop, statusFilter: "all",
    setStatusFilter: noop, filteredPrinters: [], totalPrinters: 0, onlinePrinters: 0, offlinePrinters: 0,
    nowMs: now, refreshPrinters: noop, handleDiscover: noop, showAdd: false, setShowAdd: noop,
    selectedPrinter: null, setSelectedPrinter: noop, jobs: [], jobsLoading: false, jobsError: null,
    jobTab: "all", setJobTab: noop, jobSearch: "", setJobSearch: noop, jobsFiltered: [],
    jobCounts: { all: 0, in_flight: 0, queued: 0, unassigned: 0, delivered: 0, failed: 0, unknown: 0, expired: 0 },
    pendingJobs: 0, failedJobs: 0, refreshJobs: noop, jobPrinterFilter: null, setJobPrinterFilter: noop,
    printerFilterName: "", selectedJob: null, setSelectedJob: noop, runtimePaths: null, advancedOpen: false,
    setAdvancedOpen: noop, busy: false, msg: null, setMsg: noop, fleetTotal: null, fleetOnline: null,
    ...overrides,
  } as unknown as DesktopState;
}
const tree = (children: React.ReactNode, locale: "en" | "ar" = "en") => h(I18nProvider, { initialLocale: locale, children });

describe("WP4a picker eligibility (S3 fix)", () => {
  it("accepts local rows with no agentId and excludes only other-agent rows", () => {
    const picked = pickerSpoolerRows([localRow, discoveredRow, otherAgentRow], "agent-A");
    expect(picked.map((p) => p.id)).toEqual(["local-hp", "disc-canon"]);
    expect(pickerSpoolerRows([localRow], "")).toEqual([localRow]);
    expect(pickerAgentMismatchRows([localRow, discoveredRow, otherAgentRow], "agent-A").map((p) => p.id)).toEqual(["other-brother"]);
    expect(pickerAgentMismatchRows([otherAgentRow], "")).toEqual([]);
  });

  it("reads driver/port from the capability bag that survives the Tauri layer", () => {
    expect(spoolerDriverName(localRow)).toBe("HP LaserJet Pro M404 PCL 6");
    expect(spoolerPortName(localRow)).toBe("USB001");
    expect(spoolerDriverName({ ...localRow, capabilities: null, spoolerDriver: "Fallback Driver" })).toBe("Fallback Driver");
    expect(spoolerPortName({ ...localRow, capabilities: null })).toBe("");
  });

  it("labels picker rows with queue + driver + port + status and searches across them", () => {
    const label = spoolerRowLabel(localRow, "en");
    expect(label).toContain("HP LaserJet Pro M404");
    expect(label).toContain("HP LaserJet Pro M404 PCL 6");
    expect(label).toContain("USB001");
    expect(label).toContain("online");
    expect(searchSpoolerRows([localRow, discoveredRow], "pcl 6").map((p) => p.id)).toEqual(["local-hp"]);
    expect(searchSpoolerRows([localRow, discoveredRow], "192.168").map((p) => p.id)).toEqual(["disc-canon"]);
    expect(searchSpoolerRows([localRow, discoveredRow], "nomatch")).toEqual([]);
    expect(searchSpoolerRows([localRow, discoveredRow], "")).toHaveLength(2);
  });

  it("validates typed names: empty, exact, near-miss suffix, agent mismatch, unknown", () => {
    expect(validateTypedSpoolerNameAgainst("   ", [localRow], []).status).toBe("empty");
    expect(validateTypedSpoolerNameAgainst("hp laserjet pro m404", [localRow], []).status).toBe("exact");
    expect(validateTypedSpoolerNameAgainst("Brother MFC", [localRow], [otherAgentRow])).toEqual(
      { status: "agent_mismatch", name: "Brother MFC", suggestion: "Brother MFC" });
    const near = validateTypedSpoolerNameAgainst("POS80 Printer", [pos80], []);
    expect(near.status).toBe("near_miss");
    expect(near.suggestion).toBe("POS80 Printer (2)");
    expect(validateTypedSpoolerNameAgainst("No Such Printer", [localRow], [otherAgentRow]).status).toBe("unknown");
  });

  it("one-click fill fills name only when the user has not typed one", () => {
    expect(applySpoolerSelection(localRow, "")).toEqual({ name: "HP LaserJet Pro M404", spoolerName: "HP LaserJet Pro M404" });
    expect(applySpoolerSelection(localRow, "My custom name")).toEqual({ name: "My custom name", spoolerName: "HP LaserJet Pro M404" });
  });
});

describe("WP4a dialog rendering", () => {
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => {
    if (root) act(() => { root!.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = "";
  });
  // gatewayUrl is empty on purpose: it skips the agents fetch effect, so
  // the picker renders purely from the `printers` prop (currentAgentId "").
  function renderDialog(printers: PrinterInfo[]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(tree(h(AddPrinterDialog, { open: true, onClose: noop, onSuccess: noop, printers, gatewayUrl: "" })));
    });
  }

  it("lists an agentId-less local row with driver/port/status and a search box", () => {
    renderDialog([localRow]);
    const select = document.body.querySelector<HTMLSelectElement>("#pp-spooler");
    expect(select).not.toBeNull();
    expect(select!.textContent).toContain("HP LaserJet Pro M404 PCL 6");
    expect(select!.textContent).toContain("USB001");
    expect(document.body.querySelector("#pp-spooler-search")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Enter the exact queue name from Windows");
  });

  it("one click on a picker row fills the printer name and shows driver/port", () => {
    renderDialog([localRow]);
    const select = document.body.querySelector<HTMLSelectElement>("#pp-spooler")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    act(() => {
      setter.call(select, "local-hp");
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect((document.body.querySelector("#pp-name") as HTMLInputElement).value).toBe("HP LaserJet Pro M404");
    expect((document.body.querySelector("#pp-spooler") as HTMLSelectElement).value).toBe("local-hp");
    expect(document.body.textContent).toContain("HP LaserJet Pro M404 PCL 6");
    expect(document.body.textContent).toContain("USB001");
  });

  it("shows an actionable empty state when zero queues exist, with manual entry as an explicit choice", () => {
    renderDialog([]);
    // No silent drop into "type the exact queue name": the dialog says
    // no printers were found and offers search/manual actions instead.
    expect(document.body.querySelector("#pp-spooler")).toBeNull();
    expect(document.body.textContent).toContain("No Windows printers were found on this device");
    expect(document.body.textContent).toContain("Printers & scanners");
    expect(document.body.textContent).toContain("Search again");
    expect(document.body.textContent).toContain("Enter the queue name manually");
    expect(document.body.textContent).not.toContain("Get-Printer | Select Name,DriverName,PortName");
  });

  it("reveals the manual fallback hint (Windows path + PowerShell) only after choosing manual entry", () => {
    renderDialog([]);
    const manualButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.includes("Enter the queue name manually"));
    expect(manualButton).toBeDefined();
    act(() => { manualButton!.click(); });
    expect(document.body.querySelector("#pp-spooler")).not.toBeNull();
    expect(document.body.textContent).toContain("Printers & scanners");
    expect(document.body.textContent).toContain("Get-Printer | Select Name,DriverName,PortName");
  });
});

describe("WP4b sharing visibility", () => {
  const renderControl = (overrides: Record<string, unknown>, printer: PrinterInfo, candidate = false) =>
    new DOMParser().parseFromString(
      renderToStaticMarkup(tree(h(PrinterSharingControl, { s: state(overrides), printer, candidate }))), "text/html");

  it("explains a Gateway row with no local record instead of rendering nothing", () => {
    const doc = renderControl({ localPrinters: [], printers: [discoveredRow] }, discoveredRow);
    expect(doc.body.textContent).toContain("no local record for it");
    expect(doc.body.querySelector("button")).toBeNull();
  });

  it("names detected-only as the reason sharing is disabled", () => {
    const detected: PrinterInfo = { ...localRow, capabilities: { verification: "device_detected_only" }, localObservedAt: now };
    const doc = renderControl({ localPrinters: [detected], printers: [detected] }, detected, true);
    expect(doc.body.textContent).toContain("no verified local binding yet");
    expect(doc.body.querySelector("button")?.disabled).toBe(true);
  });

  it("keeps the toggle explicit: no auto-share copy appears", () => {
    const doc = renderControl({ localPrinters: [{ ...localRow, availableToOdoo: false, localObservedAt: now }], printers: [localRow] }, localRow);
    expect(doc.body.textContent).toContain("Make available to Odoo");
  });
});

describe("WP4c status_detail distinguishability", () => {
  it("returns the raw code verbatim and keeps localized detail semantics", () => {
    expect(printerStatusDetailCode(discoveredRow)).toBe("windows_paper_out");
    expect(printerStatusDetail(discoveredRow, "en")).toBe("The printer is out of paper.");
    expect(printerStatusDetailCode(localRow)).toBe("");
    expect(printerStatusDetail({ ...localRow, capabilities: { status_detail: "windows_custom_code" } }, "en")).toBe("windows_custom_code");
  });

  it("shows the code in the printers-page row, distinct per status", () => {
    const paperOut: PrinterInfo = {
      ...discoveredRow, ...verifiedPrinterState("disc-canon", new Date(now)),
      localObservedAt: undefined, sharedWithGateway: true, agentId: "agent-A",
      agentStatus: "online", agentLifecycle: "active", agentLastSeenAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(), inventoryPresent: true, lifecycle: "active",
    };
    const offline: PrinterInfo = {
      ...paperOut, id: "off-1", name: "Offline Queue", status: "offline",
      capabilities: { status_detail: "windows_offline" },
    };
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrintersPage, {
      s: state({ printers: [paperOut, offline], filteredPrinters: [paperOut, offline], totalPrinters: 2 }),
    }))), "text/html");
    expect(doc.body.textContent).toContain("windows_paper_out");
    expect(doc.body.textContent).toContain("windows_offline");
  });

  it("renders no code line when the Agent sent no status_detail", () => {
    const plain: PrinterInfo = {
      ...localRow, ...verifiedPrinterState("local-hp", new Date(now)),
      sharedWithGateway: true, agentId: "agent-A",
      agentStatus: "online", agentLifecycle: "active", agentLastSeenAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(), inventoryPresent: true, lifecycle: "active",
    };
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrintersPage, {
      s: state({ printers: [plain], filteredPrinters: [plain], totalPrinters: 1 }),
    }))), "text/html");
    expect(doc.body.textContent).not.toContain("windows_");
  });
});
