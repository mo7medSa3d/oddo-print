import payloadContract from "../../contracts/print-payload-contract.json";
/**
 * Printer Capability Matrix — Transport/Protocol/Document/Duplex/Color/Status + IPP capabilities
 * Capability-first, not just protocol.
 *
 * The wire vocabularies below DERIVE from the Zod-validated authorities in
 * printer-model.ts (import type: erased at compile, so this module stays
 * runtime-import-free for the dashboard + Tauri desktop bundles). Change a
 * vocabulary in exactly one place — printer-model.ts — and every consumer
 * follows. DocumentType keeps its own union: it is the payload-kind
 * vocabulary (wire types plus rendered pdf/image), a distinct concept from
 * the transport protocol list.
 */
import type { PRINTER_PROTOCOLS, DEVICE_CLASSES, CONNECTION_TYPES } from "./printer-model";

export type TransportType = (typeof CONNECTION_TYPES)[number] | "unknown";
export type ProtocolType = (typeof PRINTER_PROTOCOLS)[number];
export type DocumentType = "raw" | "escpos" | "zpl" | "tspl" | "pdf" | "image";
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

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

function documentTypeCandidates(protocol: ProtocolType, transport: TransportType): DocumentType[] {
  if (transport === "spooler" || protocol === "spooler" || protocol === "windows_spooler") {
    // Document transports by default. Raw byte passthrough requires an
    // explicit supported_protocols declaration (enforced in routing.ts);
    // it is never inferred, so office printers are never sent raw bytes.
    return ["pdf", "image"];
  }
  if (protocol === "ipp" || protocol === "ipps" || transport === "ipp" || transport === "ipps") {
    return ["pdf"];
  }
  switch (protocol) {
    case "escpos":
      // "image" via gateway raster conversion (routing.ts physicalImage):
      // an ESC/POS device raster-converts JPEGs even though its byte sink
      // speaks escpos. Listed so the matrix matches the enforcer.
      return ["escpos", "raw", "image"];
    case "zpl":
      return ["zpl", "raw"];
    case "tspl":
      return ["tspl", "raw"];
    case "raw":
      return ["raw"];
    default:
      return [];
  }
}

export type CapabilityCheckResult = { ok: true } | { ok: false; reason: string };

export interface PayloadSpec {
  type: string;
  protocol?: string | null;
}

const BYTE_PROTOCOLS = payloadContract.rawProtocols as readonly string[];

/**
 * Canonical payload/protocol → printer-capability table. This is the ONE
 * authoritative definition on the gateway side; the Go agent mirrors it
 * exactly in agent/internal/printer/capability.go, and both sides must be
 * changed together.
 *
 * Precedence rules:
 *  - An explicit `capabilities.supported_protocols` list is AUTHORITATIVE:
 *    a device either declares the payload's protocol/capability or it does
 *    not. There is no wildcard and no protocol inference from absence.
 *  - Without an explicit list, the device's declared transport protocol
 *    decides (escpos/zpl/tspl/raw byte sinks; spooler/ipp/ipps document
 *    transports; escpos devices additionally raster-convert JPEGs).
 *  - A raw payload with NO protocol is invalid input and never becomes
 *    "generic compatible" by default — the contract requires explicitness.
 */
