/* ============================================================
   Virtual / software printer guard (Gateway side)
   ------------------------------------------------------------
   Automatic discovery still excludes virtual and redirected queues
   from managed production inventory. A Manager can now register an
   explicitly approved Windows SOFTWARE spooler queue for local testing;
   only the matching queue verified by the running Agent may become a
   Gateway/Odoo destination. This is spooler admission, NOT paper output.

   Legacy virtual rows remain preserved but unusable without both the
   Manager desired-state authorization and an Agent-reported capability.
   Synthetic Yaseir capture remains Manager-test-only; redirected and FAX
   queues never become production destinations.

   Detection reads normalized metadata first (printerType,
   connectionType, protocol, capabilities) and only falls back to
   well-known software-writer names when a row predates those
   fields — never a name-only blacklist as the primary signal.
   ============================================================ */

export interface PrinterLike {
  name?: string | null;
  printerType?: string | null;
  deviceClass?: string | null;
  connectionType?: string | null;
  protocol?: string | null;
  port?: string | null;
  driverName?: string | null;
  capabilities?: unknown;
  config?: unknown;
  managementSource?: string | null;
}

/** Capability keys that mark a queue as software-only. */
const VIRTUAL_CAPABILITY_KEYS = ["virtual", "is_virtual"] as const;
const VIRTUAL_CLASSES = new Set(["virtual", "redirected"]);

/**
 * Windows port monitors whose output never reaches hardware: they write a
 * file, discard the job or dial a modem. Same authority as the agent's
 * classifier — a port monitor is device metadata, not a printer name.
 */
const VIRTUAL_PORT_MONITORS = [
  "portprompt:", // Microsoft Print to PDF / print-to-file prompt
  "xpsport:", // Microsoft XPS Document Writer
  "file:", // print to file
  "nul:",
  "null:",
  "shrfax:", // Windows Shared Fax
  "fax:",
  "brfax:", // Brother vendor software fax monitor
];

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
const SOFTWARE_WRITER_TOKENS = [
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
];

/**
 * Queues tunnelled from another desktop session: Remote Desktop, Citrix,
 * VMware, ThinPrint. Mirrors the agent's `sessionRedirectTokens`.
 */
const SESSION_REDIRECT_TOKENS = [
  "remote desktop easy print",
  "terminal services easy print",
  "ts easy print",
  "easy print",
  "citrix",
  "vmware virtual print",
  "vmware universal printer",
  "thinprint",
  "safeguard print",
];

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

  const caps = capabilitiesRecord(printer.capabilities);
  if (caps) {
    for (const key of VIRTUAL_CAPABILITY_KEYS) {
      if (caps[key] === true || lower(caps[key]) === "true") return true;
    }
    const klass = lower(caps.printer_class ?? caps["printerClass"]);
    if (VIRTUAL_CLASSES.has(klass)) return true;
    if (isVirtualPortMonitor(caps.port_name ?? caps["portName"])) return true;
  }

  // Session redirect: Remote Desktop / Citrix / VMware. Windows names these
  // "HP LaserJet (redirected 3)"; Citrix uses "… (from WKS12) in session 4".
  const name = lower(printer.name);
  if (
    name.includes("(redirected") ||
    name.includes(" in session ") ||
    name.endsWith(" in session")
  ) {
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
    printer.name, printer.driverName, caps?.driver_name, caps?.driverName,
  ].some(vendorFaxName)) return true;

  // The driver (and PnP ids) identify a software writer or a session tunnel
  // far more reliably than the display name does.
  const hay = identityHaystack(caps, printer);
  if (hay) {
    if (SOFTWARE_WRITER_TOKENS.some((token) => hay.includes(token))) return true;
    if (SESSION_REDIRECT_TOKENS.some((token) => hay.includes(token))) return true;
  }

  // Legacy fallback: a row persisted before any metadata existed.
  if (!name) return false;
  return SOFTWARE_WRITER_TOKENS.some((pattern) => name.includes(pattern));
}

/**
 * Deliberately configured Yaseir file-capture TEST destination. This remains
 * virtual and is never eligible for Odoo/production routing. Only an
 * authenticated Manager test-print request can opt into its admission.
 */
export function isVirtualCaptureTestRecord(printer: PrinterLike | null | undefined): boolean {
  if (!printer) return false;
  const caps = capabilitiesRecord(printer.capabilities);
  return lower(printer.printerType) === "virtual"
    && lower(printer.connectionType) === "spooler"
    && lower(printer.protocol) === "spooler"
    && caps?.virtual_test_sink === true
    && lower(caps?.registration_source) === "config"
    && isVirtualPrinterRecord(printer);
}

/**
 * A deliberately manager-owned Windows software queue permitted for explicit
 * Gateway and Odoo validation. Both the manager desired-state flag AND the
 * Agent's observed capability are necessary: a Manager write alone cannot
 * establish that the executing Agent has validated the local queue.
 *
 * Redirected sessions, FAX destinations and synthetic file capture are never
 * eligible. This remains a virtual queue; successful spooler submission is
 * not physical-paper evidence, and drivers needing an interactive Save dialog
 * may fail or remain indeterminate in a Windows service.
 */
export function isApprovedVirtualSpoolerTestRecord(printer: PrinterLike | null | undefined): boolean {
  if (!printer || lower(printer.printerType) !== "virtual" ||
      lower(printer.connectionType) !== "spooler" || lower(printer.protocol) !== "spooler") return false;
  const desired = capabilitiesRecord(printer.config);
  const observed = capabilitiesRecord(printer.capabilities);
  if (desired?.virtual_spooler_test !== true || observed?.virtual_spooler_test !== true) return false;
  // Do not ever repurpose Yaseir's separate file-capture backend as a
  // selectable Odoo printer; it has a Manager-only test-page contract.
  if (observed.virtual_test_sink === true) return false;
  const name = lower(printer.name);
  const spoolerName = lower(desired.spooler_name);
  const metadata = identityHaystack(observed, printer);
  const identity = [name, spoolerName, metadata].join(" ");
  if (identity.includes("(redirected") || identity.includes(" in session ") ||
      SESSION_REDIRECT_TOKENS.some((token) => identity.includes(token))) return false;
  if (name === "fax" || name.endsWith(" fax") || name.endsWith(" (fax)") ||
      spoolerName === "fax" || spoolerName.endsWith(" fax") || spoolerName.endsWith(" (fax)") ||
      identity.includes("shrfax:") || identity.includes("brfax:")) return false;
  return !!spoolerName && isVirtualPrinterRecord(printer);
}
