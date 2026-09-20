import { describe, expect, it } from "vitest";
import { validateConnectionConfig, assertPrinterMetadataLimits, PRINTER_CONFIG_MAX_BYTES } from "../src/lib/printer-model";

describe("printer destination security policy", () => {
  it("enforces metadata limits by UTF-8 bytes", () => {
    const unicodeValue = "😀".repeat(Math.ceil(PRINTER_CONFIG_MAX_BYTES / 4));
    expect(() => assertPrinterMetadataLimits({ config: { serial: unicodeValue }, capabilities: undefined })).toThrow(/16KB/);
  });

  it("accepts private/link-local RAW printer endpoints", () => {
    expect(validateConnectionConfig("network", { ip: "192.168.1.50", port: 9100 })).toBeNull();
    expect(validateConnectionConfig("network", { ip: "192.168.1.50", port: 9100, address: "192.168.1.50:9100" })).toBeNull();
    expect(validateConnectionConfig("network", { ip: "192.168.1.50", port: 9100, address: "8.8.8.8:9100" })).toContain("conflicts");
    expect(validateConnectionConfig("network", { ip: "192.168.1.50", port: 9101 })).toContain("port must be 9100");
    expect(validateConnectionConfig("network", { ip: "10.20.30.40", port: 9100 })).toBeNull();
    expect(validateConnectionConfig("network", { ip: "fe80::10", port: 9100 })).toBeNull();
  });

  it("rejects public, loopback, hostname, metadata and non-print ports", () => {
    for (const ip of ["8.8.8.8", "127.0.0.1", "0.0.0.0", "169.254.169.254"] as const) {
      const result = validateConnectionConfig("network", { ip, port: 9100 });
      expect(result).toContain("private or link-local");
    }
    expect(validateConnectionConfig("network", { ip: "printer.local", port: 9100 })).toContain("private or link-local");
  });

  it("accepts private IPP endpoints and rejects public URLs", () => {
    expect(validateConnectionConfig("ipp", { address: "ipp://192.168.1.60/ipp/print" })).toBeNull();
    expect(validateConnectionConfig("ipps", { address: "https://10.0.0.20:631/ipp/print" })).toBeNull();
    expect(validateConnectionConfig("ipp", { address: "http://127.0.0.1:631/ipp/print" })).toContain("private or link-local");
    expect(validateConnectionConfig("ipp", { address: "https://169.254.169.254/ipp/print" })).toContain("private or link-local");
    expect(validateConnectionConfig("ipp", { address: "https://example.com/ipp/print" })).toContain("private or link-local");
    expect(validateConnectionConfig("ipp", { address: "https://192.168.1.60/ipp/print?q=1" })).toContain("query strings");
    expect(validateConnectionConfig("ipp", { address: "ipp://user:pass@192.168.1.60/ipp/print" })).toContain("embedded credentials");
    expect(validateConnectionConfig("ipps", { address: "https://user:pass@192.168.1.60/ipp/print" })).toContain("embedded credentials");
    expect(validateConnectionConfig("ipps", { address: "http://192.168.1.60:631/ipp/print" })).toContain("HTTPS/IPPS address");
  });

  it("canonicalizes USB printers backed by the Windows spooler", async () => {
    const { parsePrinterInput } = await import("../src/lib/printer-model");
    const parsed = parsePrinterInput({
      name: "USB Spooler",
      agentId: "a1",
      connectionType: "usb",
      protocol: "unknown",
      config: { spooler_name: "HP LaserJet" },
    });
    expect(parsed.connectionType).toBe("spooler");
    expect(parsed.protocol).toBe("spooler");
  });

  it("rejects incomplete direct USB registration metadata", async () => {
    const { parsePrinterInput } = await import("../src/lib/printer-model");
    expect(() => parsePrinterInput({
      name: "USB Missing IDs", agentId: "a1", connectionType: "usb", protocol: "raw",
      config: { address: "\\\\?\\usb#device" },
    })).toThrow(/direct USB printer requires config\.(vid|pid)/i);
    expect(() => parsePrinterInput({
      name: "USB Missing Path", agentId: "a1", connectionType: "usb", protocol: "raw",
      config: { vid: 1234, pid: 5678 },
    })).toThrow(/config\.address/i);
    expect(parsePrinterInput({
      name: "USB Complete", agentId: "a1", connectionType: "usb", protocol: "raw",
      config: { vid: 1234, pid: 5678, address: "\\\\?\\usb#device" },
    }).connectionType).toBe("usb");
    expect(() => parsePrinterInput({
      name: "USB Spooler Injection", agentId: "a1", connectionType: "usb", protocol: "raw",
      config: { vid: 1234, pid: 5678, address: "HP LaserJet" },
    })).toThrow(/Windows device path/i);
  });

  it("rejects ambiguous USB spooler protocol without a spooler queue", async () => {
    const { parsePrinterInput } = await import("../src/lib/printer-model");
    expect(() => parsePrinterInput({
      name: "USB Spooler Ambiguous", agentId: "a1", connectionType: "usb", protocol: "spooler",
      config: { vid: 1234, pid: 5678, address: "\\\\?\\usb#device" },
    })).toThrow(/connection type spooler.*spooler_name/i);
  });

  it("rejects contradictory USB transport protocols", async () => {
    const { parsePrinterInput } = await import("../src/lib/printer-model");
    expect(() => parsePrinterInput({
      name: "USB IPP", agentId: "a1", connectionType: "usb", protocol: "ipp",
      config: { vid: 1234, pid: 5678, address: "\\\\?\\usb#device" },
    })).toThrow(/usb connection type does not support protocol ipp/i);
    expect(() => parsePrinterInput({
      name: "USB IPPS", agentId: "a1", connectionType: "usb", protocol: "ipps",
      config: { vid: 1234, pid: 5678, address: "\\\\?\\usb#device" },
    })).toThrow(/usb connection type does not support protocol ipps/i);
  });

  it("rejects contradictory transport/protocol declarations", async () => {
    const { parsePrinterInput } = await import("../src/lib/printer-model");
    expect(() => parsePrinterInput({
      name: "Bad IPP", agentId: "a1", connectionType: "ipp", protocol: "raw",
      config: { address: "ipp://192.168.1.60/ipp/print" },
    })).toThrow(/ipp protocol/i);
    expect(() => parsePrinterInput({
      name: "Bad IPPS", agentId: "a1", connectionType: "ipps", protocol: "ipp",
      config: { address: "ipps://192.168.1.60/ipp/print" },
    })).toThrow(/ipps protocol/i);
    expect(() => parsePrinterInput({
      name: "Bad Spooler", agentId: "a1", connectionType: "spooler", protocol: "raw",
      config: { spooler_name: "HP" },
    })).toThrow(/spooler protocol/i);
  });
});
