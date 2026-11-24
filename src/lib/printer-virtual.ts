/* ============================================================
   Virtual / software printer classifier (shared TypeScript)
   ------------------------------------------------------------
   Printable virtual printers (Microsoft Print to PDF, Microsoft
   XPS Document Writer, CUPS-PDF, Print to File, Save as PDF,
   etc.) are first-class managed printers that carry `is_virtual`
   metadata and display a subtle "Virtual" badge.

   Only truly unusable/non-printable stubs are excluded from
   routing and inventory:
     - Session-redirected queues (RDP / Citrix / VMware / TS001+)
     - Blackhole / null ports (NUL:, NULL:)
     - Fax-only queues (SHRFAX:, FAX:, BRFAX:, PC-FAX, Shared Fax)
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
  isVirtual?: boolean | null;
  is_virtual?: boolean | null;
  capabilities?: unknown;
  config?: unknown;
  managementSource?: string | null;
}

/** Capability keys that mark a queue as software/virtual. */
export const VIRTUAL_CAPABILITY_KEYS = ["virtual", "is_virtual", "virtual_test_sink", "virtual_spooler_test"] as const;
export const VIRTUAL_CLASSES: ReadonlySet<string> = new Set(["virtual", "redirected"]);

/**
 * Non-printable port monitors (blackhole/null or fax modem).
 */
export const UNUSABLE_PORT_MONITORS = [
  "nul:",
  "null:",
  "shrfax:", // Windows Shared Fax
  "fax:",
  "brfax:", // Brother vendor software fax monitor
] as const;

/**
 * Windows & CUPS virtual port monitors (includes printable document writers
 * like PORTPROMPT:/XPSPORT:/FILE:/CUPS-PDF: as well as unusable fax/null ports).
 */
export const VIRTUAL_PORT_MONITORS = [
  "portprompt:", // Microsoft Print to PDF / print-to-file prompt
  "xpsport:", // Microsoft XPS Document Writer
  "file:", // print to file
  "cups-pdf:", // Linux/macOS CUPS-PDF backend
  ...UNUSABLE_PORT_MONITORS,
] as const;

function matchesPortMonitor(port: unknown, monitors: readonly string[]): boolean {
  const raw = lower(port);
  if (!raw) return false;
  // "IP_192.168.1.50,SNMP" → "ip_192.168.1.50"
  const head = raw.split(",")[0].trim();
  return monitors.some((monitor) => head === monitor || head.startsWith(monitor));
}

function isVirtualPortMonitor(port: unknown): boolean {
  return matchesPortMonitor(port, VIRTUAL_PORT_MONITORS);
}

function isUnusablePortMonitor(port: unknown): boolean {
  return matchesPortMonitor(port, UNUSABLE_PORT_MONITORS);
}

/**
 * Fax-only software writer tokens that cannot print documents.
 */
export const UNUSABLE_WRITER_TOKENS = [
  "microsoft shared fax",
  "pc-fax",
  "pc fax",
  "pcfax",
  "fax driver",
  "fax v.",
] as const;

/**
 * Driver / PnP / name families that identify virtual software writers.
 * Mirrors the Go agent's `softwareWriterTokens`.
 */
