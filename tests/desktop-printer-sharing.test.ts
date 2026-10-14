// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { PrinterSharingControl } from "../src/desktop/components/PrinterSharingControl";
import { PrintersPage } from "../src/desktop/pages/Printers";
import type { PrinterInfo } from "../src/desktop/lib/ipc";
import type { DesktopState } from "../src/desktop/types";
import { eligibleGatewayTestPrinterIds, isMainInventoryPrinter, mergePrinterInventories, printerIsStale, printerPresentation } from "../src/desktop/lib/printers";
import { printerPresentation as cloudPresentation } from "../src/shared/printer-presentation";
import { apiMessageKey } from "../src/lib/api-error-keys";

const boundary = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => { boundary.invoke.mockReset(); vi.unstubAllGlobals(); });
const now = Date.parse("2026-10-14T12:00:00Z");
const local: PrinterInfo = { id: "local-queue", name: "Canon المحلية", status: "online", enabled: true,
  connectionType: "spooler", protocol: "spooler", sharedWithGateway: false, localObservedAt: now };
const cloud: PrinterInfo = { ...local, localObservedAt: undefined, sharedWithGateway: true, agentId: "owner",
  agentStatus: "online", agentLifecycle: "active", agentLastSeenAt: new Date(now).toISOString(),
  lastSeenAt: new Date(now).toISOString(), inventoryPresent: true, lifecycle: "active" };
const noop = () => {};
function state(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    page: "printers", navigate: noop, collapsed: false, setCollapsed: noop, sidebarOpen: false, setSidebarOpen: noop,
    version: "unit", agentStatus: null, isOnline: false, lastStatusCheck: null, autostart: null,
    setAutostartState: noop, refreshStatus: noop, startAgent: noop, requestStopAgent: noop, restartAgent: noop,
    gatewayUrl: "", gatewayDraftUrl: "", setGatewayDraftUrl: noop, checkedGatewayUrl: "", gatewayDraftMatchesSaved: true,
    gatewayDraftError: null, health: null, healthError: null, gatewayConnected: false, gatewayChecking: false,
    checkHealth: noop, pairCode: "", setPairCode: noop, pair: noop,
    printers: [local], discoveredPrinters: [], localPrinters: [local], localPrintersLoading: false,
    localPrintersError: null, localInventoryReady: true, canManagePrinterSharing: true,
    sharingPendingPrinterIds: new Set(), sharingErrors: {}, refreshLocalPrinters: async () => true,
    handlePrinterSharing: async () => {}, gatewayTestPrinterIds: new Set(),
    printersLoading: false, printersError: null, printersFilter: "", setPrintersFilter: noop, statusFilter: "all",
    setStatusFilter: noop, filteredPrinters: [local], totalPrinters: 1, onlinePrinters: 1, offlinePrinters: 0,
    nowMs: now, refreshPrinters: noop, handleDiscover: noop, handleTest: noop, showAdd: false, setShowAdd: noop,
    selectedPrinter: null, setSelectedPrinter: noop, jobs: [], jobsLoading: false, jobsError: null,
    jobTab: "all", setJobTab: noop, jobSearch: "", setJobSearch: noop, jobsFiltered: [],
    jobCounts: { all: 0, in_flight: 0, queued: 0, unassigned: 0, delivered: 0, failed: 0, unknown: 0, expired: 0 },
    pendingJobs: 0, failedJobs: 0, refreshJobs: noop, jobPrinterFilter: null, setJobPrinterFilter: noop,
    printerFilterName: "", selectedJob: null, setSelectedJob: noop, runtimePaths: null, advancedOpen: false,
    setAdvancedOpen: noop, busy: false, msg: null, setMsg: noop, fleetTotal: null, fleetOnline: null, ...overrides,
  };
}
const tree = (children: React.ReactNode, locale: "en" | "ar" = "en") => h(I18nProvider, { initialLocale: locale, children });

