import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { printerDisplayName, printerPresentation, printerStatusDetail } from "../src/shared/printer-presentation";
import { isMainInventoryPrinter, printerHealthCounts } from "../src/desktop/lib/printers";

const now = Date.parse("2026-10-14T12:00:00Z");
const fresh = {
  id: "printer_spooler_0123456789abcdef", name: "Front desk", status: "online", enabled: true,
  lastSeenAt: new Date(now - 1000).toISOString(), agentId: "owner", agentStatus: "online",
  agentLastSeenAt: new Date(now - 1000).toISOString(), agentLifecycle: "active", lifecycle: "active" as const,
};

describe("four printer presentation states retain underlying evidence", () => {
  it.each([
    ["online", "ready"], ["idle", "ready"], ["busy", "printing"], ["printing", "printing"],
    ["offline", "attention"], ["error", "attention"], ["paper_out", "attention"],
    ["unknown", "unavailable"], ["unreachable", "unavailable"],
  ])("projects observed %s as %s", (status, state) => {
    const printer = { ...fresh, status };
    expect(printerPresentation(printer, undefined, now).state).toBe(state);
    expect(printer.status).toBe(status);
  });

  it("puts unavailable Agent evidence before cached online or fault labels", () => {
    for (const status of ["online", "error", "offline"]) {
      const view = printerPresentation({ ...fresh, status, agentStatus: "unknown" }, undefined, now);
      expect(view).toMatchObject({ state: "unavailable", reasonKey: "printer.presentation.agentUnavailableReason" });
    }
    expect(printerPresentation(fresh, null, now).state).toBe("unavailable");
    expect(printerPresentation({ status: "online", lastSeenAt: fresh.lastSeenAt }, undefined, now)).toMatchObject({ state: "unavailable", reasonKey: "printer.presentation.agentUnavailableReason" });
    // An omitted paginated Agent row must use the printer's embedded owner.
    expect(printerPresentation(fresh, undefined, now).state).toBe("ready");
  });

  it("re-evaluates stale, missing, future and inactive evidence", () => {
    for (const lastSeenAt of [undefined, "invalid", new Date(now + 1000).toISOString(), new Date(now - 3600000).toISOString()]) {
      expect(printerPresentation({ ...fresh, lastSeenAt }, undefined, now).state).toBe("unavailable");
    }
    expect(printerPresentation(fresh, undefined, now + 3600000).state).toBe("unavailable");
    expect(printerPresentation({ ...fresh, agentFreshness: "stale" }, undefined, now).state).toBe("unavailable");
    expect(printerPresentation({ ...fresh, lifecycle: "disabled" }, undefined, now)).toMatchObject({ state: "attention", reasonKey: "printer.presentation.inactiveReason" });
    expect(printerPresentation({ ...fresh, inventoryPresent: false }, undefined, now).state).toBe("unavailable");
  });

  it("counts a busy queue as available and retains absent/inactive devices outside main inventory", () => {
    const saved = { ...fresh, id: "saved", inventoryPresent: false };
    const disabled = { ...fresh, id: "disabled", lifecycle: "disabled" as const };
    const printers = [fresh, { ...fresh, id: "busy", status: "busy" }, { ...fresh, id: "unknown", status: "unknown" }, saved, disabled];
    expect(printerHealthCounts(printers, now)).toMatchObject({ ready: 1, printing: 1, unavailable: 1, attention: 0, online: 2 });
    expect(printers.filter(isMainInventoryPrinter).map((p) => p.id)).toEqual([fresh.id, "busy", "unknown"]);
    expect(printers).toContain(saved);
    expect(printers).toContain(disabled);
  });
});

