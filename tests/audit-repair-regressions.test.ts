import { describe, expect, it } from "vitest";
import { codeMessageKey } from "../src/lib/api-error-keys";
import { isVirtualPrinterMetadata, isVirtualPrinterRecord } from "../src/lib/printer-virtual";

describe("audit repair regressions", () => {
  it("rejects inherited error-code properties while resolving known codes", () => {
    for (const code of ["constructor", "toString", "__proto__"]) expect(codeMessageKey(code)).toBeNull();
    expect(codeMessageKey("PRINTER_NOT_FOUND")).toBe("errors.printerNotFound");
  });
  it("keeps physical Enhanced Point and Print queues selectable", () => {
    expect(isVirtualPrinterRecord({ name: "Office", connectionType: "spooler", protocol: "spooler", driverName: "Microsoft enhanced point and print compatibility driver", port: "\\\\server\\queue" })).toBe(false);
    expect(isVirtualPrinterMetadata({ name: "Office", driverName: "Microsoft Print to PDF", port: "PORTPROMPT:" })).toBe(true);
    expect(isVirtualPrinterRecord({ name: "Office", driverName: "Microsoft Print to PDF", port: "PORTPROMPT:" })).toBe(false);
    expect(isVirtualPrinterRecord({ name: "Office", driverName: "Microsoft Shared Fax Driver", port: "SHRFAX:" })).toBe(true);
  });
});
