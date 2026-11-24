import { verifiedPrinterState } from "./helpers/printer-verification";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { printerDisplayName, printerPresentation, printerStatusDetail } from "../src/shared/printer-presentation";
import { isMainInventoryPrinter, printerHealthCounts } from "../src/desktop/lib/printers";

const now = Date.parse("2026-10-14T12:00:00Z");
const fresh = {
  ...verifiedPrinterState("printer_spooler_0123456789abcdef", new Date(now)),
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
  it("opens a printer queue and retains management details without customer Test Print", () => {
    const page = readFileSync("src/desktop/pages/Printers.tsx", "utf8");
    const main = readFileSync("src/desktop/main.tsx", "utf8");
    // Printer rows open management details; the "View jobs" entry point now
    // lives in that drawer, not on the row itself.
    expect(page).toContain('onClick={() => s.setSelectedPrinter(p)}');
    expect(main).toContain("setJobPrinterFilter(selectedPrinter.id);");
    expect(page).toContain('value="saved"');
    expect(page).not.toContain("s.handleTest(");
    expect(page).not.toContain("gatewayTestPrinterIds");
    expect(main).not.toContain("handleTest");
    expect(page).not.toMatch(/disabled=\{[^}]*view\.state/);
    expect(main).toContain("const selectedPrinter = resolvedSelectedPrinter;");
    expect(main).toContain("selectedPrinter.reportedStatus || selectedPrinter.status");
    expect(main).toContain('t("printer.presentation.details")');
  });
});

describe("reported Windows status is the displayed status", () => {
  // Same fresh, live-Agent evidence as `fresh`, but with NO operational
  // verification proof at all. Verification gates job admission; it must
  // never mask the status Windows actually reported — that masking is
  // what badged every healthy printer "pending verification" /
  // "needs attention" while Windows showed Ready.
  const unverified = {
    ...fresh,
    verificationState: "pending" as const,
    verificationVerifiedAt: null,
    verificationReceivedAt: null,
    verificationBindingDigest: null,
    logicalQueueKey: null,
  };

  it("shows a fresh online printer as ready without any verification proof", () => {
    expect(printerPresentation(unverified, undefined, now)).toMatchObject({
      state: "ready", tone: "ok", labelKey: "printer.presentation.ready",
    });
  });

  it("shows busy as printing and unknown as unavailable without proof", () => {
    expect(printerPresentation({ ...unverified, status: "busy" }, undefined, now).state).toBe("printing");
    expect(printerPresentation({ ...unverified, status: "unknown" }, undefined, now).state).toBe("unavailable");
  });

  it("labels each physical condition precisely instead of a generic needs-attention", () => {
    const cases: Array<[string, string, string, string]> = [
      // [status, detail, expected labelKey, expected reasonKey]
      ["offline", "windows_offline", "printer.presentation.offline", "printer.detail.windows_offline"],
      ["offline", "windows_work_offline", "printer.presentation.offline", "printer.detail.windows_work_offline"],
      ["error", "windows_paper_jam", "printer.presentation.paperJam", "printer.detail.windows_paper_jam"],
      ["error", "windows_paper_out", "printer.presentation.paperOut", "printer.detail.windows_paper_out"],
      ["error", "windows_door_open", "printer.presentation.doorOpen", "printer.detail.windows_door_open"],
      ["error", "windows_no_toner", "printer.presentation.noToner", "printer.detail.windows_no_toner"],
      ["error", "windows_paused", "printer.presentation.paused", "printer.detail.windows_paused"],
      ["error", "windows_manual_feed", "printer.presentation.manualFeed", "printer.detail.windows_manual_feed"],
      ["error", "windows_job_error", "printer.presentation.attention", "printer.detail.windows_job_error"],
      ["error", "windows_user_intervention", "printer.presentation.attention", "printer.detail.windows_user_intervention"],
    ];
    for (const [status, detail, labelKey, reasonKey] of cases) {
      const view = printerPresentation({ ...unverified, status, capabilities: { status_detail: detail } }, undefined, now);
      expect(view, `${status}/${detail}`).toMatchObject({ state: "attention", labelKey, reasonKey });
    }
  });

  it("keeps toner-low a ready printer with a toner-low label", () => {
    expect(printerPresentation({ ...unverified, status: "online", capabilities: { status_detail: "windows_toner_low" } }, undefined, now))
      .toMatchObject({ state: "ready", labelKey: "printer.presentation.tonerLow", reasonKey: "printer.detail.windows_toner_low" });
  });

  it("reads the detail code from local discovery rows (spooler_status_detail)", () => {
    expect(printerPresentation({ ...unverified, status: "error", capabilities: { spooler_status_detail: "windows_paper_jam" } }, undefined, now))
      .toMatchObject({ state: "attention", labelKey: "printer.presentation.paperJam" });
    expect(printerStatusDetail({ capabilities: { spooler_status_detail: "windows_paper_jam" } })).toBe("Paper is jammed in the printer.");
    expect(printerStatusDetail({ capabilities: { status_detail: "windows_job_error" } })).toBe("A print job in this queue is in an error state.");
  });

  it("still hides status when the Agent or the observation is not fresh", () => {
    expect(printerPresentation({ ...unverified, agentStatus: "offline" }, undefined, now).state).toBe("unavailable");
    expect(printerPresentation({ ...unverified, lastSeenAt: new Date(now - 3600000).toISOString() }, undefined, now).state).toBe("unavailable");
  });
});