describe("readable printer names", () => {
  it("keeps operator and Windows queue names intact including Arabic", () => {
    expect(printerDisplayName({ ...fresh, name: "  طابعة المحاسب  ", spoolerName: "POS80" }, "ar")).toBe("طابعة المحاسب");
    expect(printerDisplayName({ ...fresh, name: "", spoolerName: "HP_Color_LaserJet" })).toBe("HP_Color_LaserJet");
  });
  it("keeps opaque IDs and USB device paths out of the primary name", () => {
    expect(printerDisplayName({ ...fresh, name: fresh.id, config: { spooler_name: "POS80" } })).toBe("POS80");
    expect(printerDisplayName({ id: "printer_a", name: "printer_a", config: { spooler_name: "Canon" } })).toBe("Canon");
    expect(printerDisplayName({ id: "printer_a", name: "printer_a", displayName: "Reception" })).toBe("Reception");
    expect(printerDisplayName({ ...fresh, name: "", endpoint: "192.168.2.10:9100" })).toBe("Printer at 192.168.2.10:9100");
    expect(printerDisplayName({ ...fresh, name: "", endpoint: "\\\\?\\USB#TEST" })).toBe("Printer");
    expect(printerDisplayName({ ...fresh, name: "", endpoint: "\\\\.\\USB#TEST" })).toBe("Printer");
    expect(printerDisplayName({ ...fresh, name: "\\\\?\\USB#TEST", displayName: "Receipt printer" })).toBe("Receipt printer");
    expect(printerDisplayName({ ...fresh, name: "\\\\.\\USB#TEST", spoolerName: "POS80" })).toBe("POS80");
    expect(printerDisplayName({ name: "", config: { address: "printer.local:9100" } })).toBe("Printer at printer.local:9100");
    expect(printerDisplayName({ name: "", config: { ipp_url: "ipp://printer.local/printers/front" } })).toBe("Printer at printer.local/printers/front");
  });
});

describe("printer diagnostic details", () => {
  it("translates every native Windows detail code in both catalogs", () => {
    for (const suffix of ["work_offline", "offline", "server_offline", "unavailable", "pending_deletion", "paused", "paper_jam", "paper_out", "door_open", "manual_feed", "paper_problem", "output_bin_full", "no_toner", "user_intervention", "out_of_memory", "page_punt", "error", "initializing", "busy", "status_unknown", "toner_low", "power_save", "waiting"]) {
      const code = `windows_${suffix}`;
      for (const locale of ["en", "ar"] as const) {
        expect(printerStatusDetail({ capabilities: { status_detail: code } }, locale)).not.toBe(code);
      }
    }
  });
  it("localizes stable Windows flags without changing the primary state", () => {
    const printer = { ...fresh, status: "error", capabilities: { status_detail: "windows_paper_out" } };
    expect(printerStatusDetail(printer)).toBe("The printer is out of paper.");
    expect(printerStatusDetail(printer, "ar")).toBe("الورق نفد من الطابعة.");
    expect(printerPresentation(printer, undefined, now).state).toBe("attention");
    expect(printer.status).toBe("error");
  });
  it("retains unrecognized diagnostic evidence only as detail", () => {
    expect(printerStatusDetail({ capabilities: { status_detail: "driver-specific evidence" } })).toBe("driver-specific evidence");
    expect(printerStatusDetail({ capabilities: { status_detail: "toString" } })).toBe("toString");
    expect(printerStatusDetail({ capabilities: { status_detail: 123 } })).toBe("");
  });
});

describe("desktop primary printer wiring", () => {
  it("opens a printer queue and retains unknown-health Test and management details", () => {
    const page = readFileSync("src/desktop/pages/Printers.tsx", "utf8");
    const main = readFileSync("src/desktop/main.tsx", "utf8");
    expect(page).toContain('s.setJobPrinterFilter(id); s.setJobTab("all"); s.setJobSearch("");');
    expect(page).toContain('value="saved"');
    expect(page).toContain("onClick={() => s.handleTest(p.id)}");
    expect(page).not.toMatch(/disabled=\{[^}]*view\.state/);
    expect(main).toContain("const selectedPrinter = resolvedSelectedPrinter;");
    expect(main).toContain("selectedPrinter.reportedStatus || selectedPrinter.status");
    expect(main).toContain('t("printer.presentation.details")');
  });
});
