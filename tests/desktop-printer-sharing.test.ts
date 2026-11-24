// @vitest-environment jsdom
import { verifiedPrinterState } from "./helpers/printer-verification";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/react";
import { PrinterSharingControl } from "../src/desktop/components/PrinterSharingControl";
import { PrintersPage } from "../src/desktop/pages/Printers";
import { OverviewPage } from "../src/desktop/pages/Overview";
import { SettingsPage } from "../src/desktop/pages/Settings";
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
const local: PrinterInfo = { capabilities: { operational_verification: { version: 1, verified_at: new Date(now).toISOString(), printer_id: "local-queue", binding_digest: "a".repeat(64), logical_queue_key: "a".repeat(64), method: "windows_queue", identity_strength: "queue", output_medium: "physical" } }, id: "local-queue", name: "Canon المحلية", status: "online", enabled: true,
  connectionType: "spooler", protocol: "spooler", sharedWithGateway: false, localObservedAt: now };
const cloud: PrinterInfo = { ...local, ...verifiedPrinterState("local-queue", new Date(now)), localObservedAt: undefined, sharedWithGateway: true, agentId: "owner",
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
    localPrintersError: null, localInventoryReady: true, canManagePrinterVisibility: true,
    availabilityPendingPrinterIds: new Set(), availabilityErrors: {}, refreshLocalPrinters: async () => true,
    handlePrinterVisibility: async () => {},
    printersLoading: false, printersError: null, printersFilter: "", setPrintersFilter: noop, statusFilter: "all",
    setStatusFilter: noop, filteredPrinters: [local], totalPrinters: 1, onlinePrinters: 1, offlinePrinters: 0,
    nowMs: now, refreshPrinters: noop, handleDiscover: noop, showAdd: false, setShowAdd: noop,
    selectedPrinter: null, setSelectedPrinter: noop, jobs: [], jobsLoading: false, jobsError: null,
    jobTab: "all", setJobTab: noop, jobSearch: "", setJobSearch: noop, jobsFiltered: [],
    jobCounts: { all: 0, in_flight: 0, queued: 0, unassigned: 0, delivered: 0, failed: 0, unknown: 0, expired: 0 },
    pendingJobs: 0, failedJobs: 0, refreshJobs: noop, jobPrinterFilter: null, setJobPrinterFilter: noop,
    printerFilterName: "", selectedJob: null, setSelectedJob: noop, runtimePaths: null, advancedOpen: false,
    setAdvancedOpen: noop, busy: false, msg: null, setMsg: noop, fleetTotal: null, fleetOnline: null, ...overrides,
  };
}
const tree = (children: React.ReactNode, locale: "en" | "ar" = "en") => h(I18nProvider, { initialLocale: locale, children });