export const SOFTWARE_WRITER_TOKENS = [
  // Microsoft in-box software writers
  "microsoft print to pdf",
  "microsoft xps document writer",
  ...UNUSABLE_WRITER_TOKENS,
  "send to onenote",
  "onenote",
  // Semantic families (language independent)
  "document writer",
  "documentwriter",
  "print to pdf",
  "save as pdf",
  "print to file",
  "cups-pdf",
  "cups pdf",
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

function identityHaystack(caps: Record<string, unknown> | null, printer?: PrinterLike): string {
  if (!caps && !printer) return "";
  const parts: string[] = [];

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

function extractNames(printer: PrinterLike, caps: Record<string, unknown> | null, config: Record<string, unknown> | null): string[] {
  const connection = lower(printer.connectionType);
  const protocol = lower(printer.protocol);
  const labels: unknown[] = [
    printer.name,
    printer.displayName,
    printer.display_name,
    printer.spoolerName,
    printer.spooler_name,
    config?.spooler_name,
    config?.spoolerName,
    config?.display_name,
    config?.displayName,
    caps?.spooler_name,
    caps?.spoolerName,
    caps?.display_name,
    caps?.displayName,
  ];
  if (connection === "spooler" || connection === "windows_spooler" || protocol === "spooler" || protocol === "windows_spooler") {
    labels.push(printer.endpoint, config?.address);
  }
  return labels.map(lower).filter(Boolean);
}

function isVendorFaxName(value: unknown): boolean {
  const text = lower(value);
  return text === "fax" || text.endsWith(" fax") || text.endsWith("-fax") || text.endsWith(" (fax)");
}

function isTerminalServicesPort(port: unknown): boolean {
  const raw = lower(port);
  if (!raw) return false;
  const head = raw.split(",")[0].trim();
  return /^ts\d+$/.test(head);
}

/**
 * True ONLY when the printer record is a truly unusable / non-printable stub
 * (session-redirected queue, blackhole/nul port, or fax-only queue).
 * Printable virtual printers (Microsoft Print to PDF, XPS Document Writer,
 * CUPS-PDF, Print to File, Save as PDF, etc.) return false so they are routed
 * and managed as first-class printers.
 */
export function isUnusableVirtualPrinterRecord(printer: PrinterLike | null | undefined): boolean {
  if (!printer) return false;

  const type = lower(printer.printerType);
  if (type === "redirected") return true;

  const config = capabilitiesRecord(printer.config);
  const caps = capabilitiesRecord(printer.capabilities);

  if ([config, caps].some((record) => record && ["virtual_test_sink", "virtual_spooler_test"].some((key) => key in record))) {
    return true;
  }
  if (caps) {
    const klass = lower(caps.printer_class ?? caps["printerClass"]);
    if (klass === "redirected") return true;
    if (isUnusablePortMonitor(caps.port_name ?? caps["portName"])) return true;
    if (isTerminalServicesPort(caps.port_name ?? caps["portName"])) return true;
  }

  if (isUnusablePortMonitor(printer.port) || isTerminalServicesPort(printer.port)) return true;

  const names = extractNames(printer, caps, config);

  // Session redirect: Remote Desktop / Citrix / VMware.
  if (names.some((name) => name.includes("(redirected") ||
    name.endsWith("redirected)") || name.includes(" in session ") || name.endsWith(" in session") ||
    (name.includes("(from ") && name.includes("in session")))) {
    return true;
  }

  // Fax-only queues cannot print documents.
  if ([...names, printer.driverName, caps?.driver_name, caps?.driverName].some(isVendorFaxName)) {
    return true;
  }

  const hay = identityHaystack(caps, printer);
  if (hay) {
    if (SESSION_REDIRECT_TOKENS.some((token) => hay.includes(token))) return true;
    if (UNUSABLE_WRITER_TOKENS.some((token) => hay.includes(token))) return true;
  }

  return names.some((name) => UNUSABLE_WRITER_TOKENS.some((token) => name.includes(token)));
}

/**
 * True when the printer record represents ANY virtual printer (including
 * first-class printable virtual printers like Microsoft Print to PDF, XPS
 * Document Writer, CUPS-PDF, Print to File, Save as PDF). Use this for UI
 * classification / badges ("Virtual"), NOT for excluding printable writers.
 */
export function isVirtualPrinterMetadata(printer: PrinterLike | null | undefined): boolean {
  if (!printer) return false;
  if (printer.isVirtual === true || printer.is_virtual === true) return true;
  if (isUnusableVirtualPrinterRecord(printer)) return true;

  const type = lower(printer.printerType);
  const connection = lower(printer.connectionType);
  const protocol = lower(printer.protocol);
  if (type === "virtual" || type === "file" || connection === "virtual" || protocol === "virtual") return true;

  const config = capabilitiesRecord(printer.config);
  const caps = capabilitiesRecord(printer.capabilities);
  if (caps) {
    for (const key of VIRTUAL_CAPABILITY_KEYS) {
      if (caps[key] === true || lower(caps[key]) === "true") return true;
    }
    const klass = lower(caps.printer_class ?? caps["printerClass"]);
    if (VIRTUAL_CLASSES.has(klass)) return true;
    if (isVirtualPortMonitor(caps.port_name ?? caps["portName"])) return true;
  }

  if (isVirtualPortMonitor(printer.port)) return true;

  const hay = identityHaystack(caps, printer);
  if (hay && SOFTWARE_WRITER_TOKENS.some((token) => hay.includes(token))) return true;

  const names = extractNames(printer, caps, config);
  return names.some((name) => SOFTWARE_WRITER_TOKENS.some((pattern) => name.includes(pattern)));
}

/**
 * Routing & inventory exclusion guard.
 *
 * Returns true ONLY for unusable/non-printable stubs (session-redirected,
 * blackhole/nul:, fax). First-class printable virtual printers (PDF/XPS/
 * Print-to-File/CUPS-PDF) return false so they remain routable and managed.
 */
export function isVirtualPrinterRecord(printer: PrinterLike | null | undefined): boolean {
  return isUnusableVirtualPrinterRecord(printer);
}