export function validatePayloadForPrinter(
  payloadInput: PayloadSpec | null | undefined,
  printer: {
    protocol?: string | null;
    capabilities?: { supported_protocols?: string[] } | null;
    connectionType?: string | null;
    printerType?: string | null;
  },
): CapabilityCheckResult {
  if (!payloadInput) return { ok: false, reason: "CAPABILITY_MISMATCH: payload is required" };
  const pt = (payloadInput.type ?? "").toLowerCase();
  const payloadProto = payloadInput.protocol ? payloadInput.protocol.toLowerCase() : null;
  const proto = (printer.protocol ?? "").toLowerCase();
  const conn = (printer.connectionType ?? "").toLowerCase();
  // Defensive validation: the capabilities blob comes from agent-reported
  // JSON. A malformed non-array supported_protocols must fail closed as a
  // capability mismatch rather than throwing a TypeError or becoming an
  // implicit transport wildcard.
  const capabilities = printer.capabilities ?? null;
  const hasSupportedProtocolsProperty = capabilities !== null && Object.prototype.hasOwnProperty.call(capabilities, "supported_protocols");
  const rawSupported = capabilities?.supported_protocols;
  if (hasSupportedProtocolsProperty && !Array.isArray(rawSupported)) {
    return { ok: false, reason: "CAPABILITY_MISMATCH: supported_protocols must be an array" };
  }
  const supported = Array.isArray(rawSupported)
    ? rawSupported.map((value) => String(value).toLowerCase())
    : [];
  const hasExplicitCaps = hasSupportedProtocolsProperty;
  // AUTHORITATIVE RULE for "unknown" protocol (mirrored in
  // agent/internal/printer/capability.go and documented in ARCHITECTURE.md):
  // "unknown" means "no byte language declared". The connection type is
  // itself an explicit TRANSPORT declaration for transports that are
  // physically complete (a Windows spooler queue renders documents; an IPP
  // URL accepts document formats), so unknown+spooler/ipp behaves as that
  // transport. For network/usb (byte pipes with no declared language) the
  // family resolves to a name nothing matches: invented-but-routable is
  // impossible, the device is inventoried but dark until declared.
  const family = proto && proto !== "unknown" ? proto : conn;
  const anyCap = (...names: string[]) => hasExplicitCaps
    ? names.some((name) => supported!.includes(name))
    : false;
  const transport = (...names: string[]) => !hasExplicitCaps && names.includes(family);
  // Explicit capabilities can refine a device's language set, but they
  // cannot add a PDF/image renderer that the concrete backend does not have.
  const physicalPdf = conn === "spooler" || proto === "spooler"
    || conn === "ipp" || conn === "ipps"
    || (conn === "network" && proto === "ipp");
  const physicalImage = conn === "spooler" || proto === "spooler"
    || (conn === "network" && proto === "escpos");
  const physicalByteProtocol = (protocol: string) => {
    if (conn === "spooler" || proto === "spooler") {
      return protocol === "raw" || protocol === "escpos";
    }
    return (conn === "network" || conn === "usb")
      && proto === protocol
      && (BYTE_PROTOCOLS as readonly string[]).includes(protocol);
  };

  // PDF: requires a transport that can actually consume/render a document.
  if (pt === "pdf") {
    if (payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: pdf payloads cannot specify a printer protocol" };
    }
    if (!physicalPdf) return { ok: false, reason: "CAPABILITY_MISMATCH: pdf requires spooler or IPP transport" };
    if (!hasExplicitCaps || anyCap("pdf", "spooler", "ipp", "ipps")) return { ok: true };
    return { ok: false, reason: "CAPABILITY_MISMATCH: pdf requires spooler or IPP transport" };
  }

  // Image: rendered by a driver-backed transport, or raster-converted by an
  // explicitly ESC/POS-capable device.
  if (pt === "image") {
    if (payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: image payloads cannot specify a printer protocol" };
    }
    if (!physicalImage) return { ok: false, reason: "CAPABILITY_MISMATCH: image payload not supported by printer" };
    if (!hasExplicitCaps || anyCap("image", "jpeg", "spooler", "escpos")) return { ok: true };
    return { ok: false, reason: "CAPABILITY_MISMATCH: image payload not supported by printer" };
  }

  // ESC/POS payload types must declare the escpos protocol — explicitly.
  if (pt === "escpos") {
    if (payloadProto && payloadProto !== "escpos") {
      return { ok: false, reason: `CAPABILITY_MISMATCH: escpos payload cannot use protocol ${payloadProto}` };
    }
    // Windows spooler queues render documents through the driver by default.
    // A raw ESC/POS byte stream bypasses driver rendering (WritePrinter RAW)
    // and is only valid for passthrough-mode queues whose operator explicitly
    // declared escpos support. Without that declaration, route pdf/image.
    if ((conn === "spooler" || proto === "spooler") && !hasExplicitCaps) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: spooler printers accept document payloads (pdf/image) by default; raw ESC/POS requires an explicit supported_protocols declaration" };
    }
    if (physicalByteProtocol("escpos") && (!hasExplicitCaps || anyCap("escpos"))) return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: printer does not explicitly support ESC/POS (protocol=${proto || "unknown"})` };
  }

  // RAW byte streams require an EXPLICIT protocol; there is no default and no
  // wildcard. The device must declare that same protocol explicitly.
  if (pt === "raw") {
    if (!payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: raw payloads must declare an explicit protocol (raw, escpos, zpl, or tspl)" };
    }
    if (!(BYTE_PROTOCOLS as readonly string[]).includes(payloadProto)) {
      return { ok: false, reason: `CAPABILITY_MISMATCH: unsupported raw protocol ${payloadProto}` };
    }
    // Same spooler passthrough rule as ESC/POS above.
    if ((conn === "spooler" || proto === "spooler") && !hasExplicitCaps) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: spooler printers accept document payloads (pdf/image) by default; raw byte protocols require an explicit supported_protocols declaration" };
    }
    // raw+escpos is exactly an escpos payload; every other byte protocol is
    // accepted only by devices that declare it.
    if (physicalByteProtocol(payloadProto) && (!hasExplicitCaps || anyCap(payloadProto))) return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: printer does not explicitly support ${payloadProto.toUpperCase()} (protocol=${proto || "unknown"})` };
  }

  return { ok: false, reason: `CAPABILITY_MISMATCH: unsupported payload type ${pt}` };
}

export function getSupportedDocumentTypes(protocol: ProtocolType, transport: TransportType, capabilities?: { supported_protocols?: string[] } | null): DocumentType[] {
  const normalized = protocol === "windows_spooler" ? "spooler" : protocol;
  const candidates = [...new Set<DocumentType>([...documentTypeCandidates(protocol, transport), "raw", "escpos", "zpl", "tspl", "pdf", "image"])];
  return candidates.filter(type => {
    const payload: PayloadSpec = type === "zpl" || type === "tspl"
      ? { type: "raw", protocol: type }
      : type === "raw" ? { type: "raw", protocol: BYTE_PROTOCOLS.includes(normalized) ? normalized : capabilities?.supported_protocols?.includes("escpos") ? "escpos" : "raw" }
      : type === "escpos" ? { type, protocol: "escpos" } : { type };
    return validatePayloadForPrinter(payload, { protocol: normalized, connectionType: transport, capabilities }).ok;
  });
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
