import payloadContract from "../../contracts/print-payload-contract.json";
import { gatewayNow } from "./database-clock";
import { isVirtualPrinterRecord, isApprovedVirtualSpoolerTestRecord, type PrinterLike } from "./printer-virtual";
import { getAgentAvailability } from "./agent-availability";

export { validatePayloadForPrinter, type CapabilityCheckResult, type PayloadSpec } from "./printer-capability";

export interface PrinterAvailability extends PrinterLike {
  lifecycle: string | null;
  status: string | null;
  inventoryPresent?: boolean | null;
}

export function isPrinterStatusExecutable(printer: Pick<PrinterAvailability, "status" | "connectionType" | "protocol">): boolean {
  const status = String(printer.status ?? "").toLowerCase().trim();
  // Positive evidence of availability. "busy" (spooler printing/processing,
  // IPP state 4, ESC/POS back-channel busy) means the queue accepts more work.
  if (status === "online" || status === "busy") return true;
  // Positive evidence of a problem. Fail fast with an explicit reason instead
  // of stranding a durable job or burning the delivery budget against a
  // printer we already know is broken. Queued jobs stay durable and become
  // claimable when a fresh probe succeeds again.
  if (status === "offline" || status === "error") return false;

  // Only "unknown" (absence of evidence) remains. Eligible iff the transport
  // is fully declared so the agent has a concrete pre-dispatch probe to run
  // before any byte reaches hardware.
  if (status !== "unknown") return false;

  const rawConn = String(printer.connectionType ?? "").toLowerCase();
  const conn = rawConn === "windows_spooler" ? "spooler" : rawConn;
  const rawProto = String(printer.protocol ?? "").toLowerCase();
  const proto = rawProto === "windows_spooler" && conn === "spooler" ? "spooler" : rawProto;

  // Windows spooler queue: the queue transport itself is the declaration.
  // A protocol token alone must not turn a network/USB row into a spooler.
  // OpenPrinterW + GetPrinterW (level 2) is the pre-dispatch probe.
  if (conn === "spooler") return true;
  // IPP/IPPS document transport: the endpoint URL IS the declaration.
  if (conn === "ipp" || conn === "ipps" || (conn === "network" && (proto === "ipp" || proto === "ipps"))) return true;
  // Direct byte-stream transports: require an explicitly declared language.
  // "unknown" protocol on a byte pipe is dark until declared (mirrors the
  // capability model: unknown+network/usb resolves to a name nothing matches).
  if (conn === "network" || conn === "usb") {
    return (payloadContract.rawProtocols as readonly string[]).includes(proto);
  }
  return false;
}

/**
 * isPrinterClaimable answers the same question as isPrinterStatusExecutable
 * for the delivery boundary: "Is there enough trustworthy evidence to ATTEMPT
 * this job?" Single canonical predicate: claim == executable. The SQL claim
 * gates add lifecycle, agent freshness, printer freshness, desired-state and
 * entitlement on top; they must never reimplement the status/transport rule.
 */
export function isPrinterClaimable(printer: Pick<PrinterAvailability, "status" | "connectionType" | "protocol">): boolean {
  return isPrinterStatusExecutable(printer);
}

export function isPrinterAvailableForJob(
  printer: PrinterAvailability,
  agent?: { lifecycle?: string | null; status?: string | null; lastSeenAt?: Date | string | null } | null,
  now = gatewayNow(),
): boolean {
  if (printer.lifecycle !== "active") return false;
  if (printer.inventoryPresent === false) return false;
  if (isVirtualPrinterRecord(printer) && (printer.managementSource !== "manager" || !isApprovedVirtualSpoolerTestRecord(printer))) return false;
  if (agent !== undefined && !isAgentAvailableForPrinter(agent, now)) return false;
  return isPrinterStatusExecutable(printer);
}

export function isAgentAvailableForPrinter(
  agent: {
    lifecycle?: string | null;
    status?: string | null;
    lastSeenAt?: Date | string | null;
  } | null | undefined,
  now = gatewayNow(),
): boolean {
  if (!agent || agent.lifecycle !== "active") return false;
  return getAgentAvailability(agent, now).available;
}
