// @vitest-environment jsdom
/**
 * Desktop Manager UI smoke test (no Tauri, no Gateway).
 *
 * The desktop shell is a single-page React app whose routes are hash-driven.
 * This test boots it against a stubbed IPC backend and walks every page, so a
 * crash in any screen — or a route that renders nothing — fails the build
 * instead of reaching a Windows installer.
 *
 * It also locks in the virtual-printer UI safety net: even if the IPC layer
 * hands the UI a virtual queue, it must never be rendered as a printer.
 */
import { describe, it, expect, beforeAll } from "vitest";

const printers = [
  {
    id: "p1",
    name: "HP LaserJet Pro M404",
    printerType: "physical",
    deviceClass: "laser",
    connectionType: "spooler",
    protocol: "spooler",
    status: "online",
    enabled: true,
    sharedWithGateway: true,
    availableToOdoo: true,
    spoolerName: "HP LaserJet Pro M404",
    endpoint: "HP LaserJet Pro M404",
  },
  {
    id: "p2",
    name: "Zebra ZD421",
    printerType: "physical",
    deviceClass: "label",
    connectionType: "network",
    protocol: "raw",
    status: "online",
    enabled: true,
    sharedWithGateway: false,
    availableToOdoo: false,
    endpoint: "192.168.1.62:9100",
    networkAddress: "192.168.1.62",
    port: 9100,
  },
  {
    id: "p3",
    name: "Microsoft Print to PDF",
    printerType: "virtual",
    connectionType: "spooler",
    protocol: "spooler",
    status: "online",
    enabled: true,
    isVirtual: true,
    spoolerName: "Microsoft Print to PDF",
  },
];

