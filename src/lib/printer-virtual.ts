/* ============================================================
   Virtual / software printer guard (Gateway side)
   ------------------------------------------------------------
   All virtual/software/redirected queues are forbidden for printing,
   discovery registration and display. This classifier is deliberately
   retained to reject legacy records and spoofed physical metadata.

   Detection reads normalized metadata first (printerType,
   connectionType, protocol, capabilities) and only falls back to
   well-known software-writer names when a row predates those
   fields — never a name-only blacklist as the primary signal.
   ============================================================ */

export interface PrinterLike {
  name?: string | null;
  displayName?: string | null;
  display_name?: string | null;
  spoolerName?: string | null;
  spooler_name?: string | null;
  endpoint?: string | null;
  printerType?: string | null;
  deviceClass?: string | null;
  connectionType?: string | null;
  protocol?: string | null;
  // Network/Windows inventory may report a numeric port while software
  // printer monitor names (for example PORTPROMPT:) are strings.
  port?: string | number | null;
  driverName?: string | null;
  capabilities?: unknown;
  config?: unknown;
  managementSource?: string | null;
}

/** Capability keys that mark a queue as software-only. */
export const VIRTUAL_CAPABILITY_KEYS = ["virtual", "is_virtual", "virtual_test_sink", "virtual_spooler_test"] as const;
export const VIRTUAL_CLASSES: ReadonlySet<string> = new Set(["virtual", "redirected"]);

/**
 * Windows port monitors whose output never reaches hardware: they write a
 * file, discard the job or dial a modem. Same authority as the agent's
 * classifier — a port monitor is device metadata, not a printer name.
 */
export const VIRTUAL_PORT_MONITORS = [
  "portprompt:", // Microsoft Print to PDF / print-to-file prompt
  "xpsport:", // Microsoft XPS Document Writer
  "file:", // print to file
  "nul:",
  "null:",
  "shrfax:", // Windows Shared Fax
  "fax:",
  "brfax:", // Brother vendor software fax monitor
] as const;

function isVirtualPortMonitor(port: unknown): boolean {
  const raw = lower(port);
  if (!raw) return false;
  // "IP_192.168.1.50,SNMP" → "ip_192.168.1.50"
  const head = raw.split(",")[0].trim();
  return VIRTUAL_PORT_MONITORS.some((monitor) => head === monitor || head.startsWith(monitor));
}

/**
 * Driver / PnP / name families that only ever produce a file or hand the job
 * to an application. Mirrors the Windows agent's `softwareWriterTokens`.
 *
 * These are matched against the driver name and PnP ids as well as the
 * printer name: a redirected or software queue is identified by its driver
 * far more reliably than by its display name.
 */
export const SOFTWARE_WRITER_TOKENS = [
  // Microsoft in-box software writers
  "microsoft print to pdf",
  "microsoft xps document writer",
  "microsoft shared fax",
  "pc-fax",
  "pc fax",
  "pcfax",
  "fax driver",
  "fax v.",
  "send to onenote",
  "onenote",
  // Semantic families (language independent)
  "document writer",
  "documentwriter",
  "print to pdf",
  "topdf",
  "pdf writer",
  "pdfwriter",
  "pdf printer",
  "pdf creator",
  "pdf converter",
  "pdf architect",
  "virtual printer",
  "software printer",
  "image printer",
  // Widely deployed third-party software writers
  "foxit",
  "anydesk",
  "cutepdf",
  "pdf995",
  "novapdf",
  "bullzip",
  "pdfcreator",
  "pdfforge",
  "doro pdf",
  "biopdf",
  "nitro pdf",
  "adobe pdf",
  "bluebeam",
  "tinypdf",
  "7-pdf",
  "icecream pdf",
  "pdf24",
] as const;

/**
 * Queues tunnelled from another desktop session: Remote Desktop, Citrix,
 * VMware, ThinPrint. Mirrors the agent's `sessionRedirectTokens`.
 */
export const SESSION_REDIRECT_TOKENS = [
  "remote desktop easy print",
  "terminal services easy print",
  "ts easy print",
  "easy print",
  "citrix",
  "vmware virtual print",
  "vmware universal printer",
  "thinprint",
  "safeguard print",
] as const;

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Everything that identifies the device, lowercased, so one substring scan
 * covers the driver, the PnP ids and the comment — the same haystack the
 * Windows agent classifies from.
 */
