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
    ipp: "IPP Everywhere",
    ipps: "IPPS",
    spooler: "Spooler",
    windows_spooler: "Windows Spooler",
    unknown: "Unknown",
  };
  return map[protocol] ?? protocol;
}