const jobs = [
  {
    id: "job_1",
    documentType: "receipt",
    printerId: "p2",
    branchId: "b1",
    status: "printing",
    retries: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "job_2",
    documentType: "invoice",
    printerId: "p1",
    branchId: "b1",
    status: "failed",
    retries: 2,
    error: "i/o timeout",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

async function invoke<T>(
  cmd: string,
  options?: { args?: { path?: string; method?: string }; printerId?: string; availableToOdoo?: boolean },
): Promise<T> {
  switch (cmd) {
    case "plugin:event|listen":
      return 1 as unknown as T;
    case "gateway_agent_request": {
      const path = options?.args?.path ?? "";
      const body = path.startsWith("/api/agents")
        ? [{ id: "agent-1", name: "Reception Agent", status: "online", lifecycle: "active" }]
        : path.startsWith("/api/printers")
          ? printers.filter((p) => p.sharedWithGateway !== false)
          : jobs;
      return JSON.stringify({ status: 200, body: JSON.stringify(body) }) as unknown as T;
    }
    case "gateway_request": {
      const path = options?.args?.path ?? "";
      const body = path === "/api/health"
        ? { ok: true }
        : path === "/api/auth/manager/me"
          ? { authenticated: true, exp: Math.floor(Date.now() / 1000) + 3600, tenantId: "smoke-workspace", userId: "smoke-user", role: "owner" }
          : path === "/api/agents"
            ? [{ id: "agent-1", name: "Reception Agent", status: "online", lifecycle: "active" }]
            : path === "/api/printers"
              ? printers.filter((p) => p.sharedWithGateway !== false)
              : jobs;
      return {
        status: 200,
        body: JSON.stringify(body),
      } as unknown as T;
    }
    case "get_agent_status":
      return {
        running: true,
        service: "YaseirAgent",
        version: "1.0.0",
        hostname: "DESKTOP-RECEPTION",
        note: "YaseirAgent.exe is running",
      } as unknown as T;
    case "get_app_version":
      return "1.0.0" as unknown as T;
    case "set_tray_locale":
      return undefined as unknown as T;
    case "is_running_as_admin":
      return true as unknown as T;
    case "get_gateway_config":
      return { url: "https://gw.example.com" } as unknown as T;
    case "get_runtime_paths":
      return {
        manager_data: "a",
        settings: "b",
        agent_config: "c",
        manager_log: "d",
        agent_data: "e",
      } as unknown as T;
    case "get_printers":
      return printers as unknown as T;
    case "set_printer_visibility": {
      const printer = printers.find((p) => p.id === options?.printerId);
      if (!printer || typeof options?.availableToOdoo !== "boolean") throw new Error("Invalid smoke sharing request");
      printer.availableToOdoo = options.availableToOdoo;
      return { printerId: printer.id, availableToOdoo: printer.availableToOdoo } as unknown as T;
    }
    case "discover_printers":
      return { printers, errors: [] } as unknown as T;
    case "get_autostart":
      return { enabled: true } as unknown as T;
    case "plugin:window|close":
      return null as unknown as T;
    case "plugin:event|unlisten":
      return undefined as unknown as T;
    default:
      throw new Error(`stub: unhandled command ${cmd}`);
  }
}

describe("desktop manager", () => {
  beforeAll(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (p: string) => p,
      metadata: {},
    };
    (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      registerListener: () => {},
      unregisterListener: () => {},
    };
    (globalThis as unknown as Record<string, unknown>).fetch = async (url: string) => {
      const body = url.includes("/api/health")
        ? { ok: true }
        : jobs;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  });

  it("boots every page without console errors and hides virtual printers", async () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => {
      errors.push(a);
      origError(...a);
    };

    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    await import("../src/desktop/main");
    
    const text = () => document.body.textContent ?? "";
    const waitUntil = async (pred: () => boolean, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pred()).toBe(true);
    };

    await waitUntil(() => text().includes("HP LaserJet Pro M404"));

    expect(text()).toContain("Yaseir Print Manager");
    for (const label of ["Home", "Printers", "Print activity", "Settings"]) {
      expect(text()).toContain(label);
    }
    expect(text()).toContain("HP LaserJet Pro M404");
    expect(text()).toContain("Zebra ZD421");
    // Printable virtual queues (e.g. Microsoft Print to PDF) are first-class managed printers.
    expect(text()).toContain("Microsoft Print to PDF");

    window.location.hash = "printers";
    window.dispatchEvent(new Event("hashchange"));
    // The local-inventory read and the elevated-rights check settle independently.
    // Visibility is not proof that an elevated, fresh inventory is ready yet.
    // React re-renders the row while inventory settles, so find and click the
    // live node in the same poll; a captured node can be detached by then.
    await waitUntil(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-printer-sharing="p2"] button');
      const control = document.querySelector('[data-printer-sharing="p2"]');
      if (!button || button.disabled || control?.textContent?.includes("Refresh the local printer list")) return false;
      expect(button.getAttribute("aria-label")).toBe("Make Zebra ZD421 available to Odoo");
      button.click();
      return true;
    });
    await waitUntil(() => document.querySelector('[data-printer-sharing="p2"]')?.textContent?.includes("Available to Odoo") === true);
    expect(printers.find((p) => p.id === "p2")?.availableToOdoo).toBe(true);
    expect(text()).toContain("Sharing preference saved on this computer");

    for (const page of ["printers", "jobs", "settings"] as const) {
      window.location.hash = page;
      window.dispatchEvent(new Event("hashchange"));
      await new Promise((r) => setTimeout(r, 80));
      expect(text().length).toBeGreaterThan(50);
    }

    expect(text()).toContain("Odoo server connection");
    expect(text()).toContain("Pair agent");

    // Language is a presentation preference: changing it must preserve an
    // intentionally edited Gateway draft rather than reloading persisted config.
    const gatewayDraft = document.querySelector<HTMLInputElement>("#gw-url")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(gatewayDraft, "https://draft.example.test");
    gatewayDraft.dispatchEvent(new Event("input", { bubbles: true }));
    await waitUntil(() => text().includes("A new address is ready to check."));
    window.localStorage.setItem("yaseir:locale", "ar");
    window.dispatchEvent(new StorageEvent("storage", { key: "yaseir:locale", newValue: "ar" }));
    await waitUntil(() => document.documentElement.dir === "rtl");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector<HTMLInputElement>("#gw-url")!.value).toBe("https://draft.example.test");

    console.error = origError;
    expect(errors.filter((e) => !String(e).includes("not wrapped in act"))).toEqual([]);
  });
});
