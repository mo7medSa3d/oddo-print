/**
 * Printer Capability Matrix — Transport/Protocol/Document/Duplex/Color/Status + IPP capabilities
 * Capability-first, not just protocol.
 */

export type TransportType = "network" | "usb" | "spooler" | "ipp" | "ipps" | "unknown";
export type ProtocolType = "raw" | "escpos" | "zpl" | "tspl" | "ipp" | "ipps" | "spooler" | "windows_spooler" | "unknown";
export type DocumentType = "raw" | "escpos" | "zpl" | "tspl" | "pdf" | "image";
export type DeviceClass = "thermal" | "laser" | "inkjet" | "label" | "other" | "unknown";

export interface CapabilityMatrixRow {
  printerId: string;
  name: string;
  transport: TransportType;
  protocol: ProtocolType;
  documentTypes: DocumentType[];
  deviceClass: DeviceClass;
  duplex: boolean | null;
  color: boolean | null;
  status: string;
  statusEvidence: string;
  driver: string;
  spooler: string;
  paperWidths?: number[];
  ippCapabilities?: Record<string, unknown>;
}

export function getSupportedDocumentTypes(protocol: ProtocolType, transport: TransportType): DocumentType[] {
  if (transport === "spooler" || protocol === "spooler" || protocol === "windows_spooler") {
    return ["pdf", "image", "raw", "escpos"];
  }
  if (protocol === "ipp" || protocol === "ipps" || transport === "ipp" || transport === "ipps") {
    return ["pdf", "image", "raw"];
  }
  switch (protocol) {
    case "escpos":
      return ["escpos", "raw"];
    case "zpl":
      return ["zpl", "raw"];
    case "tspl":
      return ["tspl", "raw"];
    case "raw":
      return ["raw", "escpos", "zpl", "tspl"];
    default:
      return ["raw"];
  }
}

export function isIppTransport(transport: string, protocol: string): boolean {
  return transport === "ipp" || transport === "ipps" || protocol === "ipp" || protocol === "ipps";
}

export function isSpoolerTransport(transport: string, protocol: string): boolean {
  return transport === "spooler" || protocol === "spooler" || protocol === "windows_spooler";
}

export function isRawTransport(protocol: string): boolean {
  return protocol === "raw" || protocol === "escpos" || protocol === "zpl" || protocol === "tspl";
}

/**
 * Human-readable language/capability chips for a printer, derived ONLY from
 * the declared protocol and connection type. Device class must never invent
 * a language: a `laser` printer declared `raw` (9100 byte sink) cannot be
 * sent PDF, and a `label` printer declared `escpos` does not speak ZPL.
 * This is the same truth `routing.ts` enforces server-side; the UI must
 * not claim more than the printer provably supports.
 */
export function getPrinterLanguageBadges(
  protocol: string,
  connectionType: string,
): string[] {
  const conn = (connectionType ?? "").trim().toLowerCase();
  const proto = (protocol ?? "unknown").trim().toLowerCase();
  const badges: string[] = [];
  if (proto === "escpos") badges.push("ESC/POS");
  if (proto === "zpl") badges.push("ZPL");
  if (proto === "tspl") badges.push("TSPL");
  if (proto === "ipp" || proto === "ipps" || conn === "ipp" || conn === "ipps") badges.push("IPP · PDF");
  if (proto === "spooler" || proto === "windows_spooler" || conn === "spooler") badges.push("Spooler · PDF");
  if (proto === "raw") badges.push("Raw 9100");
  return badges;
}

export function getTransportDisplayName(transport: TransportType): string {
  const map: Record<string, string> = {
    network: "Network (TCP)",
    usb: "USB",
    spooler: "Windows Spooler",
    ipp: "IPP",
    ipps: "IPPS (Secure)",
    unknown: "Unknown",
  };
  return map[transport] ?? transport;
}

export function getProtocolDisplayName(protocol: ProtocolType): string {
  const map: Record<string, string> = {
    raw: "RAW",
    escpos: "ESC/POS",
    zpl: "ZPL",
    tspl: "TSPL",
    ipp: "IPP (driverless direction, not certified Everywhere)",
    ipps: "IPPS (Secure, not certified Everywhere)",
    spooler: "Spooler",
    windows_spooler: "Windows Spooler",
    unknown: "Unknown",
  };
  return map[protocol] ?? protocol;
}
