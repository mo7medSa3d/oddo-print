import { describe, expect, it } from "vitest";
import { parsePrinterInput } from "../src/lib/printer-model";

describe("printer input protocol aliases", () => {
  it("canonicalizes windows_spooler to spooler before transport validation", () => {
    const parsed = parsePrinterInput({
      name: "Office queue",
      printerType: "laser",
      deviceClass: "laser",
      connectionType: "spooler",
      protocol: "windows_spooler",
      config: { spooler_name: "Office Printer" },
      capabilities: {},
    });

    expect(parsed.connectionType).toBe("spooler");
    expect(parsed.protocol).toBe("spooler");
  });
});