function identityHaystack(caps: Record<string, unknown> | null, printer?: PrinterLike): string {
  if (!caps && !printer) return "";
  const parts: string[] = [];

  // Some Gateway/API rows expose normalized driver/port metadata as top-level
  // fields, while discovery capability bags keep the same values nested.
  // Accept both representations so the safety net remains effective across
  // old and new persisted/API shapes.
  for (const value of [printer?.driverName, printer?.port]) {
    const text = lower(value);
    if (text) parts.push(text);
  }

  if (!caps) return parts.join(" ");

  for (const key of ["driver_name", "driverName", "comment", "device_id", "deviceId"]) {
    const value = lower(caps[key]);
    if (value) parts.push(value);
  }
  for (const key of ["hardware_ids", "hardwareIds", "compatible_ids", "compatibleIds"]) {
    const value = caps[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const text = lower(entry);
        if (text) parts.push(text);
      }
    }
  }
  return parts.join(" ");
}

function capabilitiesRecord(capabilities: unknown): Record<string, unknown> | null {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  return capabilities as Record<string, unknown>;
}

/**
 * True when the printer record describes a virtual, software or
 * session-redirected queue rather than real printing hardware.
 */
export function isVirtualPrinterRecord(printer: PrinterLike | null | undefined): boolean {
  if (!printer) return false;

  const type = lower(printer.printerType);
  const connection = lower(printer.connectionType);
  const protocol = lower(printer.protocol);
  if (type === "virtual" || type === "redirected" || connection === "virtual" || protocol === "virtual") return true;

  const config = capabilitiesRecord(printer.config);
  if ([config, capabilitiesRecord(printer.capabilities)].some((record) => record &&
      ["virtual_test_sink", "virtual_spooler_test"].some((key) => key in record))) return true;
  const caps = capabilitiesRecord(printer.capabilities);
  if (caps) {
    for (const key of VIRTUAL_CAPABILITY_KEYS) {
      if (caps[key] === true || lower(caps[key]) === "true") return true;
    }
    const klass = lower(caps.printer_class ?? caps["printerClass"]);
    if (VIRTUAL_CLASSES.has(klass)) return true;
    if (isVirtualPortMonitor(caps.port_name ?? caps["portName"])) return true;
  }

  // Friendly labels must not mask the actual Windows queue identity.
  const labels = [printer.name, printer.displayName, printer.display_name,
    printer.spoolerName, printer.spooler_name, config?.spooler_name, config?.spoolerName,
    config?.display_name, config?.displayName, caps?.spooler_name, caps?.spoolerName,
    caps?.display_name, caps?.displayName];
  if (connection === "spooler" || connection === "windows_spooler" || protocol === "spooler" || protocol === "windows_spooler") {
    labels.push(printer.endpoint, config?.address);
  }
  const names = labels.map(lower).filter(Boolean);

  // Session redirect: Remote Desktop / Citrix / VMware. Windows names these
  // "HP LaserJet (redirected 3)"; Citrix uses "… (from WKS12) in session 4".
  if (names.some((name) => name.includes("(redirected") ||
    name.endsWith("redirected)") || name.includes(" in session ") || name.endsWith(" in session") ||
    (name.includes("(from ") && name.includes("in session")))) {
    return true;
  }

  // Top-level port metadata is authoritative just like the nested capability
  // representation. This catches legacy/API printer rows such as FILE: and
  // PORTPROMPT: even when no capabilities object was persisted.
  if (isVirtualPortMonitor(printer.port)) return true;

  // Vendor FAX-only queues often share the same USB001/IP_* port as a real
  // printer. A trailing FAX driver/queue label means facsimile transmission,
  // not a paper print; keep older Gateway rows from routing to it.
  const vendorFaxName = (value: unknown) => {
    const text = lower(value);
    return text === "fax" || text.endsWith(" fax") ||
      text.endsWith("-fax") || text.endsWith(" (fax)");
  };
  if ([
    ...names, printer.driverName, caps?.driver_name, caps?.driverName,
  ].some(vendorFaxName)) return true;

  // The driver (and PnP ids) identify a software writer or a session tunnel
  // far more reliably than the display name does.
  const hay = identityHaystack(caps, printer);
  if (hay) {
    if (SOFTWARE_WRITER_TOKENS.some((token) => hay.includes(token))) return true;
    if (SESSION_REDIRECT_TOKENS.some((token) => hay.includes(token))) return true;
  }

  // Legacy fallback: a row persisted before any metadata existed.
  return names.some((name) => SOFTWARE_WRITER_TOKENS.some((pattern) => name.includes(pattern)));
}
