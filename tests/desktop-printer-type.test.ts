import { describe, expect, it } from "vitest";
import { humanType } from "../src/desktop/lib/printers";
import type { PrinterInfo } from "../src/desktop/lib/ipc";

const printer: PrinterInfo = { id: "local", name: "Receipt", status: "unknown", enabled: true };

describe("local printer device class", () => {
  it.each(["en", "ar"] as const)("uses the CLI's legacy class with the same localized label as Gateway (%s)", (locale) => {
    for (const deviceClass of ["thermal", "laser", "inkjet", "label"]) {
      const expected = humanType({ ...printer, deviceClass }, locale);
      expect(humanType({ ...printer, printerType: deviceClass }, locale)).toBe(expected);
      expect(humanType({ ...printer, printer_type: deviceClass }, locale)).toBe(expected);
    }
  });

  it("preserves the Gateway class and does not turn ownership types into device classes", () => {
    expect(humanType({ ...printer, deviceClass: "laser", printerType: "thermal" })).toBe("Laser");
    for (const printerType of ["physical", "virtual", "redirected", "file"]) {
      expect(humanType({ ...printer, printerType })).toBe(humanType(printer));
    }
    expect(humanType({ ...printer, connectionType: "usb", printerType: "physical" })).toBe("USB device");
  });
});
