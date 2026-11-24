import payloadContract from "../../contracts/print-payload-contract.json";
import { currentPrinterGeometry, hasPhysicalReceiptGeometry, printerGeometryFromCapabilities } from "./printer-geometry";
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
type DocumentType = "raw" | "escpos" | "zpl" | "tspl" | "pdf" | "image";
export type DeviceClass = (typeof DEVICE_CLASSES)[number];


function documentTypeCandidates(protocol: ProtocolType, transport: TransportType): DocumentType[] {
  if (transport === "spooler" || protocol === "spooler") {
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
      // Image is only a candidate. The verified GS v 0 profile and geometry
      // fingerprint checks below determine whether raster output is usable.
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
  geometry_fingerprint?: string;
}

interface PrinterCapabilities {
  supported_protocols?: unknown;
  geometry?: unknown;
  [key: string]: unknown;
}

const BYTE_PROTOCOLS = payloadContract.rawProtocols as readonly string[];

/**
 * Canonical payload/protocol → printer-capability table. This is the ONE
 * authoritative definition on the gateway side; the Go agent mirrors it
 * exactly in agent/internal/printer/capability.go, and both sides must be
 * changed together.
 *
 * Precedence rules:
 *  - Physical document transports provide an immutable baseline capability:
 *    spooler queues and IPP support PDF. Images additionally require verified
 *    geometry because they do not carry a physical document page size.
 *    An explicit `supported_protocols` list may ADD safe passthrough byte
 *    languages, but it never removes that transport baseline.
 *  - Direct byte transports remain strict: an explicit capability list is
 *    authoritative and cannot invent a language that the transport/protocol
 *    does not physically implement.
 *  - Without an explicit list, the device's declared transport protocol
 *    decides (escpos/zpl/tspl/raw byte sinks; spooler/ipp/ipps document
 *    transports). Raster conversion also requires an explicit GS v 0 profile.
 *  - A raw payload with NO protocol is invalid input and never becomes
 *    "generic compatible" by default — the contract requires explicitness.
 */
export function validatePayloadForPrinter(
  payloadInput: PayloadSpec | null | undefined,
  printer: {
    id?: string;
    config?: Record<string, unknown> | null;
    protocol?: string | null;
    capabilities?: PrinterCapabilities | null;
    connectionType?: string | null;
    printerType?: string | null;
    // v3: forwarded to currentPrinterGeometry so the manager desired-revision
    // fence applies in the image probe too (previously only id/config were
    // passed, so the revision check silently never fired here; callers had
    // to pre-fence via capabilitiesWithCurrentGeometry instead).
    managementSource?: string | null;
    desiredRevision?: number | null;
    appliedDesiredRevision?: number | null;
    observedDesiredRevision?: number | null;
  },
): CapabilityCheckResult {
  if (!payloadInput) return { ok: false, reason: "CAPABILITY_MISMATCH: payload is required" };
  const pt = (payloadInput.type ?? "").toLowerCase();
  const payloadProto = payloadInput.protocol ? payloadInput.protocol.toLowerCase() : null;
  const rawConn = (printer.connectionType ?? "").toLowerCase();
  const conn = rawConn === "windows_spooler" ? "spooler" : rawConn;
  const rawProto = (printer.protocol ?? "").toLowerCase();
  const proto = rawProto === "windows_spooler" && conn === "spooler" ? "spooler" : rawProto;
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
    ? rawSupported.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase().trim())
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
  const anyCap = (...names: string[]) => hasExplicitCaps
    ? names.some((name) => supported!.includes(name))
    : false;
  // Explicit capabilities can add byte passthrough to a document transport,
  // but they cannot remove the baseline renderer provided by that transport
  // or add a renderer/language the concrete backend does not implement.
  // A spooler protocol label must not magically turn a TCP/9100 byte pipe
  // into a Windows driver. Preserve legacy USB-backed queues, whose spooler
  // configuration is normalized at registration, but reject network+spooler.
  const physicalSpooler = conn === "spooler" || (conn === "usb" && proto === "spooler");
  const physicalPdf = physicalSpooler
    || conn === "ipp" || conn === "ipps"
    || (conn === "network" && (proto === "ipp" || proto === "ipps"));
  const physicalImage = physicalSpooler
    || ((conn === "network" || conn === "usb") && proto === "escpos");
  const physicalByteProtocol = (protocol: string) => {
    if (physicalSpooler) {
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
    // A spooler/IPP queue is a document transport by construction. Keep that
    // baseline usable even when supported_protocols is present only to opt in
    // to RAW/ESC-POS passthrough.
    return { ok: true };
  }

  // A receipt image was rendered against a specific measured configuration.
  // Width equality alone cannot fence a driver/DPI/media change. Require the
  // exact geometry revision, and a proven raster command on byte transports.
  if (pt === "image") {
    if (payloadProto) {
      return { ok: false, reason: "CAPABILITY_MISMATCH: image payloads cannot specify a printer protocol" };
    }
    if (!physicalImage) return { ok: false, reason: "CAPABILITY_MISMATCH: image payload not supported by printer" };
    const geometry = printer.id
      ? currentPrinterGeometry({ id: printer.id, capabilities, config: printer.config, managementSource: printer.managementSource ?? undefined, desiredRevision: printer.desiredRevision ?? undefined, appliedDesiredRevision: printer.appliedDesiredRevision ?? undefined, observedDesiredRevision: printer.observedDesiredRevision ?? undefined })
      : printerGeometryFromCapabilities(capabilities);
    if (!geometry) return { ok: false, reason: "GEOMETRY_REQUIRED: Refresh this printer or configure a validated geometry profile before printing images." };
    if (!payloadInput.geometry_fingerprint || payloadInput.geometry_fingerprint !== geometry.config_fingerprint) {
      return { ok: false, reason: "GEOMETRY_CHANGED: Refresh this printer and render the image again using its current geometry." };
    }
    if (physicalSpooler) {
      return hasPhysicalReceiptGeometry(geometry)
        ? { ok: true }
        : { ok: false, reason: "GEOMETRY_REQUIRED: Image document printing requires measured paper width and both axis DPI values." };
    }
    if (geometry.raster_command !== "gs_v_0") {
      return { ok: false, reason: "CAPABILITY_MISMATCH: Configure a validated GS v 0 raster command profile for this ESC/POS printer." };
    }
    if (hasExplicitCaps && !anyCap("image", "jpeg", "escpos")) return { ok: false, reason: "CAPABILITY_MISMATCH: image payload not supported by printer" };
    return { ok: true };
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
    if (physicalSpooler) {
      if (hasExplicitCaps && anyCap("escpos")) return { ok: true };
      return { ok: false, reason: "CAPABILITY_MISMATCH: This printer is configured for Windows document spooling and has not been declared as ESC/POS-capable." };
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
    if (physicalSpooler) {
      if (payloadProto === "escpos" && hasExplicitCaps && anyCap("escpos")) return { ok: true };
      if (payloadProto === "raw" && hasExplicitCaps && anyCap("raw")) return { ok: true };
      const label = payloadProto === "escpos" ? "ESC/POS" : payloadProto.toUpperCase();
      return { ok: false, reason: `CAPABILITY_MISMATCH: This printer is configured for Windows document spooling and has not been declared as ${label}-capable.` };
    }
    // raw+escpos is exactly an escpos payload; every other byte protocol is
    // accepted only by devices that declare it.
    if (physicalByteProtocol(payloadProto) && (!hasExplicitCaps || anyCap(payloadProto))) return { ok: true };
    return { ok: false, reason: `CAPABILITY_MISMATCH: printer does not explicitly support ${payloadProto.toUpperCase()} (protocol=${proto || "unknown"})` };
  }

  return { ok: false, reason: `CAPABILITY_MISMATCH: unsupported payload type ${pt}` };
}

/**
 * Membership test for an explicitly declared capability token. The
 * capabilities blob comes from agent-reported JSON: a malformed non-array
 * value must read as absent (callers fail closed elsewhere), never throw a
 * TypeError or match by string-substring semantics.
 */
export function hasDeclaredProtocol(
  capabilities: { supported_protocols?: unknown } | null | undefined,
  token: string,
): boolean {
  const raw = capabilities?.supported_protocols;
  return Array.isArray(raw) && raw.some((value) => typeof value === "string" && value.toLowerCase().trim() === token);
}

// v3: the image probe previously called validatePayloadForPrinter WITHOUT
// id/config, bypassing the currentPrinterGeometry fence (manager desired
// revision pending + validated-profile equality) that admission applies when
// id is present. Both current callers pre-fence capabilities via
// capabilitiesWithCurrentGeometry, so no live mismatch was observed, but the
// function must not depend on callers remembering that. Pass printer context
// through when the caller has it; without it the probe stays advisory-only
// for geometry (callers must re-check at admission, as admission does).
export function getSupportedDocumentTypes(protocol: ProtocolType, transport: TransportType, capabilities?: PrinterCapabilities | null, printer?: { id?: string; config?: Record<string, unknown> | null; managementSource?: string | null; desiredRevision?: number | null; appliedDesiredRevision?: number | null; observedDesiredRevision?: number | null }): DocumentType[] {
  const normalizedTransport = transport === ("windows_spooler" as TransportType) ? "spooler" : transport;
  const normalized = protocol === "windows_spooler" && normalizedTransport === "spooler" ? "spooler" : protocol;
  const candidates = [...new Set<DocumentType>([...documentTypeCandidates(normalized as ProtocolType, normalizedTransport), "raw", "escpos", "zpl", "tspl", "pdf", "image"])];
  return candidates.filter(type => {
    const payload: PayloadSpec = type === "zpl" || type === "tspl"
      ? { type: "raw", protocol: type }
      : type === "raw" ? { type: "raw", protocol: BYTE_PROTOCOLS.includes(normalized) ? normalized : hasDeclaredProtocol(capabilities, "escpos") ? "escpos" : "raw" }
      : type === "escpos" ? { type, protocol: "escpos" }
      : type === "image" ? { type, geometry_fingerprint: printerGeometryFromCapabilities(capabilities)?.config_fingerprint }
      : { type };
    return validatePayloadForPrinter(payload, { protocol: normalized, connectionType: normalizedTransport, capabilities, ...(printer ?? {}) }).ok;
  });
}

export function isIppTransport(transport: string, protocol: string): boolean {
  const conn = (transport ?? "").trim().toLowerCase();
  const proto = (protocol ?? "").trim().toLowerCase();
  return conn === "ipp" || conn === "ipps" ||
    (conn === "network" && (proto === "ipp" || proto === "ipps"));
}

export function isSpoolerTransport(transport: string, protocol: string): boolean {
  const conn = (transport ?? "").trim().toLowerCase();
  const proto = (protocol ?? "").trim().toLowerCase();
  return conn === "spooler" || conn === "windows_spooler" ||
    (conn === "usb" && (proto === "spooler" || proto === "windows_spooler"));
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
  // Badges are capability claims, not protocol-label decorations. A TCP
  // device declaring "spooler", or an IPP interface labelled "ZPL", must not
  // appear to support a language that actual print admission would reject.
  // With no capabilities blob in this presentation helper, only advertise
  // execution protocols known from the physical transport itself.
  const printer = { protocol: proto, connectionType: conn };
  const supports = (type: string, payloadProtocol?: string) =>
    validatePayloadForPrinter({ type, ...(payloadProtocol ? { protocol: payloadProtocol } : {}) }, printer).ok;
  const badges: string[] = [];
  if (proto === "escpos" && supports("escpos", "escpos")) badges.push("ESC/POS");
  if (proto === "zpl" && supports("raw", "zpl")) badges.push("ZPL");
  if (proto === "tspl" && supports("raw", "tspl")) badges.push("TSPL");
  if (isIppTransport(conn, proto) && supports("pdf")) badges.push("IPP · PDF");
  if (isSpoolerTransport(conn, proto) && supports("pdf")) badges.push("Spooler · PDF");
  if (proto === "raw" && supports("raw", "raw")) badges.push(conn === "usb" ? "RAW" : "Raw 9100");
  return badges;
}