describe("Desktop overview evidence boundaries", () => {
  const connected = { agentStatus: { running: true }, isOnline: true, gatewayConnected: true, gatewayUrl: "https://gateway.example" };
  const overview = (overrides: Partial<DesktopState>) => new DOMParser().parseFromString(
    renderToStaticMarkup(tree(h(OverviewPage, { s: state({ ...connected, ...overrides }) }))), "text/html",
  );

  it("offers printer setup instead of ready when the actual inventory is empty", () => {
    const doc = overview({ printers: [], localPrinters: [], discoveredPrinters: [] });
    expect(doc.querySelector(".yw-agent-status")?.textContent).toContain("No physical printers found");
    expect(doc.querySelector(".yw-agent-status")?.textContent).not.toContain("All good");
  });

  it.each([
    null,
    { error: "Status request failed" },
    { running: false, note_code: "status_check_failed" },
    { running: false, note_code: "service_status_unavailable" },
    { running: false, note_code: "service_ownership_unverified" },
  ])("keeps unavailable local service evidence distinct from stopped: %j", (agentStatus) => {
    const doc = overview({ agentStatus, isOnline: false });
    expect(doc.querySelector(".yw-agent-status")?.textContent).toContain("Agent status unavailable");
    expect(doc.querySelector(".yw-agent-status")?.textContent).not.toContain("Printing service is off");
    expect(doc.querySelector(".yw-agent-stats")?.textContent).toContain("Unknown");
    expect(doc.body.textContent).not.toContain("Stopped");
  });

  it("retains verified background running evidence even when Windows service status is unavailable", () => {
    const doc = overview({ agentStatus: { running: true, note_code: "service_status_unavailable" } });
    expect(doc.querySelector(".yw-agent-status")?.textContent).toContain("All good");
    expect(doc.querySelector(".yw-agent-stats")?.textContent).toContain("Online");
    expect(doc.querySelector(".yw-agent-stats")?.textContent).toContain("Windows service status is unavailable");
  });

  it("still offers Start for an explicitly stopped local service", () => {
    const doc = overview({ isOnline: false, agentStatus: { running: false, note_code: "not_running" } });
    expect(doc.querySelector(".yw-agent-status")?.textContent).toContain("Printing service is off");
    expect([...doc.querySelectorAll(".yw-agent-status button")].map((node) => node.textContent)).toContain("Start");
  });

  it("does not label failed status checks as stopped in settings", () => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(SettingsPage, { s: state({
      ...connected, isOnline: false, agentStatus: { running: false, note_code: "status_check_failed" },
    }) }))), "text/html");
    expect(doc.body.textContent).toContain("Agent status unavailable");
    expect(doc.body.textContent).not.toContain("Agent stopped");
    expect(doc.body.textContent).not.toContain("Agent service/process is not running");
  });

  it("reports failed diagnostic copy safely when the clipboard is unavailable", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const setMsg = vi.fn();
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
    try {
      await act(async () => root.render(tree(h(SettingsPage, { s: state({ setMsg }) }))));
      const copy = [...host.querySelectorAll("button")].find((node) => node.textContent === "Copy Summary")!;
      expect(copy).toBeDefined();
      await act(async () => copy.click());
      expect(setMsg).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
      expect(document.activeElement).toBe(copy);
    } finally {
      await act(async () => root.unmount()); host.remove();
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("local health and sharing stay independent of cloud evidence", () => {
  it("the local/cloud execution binding validator exists and fails closed on missing proof", () => {
    const localWithoutProof = { ...local, capabilities: {} };
    const remote = { ...cloud, sharedWithGateway: true };
    expect(mergePrinterInventories([remote], [{ ...localWithoutProof, sharedWithGateway: true }])[0].agentId).toBeUndefined();
    expect(eligibleGatewayTestPrinterIds([remote], [{ ...localWithoutProof, sharedWithGateway: true }], true, now).has(local.id)).toBe(false);
  });

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
  it("does not blend foreign cloud ownership or enable a remote test when a local ID collides", () => {
    const shared = { ...local, sharedWithGateway: true };
    const unrelated = { ...cloud, name: "Different physical endpoint", agentId: "foreign-agent",
      verificationBindingDigest: "b".repeat(64), logicalQueueKey: "b".repeat(64) };
    const rows = mergePrinterInventories([unrelated], [shared]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(local.name);
    expect(rows[0].agentId).toBeUndefined();
    expect(rows[0].localObservedAt).toBe(now);
    expect(eligibleGatewayTestPrinterIds([unrelated], [shared], true, now).has(local.id)).toBe(false);
    // Real matching proofs still retain the authenticated Gateway association.
    expect(mergePrinterInventories([cloud], [shared])[0].agentId).toBe(cloud.agentId);
    expect(eligibleGatewayTestPrinterIds([cloud], [shared], true, now).has(local.id)).toBe(true);
  });

  it("does not accept a withdrawn local share or duplicate local ID as Gateway print authority", () => {
    const privateLocal = { ...local, availableToOdoo: false };
    const privateRows = mergePrinterInventories([cloud], [privateLocal]);
    expect(privateRows[0].agentId).toBeUndefined();
    const shared = { ...local, availableToOdoo: true };
    expect(eligibleGatewayTestPrinterIds([cloud], [shared, shared], true, now).has(local.id)).toBe(false);
  });

  it("rejects duplicate Gateway printer identities instead of trusting the last cloud owner", () => {
    const native = { ...local, sharedWithGateway: true };
    const conflict = { ...cloud, agentId: "foreign-agent", name: "Other printer", verificationBindingDigest: "b".repeat(64) };
    const merged = mergePrinterInventories([cloud, conflict], [native]);
    expect(merged).toHaveLength(1);
    expect(merged[0].agentId).toBeUndefined();
    expect(merged[0].localObservedAt).toBe(now);
    // Even identical duplicate records cannot establish a unique route.
    expect(mergePrinterInventories([cloud, { ...cloud }], [])).toEqual([]);
    for (const duplicate of [conflict, { ...cloud }]) {
      expect(eligibleGatewayTestPrinterIds([cloud, duplicate], [native], true, now).has(local.id)).toBe(false);
      expect(eligibleGatewayTestPrinterIds([cloud, duplicate], [], true, now).has(local.id)).toBe(false);
    }
    // Distinct cloud printer IDs continue to work normally.
    expect(eligibleGatewayTestPrinterIds([cloud], [native], true, now).has(local.id)).toBe(true);
  });

  it("does not guess an identity match from identical queue names", () => {
    const rows = mergePrinterInventories([{ ...cloud, id: "historical-alias" }], [local]);
    expect(rows.map((p) => p.id)).toEqual(["historical-alias", local.id]);
    expect(eligibleGatewayTestPrinterIds([], [{ ...local, sharedWithGateway: true }], true, now).size).toBe(0);
  });
  it("retains unknown-health cloud admission only with real synced ownership and sharing", () => {
    const unknown = { ...cloud, status: "unknown" };
    expect(eligibleGatewayTestPrinterIds([unknown], [{ ...local, availableToOdoo: true }], true, now).has(local.id)).toBe(true);
    for (const rejected of [{ ...unknown, agentStatus: "offline" }, { ...unknown, inventoryPresent: false },
      { ...unknown, agentLifecycle: "disabled" }, { ...unknown, configurationConverged: false },
      { ...unknown, freshness: "stale" as const }, { ...unknown, availableToOdoo: false }]) {
      expect(eligibleGatewayTestPrinterIds([rejected], [], true, now).size).toBe(0);
    }
    expect(eligibleGatewayTestPrinterIds([unknown], [{ ...local, availableToOdoo: false }], true, now).size).toBe(0);
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
  it("allows a confirmed private local queue to be shared, never a discovery-only candidate", () => {
    const privateLocal = { ...local, availableToOdoo: false };
    const confirmed = state({ printers: [privateLocal], filteredPrinters: [privateLocal], totalPrinters: 1, localPrinters: [privateLocal] });
    const markup = renderToStaticMarkup(tree(h(PrintersPage, { s: confirmed })));
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const controls = doc.querySelectorAll(`[data-printer-sharing="${local.id}"]`);
    expect(controls).toHaveLength(2); // card + table layouts
    for (const control of controls) {
      const action = control.querySelector("button")!;
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-label")).toContain(local.name);
    }
    const candidate = { ...local, capabilities: { verification: "candidate_only" } };
    const discovered = state({ printers: [], filteredPrinters: [], totalPrinters: 0, localPrinters: [], discoveredPrinters: [candidate] });
    const candidateDoc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrintersPage, { s: discovered }))), "text/html");
    const candidateActions = candidateDoc.querySelectorAll(`[data-printer-sharing="${local.id}"] button`);
    expect(candidateActions).toHaveLength(2);
    for (const action of candidateActions) expect((action as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(["en", "ar"] as const)("keeps the private printer and sharing action in actual cards/table during cloud loading (%s)", (locale) => {
    const privateLocal = { ...local, availableToOdoo: false };
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrintersPage, {
      s: state({ printers: [privateLocal], filteredPrinters: [privateLocal], localPrinters: [privateLocal], printersLoading: true, printersError: "Gateway offline" }),
    }), locale)), "text/html");
    const controls = doc.querySelectorAll(`[data-printer-sharing="${local.id}"]`);
    expect(controls).toHaveLength(2);
    expect(doc.querySelector("table tbody")?.textContent).toContain(local.name);
    for (const control of controls) {
      const share = control.querySelector("button")!;
      expect(share.disabled).toBe(false);
      expect(share.getAttribute("aria-label")).toContain(local.name);
      expect(control.textContent).toContain(locale === "en" ? "Hidden from Odoo" : "غير متاحة لـOdoo");
    }
    // Retain sharing and queue details without reintroducing the removed customer Test Print action.
    const unavailableNamedActions = [...doc.querySelectorAll("button")].filter((button) =>
      button.getAttribute("aria-label")?.includes(local.name) && !button.closest("[data-printer-sharing]") && button.disabled,
    );
    expect(unavailableNamedActions).toHaveLength(0);
    expect([...doc.querySelectorAll("button")].some((button) =>
      locale === "en" ? /\btest\b/i.test(button.textContent ?? "") : /اختبار/.test(button.textContent ?? ""),
    )).toBe(false);
  });
  it.each([
    { canManagePrinterVisibility: false }, { localInventoryReady: false }, { nowMs: now + 3600000 },
  ])("disables guarded local sharing with readable guidance", (overrides) => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrinterSharingControl, { s: state(overrides), printer: local }))), "text/html");
    expect(doc.querySelector("button")?.disabled).toBe(true);
    expect(doc.querySelector("button")?.getAttribute("aria-describedby")).toBeTruthy();
  });
  it("shows pending feedback while a local sharing write is in flight", () => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrinterSharingControl, {
      s: state({ availabilityPendingPrinterIds: new Set([local.id]) }), printer: local,
    }))), "text/html");
    expect(doc.querySelector("button")?.disabled).toBe(true);
    expect(doc.querySelector("button")?.querySelector("svg.animate-spin")).not.toBeNull();
  });
  it("never offers an active local mutation for a remote or setup-only row", () => {
    // WP4b: a remote row still offers no button, but it must now EXPLAIN
    // why instead of rendering nothing (a missing control reads as broken).
    const remote = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrinterSharingControl, { s: state({ localPrinters: [] }), printer: cloud }))), "text/html");
    expect(remote.querySelector("button")).toBeNull();
    expect(remote.body.textContent).toContain("no local record for it");
    const candidate = { ...local, capabilities: { verification: "candidate_only" } };
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(tree(h(PrinterSharingControl, { s: state({ localPrinters: [candidate] }), printer: candidate }))), "text/html");
    expect(doc.querySelector("button")?.disabled).toBe(true);
    expect(doc.body.textContent).toContain("verified local printer binding");
    expect(doc.body.textContent).not.toContain("Gateway sharing enabled");
    expect(doc.querySelector("button")?.textContent).toContain("Make available to Odoo");
  });
  it("acts on the exact local ID and awaits confirmed props without hiding per-row errors", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const handler = vi.fn(async () => {});
    const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
    const privateLocal = { ...local, availableToOdoo: false };
    const s = state({ localPrinters: [privateLocal], handlePrinterVisibility: handler, availabilityErrors: { [local.id]: "Local policy write failed" } });
    try {
      await act(async () => root.render(tree(h(PrinterSharingControl, { s, printer: privateLocal }))));
      expect(host.querySelector("[role=alert]")?.textContent).toBe("Local policy write failed");
      await act(async () => host.querySelector("button")!.click());
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(local.id, true);
      expect(host.textContent).toContain("Hidden from Odoo");
      await act(async () => root.render(tree(h(PrinterSharingControl, { s: { ...s, localPrinters: [{ ...local, availableToOdoo: true }] }, printer: local }))));
      expect(host.textContent).toContain("Available to Odoo");
      expect(host.querySelector("button")?.textContent).toContain("Stop sharing");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});