describe("local health and sharing stay independent of cloud evidence", () => {
  it.each(["active", "disabled", "retired"] as const)("keeps private fresh local health with cloud lifecycle %s and absent inventory", (lifecycle) => {
    const remote = { ...cloud, lifecycle, inventoryPresent: false };
    const rows = mergePrinterInventories([remote], [local]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sharedWithGateway).toBe(false);
    expect(printerPresentation(rows[0], undefined, now).state).toBe("ready");
    expect(printerIsStale(rows[0], now)).toBe(false);
    expect(isMainInventoryPrinter(rows[0])).toBe(true);
    expect(eligibleGatewayTestPrinterIds([remote], [local], true, now).size).toBe(0);
    expect(remote.lifecycle).toBe(lifecycle);
  });
  it("keeps local unknown, faults and aging honest without a heartbeat", () => {
    expect(printerPresentation({ ...local, status: "unknown" }, undefined, now).state).toBe("unavailable");
    expect(printerPresentation({ ...local, status: "paper_out" }, undefined, now).state).toBe("attention");
    expect(printerPresentation(local, undefined, now + 3600000).state).toBe("unavailable");
    expect(printerPresentation({ ...local, enabled: false }, undefined, now).state).toBe("attention");
    expect(cloudPresentation({ ...cloud, sharedWithGateway: false }, undefined, now)).toMatchObject({ state: "unavailable", reasonKey: "printer.presentation.notSharedReason" });
    expect(cloud.status).toBe("online");
  });
  it("does not guess an identity match from identical queue names", () => {
    const rows = mergePrinterInventories([{ ...cloud, id: "historical-alias" }], [local]);
    expect(rows.map((p) => p.id)).toEqual(["historical-alias", local.id]);
    expect(eligibleGatewayTestPrinterIds([], [{ ...local, sharedWithGateway: true }], true, now).size).toBe(0);
  });
  it("retains unknown-health cloud admission only with real synced ownership and sharing", () => {
    const unknown = { ...cloud, status: "unknown" };
    expect(eligibleGatewayTestPrinterIds([unknown], [{ ...local, sharedWithGateway: true }], true, now).has(local.id)).toBe(true);
    for (const rejected of [{ ...unknown, agentStatus: "offline" }, { ...unknown, inventoryPresent: false },
      { ...unknown, agentLifecycle: "disabled" }, { ...unknown, configurationConverged: false },
      { ...unknown, freshness: "stale" as const }, { ...unknown, sharedWithGateway: false }]) {
      expect(eligibleGatewayTestPrinterIds([rejected], [], true, now).size).toBe(0);
    }
    expect(eligibleGatewayTestPrinterIds([unknown], [local], true, now).size).toBe(0);
    expect(eligibleGatewayTestPrinterIds([unknown], [], false, now).size).toBe(0);
  });
  it.each(["candidate_only", "device_detected_only"])("keeps %s observations in setup rather than executable local inventory", (verification) => {
    const candidate = { ...local, capabilities: { verification } };
    expect(isMainInventoryPrinter(candidate)).toBe(false);
    expect(mergePrinterInventories([], [candidate])).toEqual([]);
    expect(printerPresentation(candidate, undefined, now).state).toBe("unavailable");
  });
});

describe("actual Desktop sharing controls", () => {
  it("allows a confirmed private local queue to be shared before its first Gateway sync, never a discovery-only candidate", () => {
    const pending = state({ printers: [], filteredPrinters: [], totalPrinters: 0, localPrinters: [local], discoveredPrinters: [local] });
    const markup = renderToStaticMarkup(tree(h(PrintersPage, { s: pending })));
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const controls = doc.querySelectorAll(`[data-printer-sharing="${local.id}"]`);
    expect(controls).toHaveLength(2); // pending rows in both responsive layouts
    for (const control of controls) {
      const action = control.querySelector("button")!;
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-label")).toContain(local.name);
    }
    const discovered = state({ printers: [], filteredPrinters: [], totalPrinters: 0, localPrinters: [], discoveredPrinters: [local] });
    const candidateMarkup = renderToStaticMarkup(tree(h(PrintersPage, { s: discovered })));
    const candidateDoc = new DOMParser().parseFromString(candidateMarkup, "text/html");
    const candidateActions = candidateDoc.querySelectorAll(`[data-printer-sharing="${local.id}"] button`);
    expect(candidateActions).toHaveLength(2);
    for (const action of candidateActions) expect((action as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(["en", "ar"] as const)("keeps the private printer and sharing action in actual cards/table during cloud loading (%s)", (locale) => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrintersPage, { s: state({ printersLoading: true, printersError: "Gateway offline" }) }), locale)), "text/html");
    const controls = doc.querySelectorAll(`[data-printer-sharing="${local.id}"]`);
    expect(controls).toHaveLength(2);
    expect(doc.querySelector("table tbody")?.textContent).toContain(local.name);
    for (const control of controls) {
      const share = control.querySelector("button")!;
      expect(share.disabled).toBe(false);
      expect(share.getAttribute("aria-label")).toContain(local.name);
      expect(control.textContent).toContain(locale === "en" ? "Local only" : "محلية فقط");
    }
    const tests = [...doc.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")?.includes(local.name) && !b.closest("[data-printer-sharing]") && b.disabled);
    expect(tests).toHaveLength(2);
  });
  it.each([
    { canManagePrinterSharing: false }, { localInventoryReady: false }, { sharingPendingPrinterIds: new Set([local.id]) }, { nowMs: now + 3600000 },
  ])("disables guarded local sharing with readable guidance or pending feedback", (overrides) => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrinterSharingControl, { s: state(overrides), printer: local }))), "text/html");
    expect(doc.querySelector("button")?.disabled).toBe(true);
    expect(doc.querySelector("button")?.getAttribute("aria-describedby")).toBeTruthy();
  });
  it("never offers an active local mutation for a remote or setup-only row", () => {
    expect(renderToStaticMarkup(tree(h(PrinterSharingControl, { s: state({ localPrinters: [] }), printer: cloud })))).toBe("");
    const candidate = { ...local, capabilities: { verification: "candidate_only" } };
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrinterSharingControl, { s: state({ localPrinters: [candidate] }), printer: candidate }))), "text/html");
    expect(doc.querySelector("button")?.disabled).toBe(true);
    expect(doc.body.textContent).toContain("verified local printer binding");
    expect(doc.body.textContent).not.toContain("Gateway sharing enabled");
    expect(doc.querySelector("button")?.textContent).toContain("Share with Gateway");
  });
  it("acts on the exact local ID and awaits confirmed props without hiding per-row errors", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const handler = vi.fn(async () => {});
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
    const s = state({ handlePrinterSharing: handler, sharingErrors: { [local.id]: "Local policy write failed" } });
    try {
      await act(async () => root.render(tree(h(PrinterSharingControl, { s, printer: local }))));
      expect(host.querySelector("[role=alert]")?.textContent).toBe("Local policy write failed");
      await act(async () => host.querySelector("button")!.click());
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(local.id, true);
      expect(host.textContent).toContain("Local only");
      await act(async () => root.render(tree(h(PrinterSharingControl, { s: { ...s, localPrinters: [{ ...local, sharedWithGateway: true }] }, printer: local }))));
      expect(host.textContent).toContain("Gateway sharing enabled");
      expect(host.querySelector("button")?.textContent).toContain("Stop sharing");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});

