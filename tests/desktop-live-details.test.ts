// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  root: null as Root | null,
  origin: "https://first.example.test",
  jobs: [] as Array<Record<string, unknown>>,
  jobReads: 0,
  failInventory: false,
  saveNotificationFails: false,
}));

vi.mock("react-dom/client", async (original) => {
  const client = await original<typeof import("react-dom/client")>();
  return { ...client, createRoot: (...args: Parameters<typeof client.createRoot>) => {
    fixture.root = client.createRoot(...args);
    return fixture.root;
  } };
});

// Mock only the native/HTTP boundary. The App, pages, drawers, state updates,
// translation and physical-outcome presentation all execute unchanged.
vi.mock("../src/desktop/lib/ipc", async (original) => ({
  ...await original<typeof import("../src/desktop/lib/ipc")>(),
  isTauri: true,
  getGatewayUrl: async () => fixture.origin,
  setGatewayUrl: async (origin: string) => {
    fixture.origin = origin;
    if (fixture.saveNotificationFails) throw new Error("Gateway saved but change notification failed");
    return "saved";
  },
  getAgentStatus: async () => ({ running: true, note_code: "service_running", hostname: "synthetic-host" }),
  getAppVersion: async () => "test",
  getRuntimePaths: async () => null,
  getAutostart: async () => ({ enabled: false }),
  isRunningAsAdmin: async () => true,
  setTrayLocale: async () => undefined,
  onTrayNavigate: async () => () => {},
  onTrayRestartAgent: async () => () => {},
  onGatewayConfigChanged: async () => () => {},
  getPrinters: async () => [],
  probeGatewayHealth: async () => ({ ok: true, service: "yaseir-print-gateway" }),
  fetchGatewayPrinters: async () => {
    if (fixture.failInventory) throw new Error("Paired Agent origin does not match");
    return [{ id: "printer-first", name: "First Gateway printer", status: "unknown", enabled: true, lifecycle: "active" }];
  },
  fetchGatewayAgents: async () => [],
  fetchGatewayJobs: async () => {
    fixture.jobReads += 1;
    if (fixture.failInventory) throw new Error("Paired Agent origin does not match");
    return structuredClone(fixture.jobs);
  },
}));

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function navigate(page: string) {
  await act(async () => {
    window.location.hash = page;
    window.dispatchEvent(new Event("hashchange"));
  });
  await flush();
}

async function click(button: HTMLButtonElement | null | undefined) {
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
}

function jobDrawer() {
  return document.querySelector('[role="dialog"][aria-label="Job details"]');
}

beforeEach(async () => {
  vi.resetModules();
  fixture.origin = "https://first.example.test";
  fixture.jobs = [{ id: "job-live", printerId: "printer-first", documentType: "receipt", status: "printing", createdAt: "2026-10-25T01:00:00Z", updatedAt: "2026-10-25T01:00:00Z" }];
  fixture.jobReads = 0;
  fixture.failInventory = false;
  fixture.saveNotificationFails = false;
  document.body.innerHTML = '<div id="root"></div>';
  window.localStorage.clear();
  window.location.hash = "jobs";
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => { await import("../src/desktop/main"); });
  await flush();
});

afterEach(async () => {
  await act(async () => { fixture.root?.unmount(); });
  fixture.root = null;
  document.body.innerHTML = "";
});

describe("Desktop detail identity follows current Gateway evidence", () => {
  it("labels the editable Windows queue when no discovered spooler can be selected", async () => {
    await navigate("printers");
    await click([...document.querySelectorAll<HTMLButtonElement>("main button")].find((button) => button.textContent === "Manual printer setup"));
    // The dialog auto-searches first; with nothing selectable it lands
    // on an explicit empty state (this fixture's discovery fails, so it
    // is the search-failed variant), and the editable queue field
    // appears only after the user chooses manual entry.
    expect(document.body.textContent).toContain("The printer search failed");
    expect(document.body.textContent).toContain("Search again");
    await click([...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Enter the queue name manually"));
    const controls = document.querySelectorAll("#pp-spooler");
    expect(controls).toHaveLength(1);
    expect(controls[0].tagName).toBe("INPUT");
    const input = controls[0] as HTMLInputElement;
    expect(input.labels?.length).toBe(1);
    expect(input.labels?.[0].textContent?.trim()).toBeTruthy();
    expect(input.labels?.[0].control).toBe(input);
    const activated = vi.fn();
    input.addEventListener("click", activated);
    await act(async () => { input.labels?.[0].click(); });
    // JSDOM forwards label activation but does not implement native focus
    // movement (also reproducible on a plain label/input outside this App).
    expect(activated).toHaveBeenCalledOnce();
  });

});