describe("native sharing IPC DTO boundary", () => {
  it("accepts only the exact ID/value durable acknowledgment", async () => {
    expect(apiMessageKey("PRINTER_NOT_SHARED", 409)).toBe("printer.presentation.notSharedReason");
    const { setPrinterVisibility } = await import("../src/desktop/lib/ipc");
    boundary.invoke.mockResolvedValueOnce({ printerId: local.id, availableToOdoo: false });
    await expect(setPrinterVisibility(local.id, false)).resolves.toEqual({ printerId: local.id, availableToOdoo: false, sharedWithGateway: false });
    expect(boundary.invoke).toHaveBeenLastCalledWith("set_printer_visibility", { printerId: local.id, availableToOdoo: false });
    for (const response of [null, { printerId: "historical", availableToOdoo: false }, { printerId: local.id, availableToOdoo: true },
      { printerId: local.id, availableToOdoo: false, ok: true }, { printerId: local.id, availableToOdoo: "false" }]) {
      boundary.invoke.mockResolvedValueOnce(response);
      await expect(setPrinterVisibility(local.id, false)).rejects.toThrow(/acknowledgment/);
    }
  });
  it("rejects non-exact, flag-smuggling, control and oversize UTF8 IDs before native invocation", async () => {
    const { setPrinterVisibility } = await import("../src/desktop/lib/ipc");
    for (const id of ["", " local", "local ", "-config", "local\nqueue", "local\u0085queue", "ط".repeat(129),
      "\uD800", "\uDC00", "printer\uD800id", "printer\uDC00id"]) {
      await expect(setPrinterVisibility(id, true)).rejects.toThrow("Invalid local printer sharing request");
    }
    expect(boundary.invoke).not.toHaveBeenCalled();
    const id = "ط".repeat(128);
    boundary.invoke.mockResolvedValue({ printerId: id, availableToOdoo: true });
    await expect(setPrinterVisibility(id, true)).resolves.toEqual({ printerId: id, availableToOdoo: true, sharedWithGateway: true });
    // A valid pair remains a single exact UTF-8 identity; reject only
    // malformed lone surrogates, never real Arabic/emoji printer names.
    const astral = "queue-\uD83D\uDDA8";
    boundary.invoke.mockResolvedValueOnce({ printerId: astral, availableToOdoo: true });
    await expect(setPrinterVisibility(astral, true)).resolves.toEqual({ printerId: astral, availableToOdoo: true, sharedWithGateway: true });
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

describe("Printers page agent identity fallback", () => {
  it("shows this computer hostname or local fallback for local printers and keeps Unknown agent only for unattributed remote printers", () => {
    const withHostname = renderToStaticMarkup(tree(h(PrintersPage, {
      s: state({ agentStatus: { running: true, hostname: "POS-PC-01" }, printers: [local], filteredPrinters: [local], localPrinters: [local] }),
    })));
    expect(withHostname).toContain("POS-PC-01");
    expect(withHostname).not.toContain("Unknown agent");

    const withoutHostname = renderToStaticMarkup(tree(h(PrintersPage, {
      s: state({ agentStatus: null, printers: [local], filteredPrinters: [local], localPrinters: [local] }),
    })));
    expect(withoutHostname).toContain("This PC");
    expect(withoutHostname).not.toContain("Unknown agent");

    const remoteUnattributed = { ...cloud, agentName: undefined, localObservedAt: undefined };
    const remoteHtml = renderToStaticMarkup(tree(h(PrintersPage, {
      s: state({ printers: [remoteUnattributed], filteredPrinters: [remoteUnattributed], localPrinters: [] }),
    })));
    expect(remoteHtml).toContain("Unknown agent");
  });
});