describe("native sharing IPC DTO boundary", () => {
  it("accepts only the exact ID/value durable acknowledgment", async () => {
    expect(apiMessageKey("PRINTER_NOT_SHARED", 409)).toBe("printer.presentation.notSharedReason");
    const { setPrinterSharing } = await import("../src/desktop/lib/ipc");
    boundary.invoke.mockResolvedValueOnce({ printerId: local.id, sharedWithGateway: false });
    await expect(setPrinterSharing(local.id, false)).resolves.toEqual({ printerId: local.id, sharedWithGateway: false });
    expect(boundary.invoke).toHaveBeenLastCalledWith("set_printer_sharing", { printerId: local.id, sharedWithGateway: false });
    for (const response of [null, { printerId: "historical", sharedWithGateway: false }, { printerId: local.id, sharedWithGateway: true },
      { printerId: local.id, sharedWithGateway: false, ok: true }, { printerId: local.id, sharedWithGateway: "false" }]) {
      boundary.invoke.mockResolvedValueOnce(response);
      await expect(setPrinterSharing(local.id, false)).rejects.toThrow(/acknowledgment/);
    }
  });
  it("rejects non-exact, flag-smuggling, control and oversize UTF8 IDs before native invocation", async () => {
    const { setPrinterSharing } = await import("../src/desktop/lib/ipc");
    for (const id of ["", " local", "local ", "-config", "local\nqueue", "local\u0085queue", "ط".repeat(129)]) {
      await expect(setPrinterSharing(id, true)).rejects.toThrow("Invalid local printer sharing request");
    }
    expect(boundary.invoke).not.toHaveBeenCalled();
    const id = "ط".repeat(128);
    boundary.invoke.mockResolvedValue({ printerId: id, sharedWithGateway: true });
    await expect(setPrinterSharing(id, true)).resolves.toEqual({ printerId: id, sharedWithGateway: true });
  });
  it("normalizes legacy absence, preserves private health and never trusts supplied local completion", async () => {
    const { getPrinters } = await import("../src/desktop/lib/ipc");
    boundary.invoke.mockResolvedValueOnce([{ ...local, sharedWithGateway: undefined }, local]);
    const rows = await getPrinters();
    expect(rows.map((p) => p.sharedWithGateway)).toEqual([true, false]);
    expect(rows.map((p) => p.localObservedAt)).toEqual([undefined, undefined]);
    expect(rows[1].status).toBe("online");
    for (const invalid of [null, [{ ...local, sharedWithGateway: "false" }], [{ id: local.id }]]) {
      boundary.invoke.mockResolvedValueOnce(invalid);
      await expect(getPrinters()).rejects.toThrow(/Invalid local printer inventory/);
    }
    boundary.invoke.mockRejectedValueOnce(new Error("CLI timed out"));
    await expect(getPrinters()).rejects.toThrow("CLI timed out");
  });
});
