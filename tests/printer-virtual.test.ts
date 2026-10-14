import { describe, expect, it } from "vitest";
import { isPrinterAvailableForJob } from "../src/lib/routing";
import { isVirtualPrinterRecord } from "../src/lib/printer-virtual";
import { isVirtualPrinter, isProductionPrinter } from "../src/desktop/lib/printers";
import type { PrinterInfo } from "../src/desktop/lib/ipc";

const VIRTUAL = [
  { name: "Microsoft Print to PDF", record: { printerType: "virtual" } },
  { name: "Microsoft XPS Document Writer", record: { printerType: "virtual" } },
  { name: "OneNote", record: { printerType: "virtual" } },
  { name: "OneNote (Desktop)", record: { printerType: "virtual" } },
  { name: "Fax", record: { printerType: "virtual" } },
  { name: "RDP redirected queue", record: { printerType: "virtual" } },
  { name: "legacy row only matched by name", record: { name: "Microsoft Print to PDF" } },
  { name: "print-to-FILE port", record: { port: "FILE:" } },
  { name: "NUL: port", record: { port: "NUL:" } },
  { name: "PORTPROMPT: port", record: { port: "PORTPROMPT:" } },
  { name: "Canon G4070 FAX spooler", record: { name: "Canon G4070 series FAX", printerType: "physical", connectionType: "spooler", capabilities: { port_name: "USB001" } } },
  { name: "Canon FAX driver behind normal queue", record: { name: "Canon G4070 series", printerType: "physical", driverName: "Canon G4070 series FAX", port: "USB001" } },
  { name: "Vendor FAX on network port", record: { name: "HP OfficeJet Pro FAX", printerType: "physical", port: "IP_192.168.1.70" } },
  { name: "Foxit driver", record: { driverName: "Foxit PDF Printer" } },
  { name: "AnyDesk driver", record: { driverName: "AnyDesk Printer" } },
  { name: "Remote Desktop Easy Print driver", record: { driverName: "Remote Desktop Easy Print" } },
  { name: "Terminal Services Easy Print driver", record: { driverName: "Terminal Services Easy Print" } },
  { name: "Citrix driver", record: { driverName: "Citrix Universal Printer" } },
  { name: "VMware driver", record: { driverName: "VMware Universal Printer" } },
  { name: "Citrix (from host) in session", record: { name: "Citrix (from host) in session" } },
];

describe("printer virtual classification", () => {
  it.each(VIRTUAL)("hides '$name'", ({ record }) => {
    expect(isVirtualPrinterRecord(record)).toBe(true);
  });

  it("rejects an explicitly redirected printer type", () => {
    expect(isVirtualPrinterRecord({ printerType: "redirected", name: "HP LaserJet" })).toBe(true);
  });

  it("keeps 'physical USB printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "usb", name: "Epson" })).toBe(false);
  });

  it("keeps 'physical TCP/IP printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "tcp", name: "HP" })).toBe(false);
  });

  it("keeps 'physical IPP printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "ipp", name: "Brother" })).toBe(false);
  });

  it("never treats a normal printer merely mentioning a fax room as software", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "spooler", name: "Fax Room Laser Printer", driverName: "HP Universal Printing PCL 6" })).toBe(false);
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "spooler", name: "Canon G4070 series", driverName: "Canon G4070 series Printer" })).toBe(false);
  });

  it("keeps 'physical Windows spooler printer'", () => {
    expect(isVirtualPrinterRecord({ printerType: "physical", connectionType: "spooler", name: "Canon" })).toBe(false);
  });

  it("keeps every legitimate hardware family routable", () => {
    for (const printerType of ["physical", "laser", "inkjet", "thermal", "receipt"]) {
      expect(isVirtualPrinterRecord({ printerType, connectionType: "tcp", name: `hardware-${printerType}` })).toBe(false);
    }
  });
});

describe("routing availability", () => {
  it("refuses a virtual printer even when it is online and enabled", () => {
    expect(
      isPrinterAvailableForJob({
        lifecycle: "active",
        status: "online",
        printerType: "virtual",
        name: "Microsoft Print to PDF",
      })
    ).toBe(false);
  });

  it("refuses a virtual printer detected only through capabilities", () => {
    expect(
      isPrinterAvailableForJob({
        lifecycle: "active",
        status: "unknown",
        capabilities: { virtual: true },
      })
    ).toBe(false);
  });

  it("keeps a physical printer available only with positive online telemetry", () => {
    expect(
      isPrinterAvailableForJob({ lifecycle: "active", status: "online", printerType: "physical", deviceClass: "laser" })
    ).toBe(true);
    // Unknown telemetry is intentionally unavailable: routing must not send a
    // job to a printer whose current health state has not been positively reported.
    expect(
      isPrinterAvailableForJob({ lifecycle: "active", status: "unknown", printerType: "physical", deviceClass: "laser" })
    ).toBe(false);
    expect(
      isPrinterAvailableForJob({ lifecycle: "active", status: "offline", printerType: "physical", deviceClass: "laser" })
    ).toBe(false);
    expect(
      isPrinterAvailableForJob({ lifecycle: "disabled", status: "online", printerType: "physical", deviceClass: "laser" })
    ).toBe(false);
  });
});

// The end-to-end routing behaviour (virtual candidate skipped, physical
// candidate chosen, PRINTER_VIRTUAL returned only when every candidate is
// virtual) is covered by tests/routing-virtual-regression.test.ts, which drives
// the real resolvePrinterForJob instead of asserting on source text.

describe("desktop manager safety net", () => {
  it.each(VIRTUAL)("hides $name from the printer list", ({ name, record }: { name: string; record: Record<string, unknown> }) => {
    const printer = {
      id: "p",
      name: record.name as string,
      printerType: record.printerType as string,
      connectionType: record.connectionType as string,
      port: record.port as string,
      driverName: record.driverName as string,
      capabilities: record.capabilities as Record<string, unknown>,
      status: "online",
      enabled: true,
    };
    expect(isVirtualPrinter(printer as unknown as PrinterInfo)).toBe(true);
  });
});

describe("friendly labels cannot mask actual Windows queue identity", () => {
  const physical = { name: "Chosen office label", printerType: "physical", connectionType: "spooler", protocol: "spooler" };
  it.each(["Microsoft Print to PDF", "Microsoft XPS Document Writer", "OneNote", "HP LaserJet (redirected 3)", "HP LaserJet redirected)", "HP (from HOST) in session4", "Canon G4070 series FAX"])("rejects aliased %s at every identity source", (queue) => {
    for (const identity of [
      { spoolerName: queue }, { spooler_name: queue }, { displayName: queue }, { display_name: queue },
      { config: { spooler_name: queue } }, { config: { address: queue } },
      { capabilities: { spooler_name: queue } }, { capabilities: { displayName: queue } }, { endpoint: queue },
    ]) {
      const row = { ...physical, ...identity };
      expect(isVirtualPrinterRecord(row)).toBe(true);
      expect(isPrinterAvailableForJob({ ...row, lifecycle: "active", status: "unknown" })).toBe(false);
      expect(isProductionPrinter({ ...row, id: "alias", status: "unknown", enabled: true })).toBe(false);
    }
  });

  it("preserves real Canon and shared physical queue admission despite friendly aliases", () => {
    for (const identity of [
      { config: { spooler_name: "Canon G4070 series" }, capabilities: { driver_name: "Canon G4070 series Printer", port_name: "USB001" } },
      { spoolerName: "\\\\server\\Office Queue", driverName: "Microsoft enhanced point and print compatibility driver", port: "\\\\server\\Office Queue" },
    ]) {
      const row = { ...physical, ...identity };
      expect(isVirtualPrinterRecord(row)).toBe(false);
      expect(isPrinterAvailableForJob({ ...row, lifecycle: "active", status: "unknown" })).toBe(true);
    }
    expect(isVirtualPrinterRecord({ name: "Real printer", printerType: "physical", connectionType: "network", protocol: "raw", endpoint: "Microsoft Print to PDF", config: { address: "Microsoft Print to PDF" } })).toBe(false);
  });
  it("keeps both legacy and canonical observed aliases in the Desktop guard", () => {
    expect(isVirtualPrinter({ ...physical, id: "mixed", status: "online", enabled: true,
      display_name: "Friendly display", displayName: "Microsoft Print to PDF",
      spooler_name: "Friendly queue", spoolerName: "HP LaserJet (redirected 3)",
    })).toBe(true);
  });
  it("recognizes native queue identity in a legacy USB+spooler declaration", () => {
    expect(isVirtualPrinterRecord({ name: "Friendly USB queue", connectionType: "usb", protocol: "spooler", endpoint: "Microsoft Print to PDF" })).toBe(true);
  });
});


describe("physical-only printer admission", () => {
  it("rejects obsolete capture and software-test flags even if a row spoofs a physical type", () => {
    for (const data of [
      { config: { virtual_spooler_test: true } },
      { config: { virtual_test_sink: true } },
      { capabilities: { virtual_spooler_test: true } },
      { capabilities: { virtual_test_sink: true } },
      { capabilities: { virtual: true } },
      { capabilities: { printer_class: "virtual" } },
    ]) {
      expect(isVirtualPrinterRecord({ printerType: "physical", name: "Ordinary printer", ...data })).toBe(true);
    }
  });
});
