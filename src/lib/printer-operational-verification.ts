import contract from "../../contracts/printer-operational-verification-contract.json";
import { parseDbTimeMs } from "./database-timestamp";
import { isExactPrinterId } from "./exact-printer-id";

export const PRINTER_VERIFICATION_MAX_AGE_SECONDS = contract.maxAgeSeconds;
export const PRINTER_VERIFICATION_MAX_FUTURE_SKEW_SECONDS = contract.maxFutureSkewSeconds;
interface PrinterOperationalVerification {
  version: 1;
  verified_at: string;
  printer_id: string;
  binding_digest: string;
  method: "windows_queue" | "ipp_attributes" | "usb_interface" | "snmp_printer";
  logical_queue_key: string;
  physical_device_key?: string;
  identity_strength: "queue" | "service" | "device";
  output_medium: "physical";
}
export interface OperationalPrinterState {
  id?: string;
  connectionType?: string | null;
  protocol?: string | null;
  capabilities?: unknown;
  verificationState?: string | null;
  verificationVerifiedAt?: Date | string | null;
  verificationReceivedAt?: Date | string | null;
  verificationBindingDigest?: string | null;
  verificationReason?: string | null;
  logicalQueueKey?: string | null;
  physicalDeviceKey?: string | null;
  outputMedium?: string | null;
  managementSource?: string | null;
  desiredRevision?: number | null;
  appliedDesiredRevision?: number | null;
  observedDesiredRevision?: number | null;
}

/**
 * These reasons represent positive endpoint/identity conflicts, not a missing
 * or stale operational proof. They remain hard routing blocks until inventory
 * is reconciled; advisory verification must never authorize a mismatched target.
 */
export const HARD_PRINTER_BINDING_CONFLICT_REASONS = [
  "verification_destination_mismatch",
  "verification_identity_collision",
  "verification_ambiguous_inventory_id",
] as const;

export function hasHardPrinterBindingConflict(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined
    && (HARD_PRINTER_BINDING_CONFLICT_REASONS as readonly string[]).includes(reason);
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = new Set([...contract.requiredFields, ...contract.optionalFields]);
const hex = /^[a-f0-9]{64}$/;
function utcTime(value: unknown): number | null {
  if (typeof value !== "string" || value !== value.trim() || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}
export type OperationalVerificationResult = { ok: true; value: PrinterOperationalVerification } | { ok: false; reason: string };
export function validatePrinterOperationalVerification(value: unknown, printer: Pick<OperationalPrinterState, "id" | "connectionType" | "protocol">, now = new Date()): OperationalVerificationResult {
  if (!isRecord(value)) return { ok: false, reason: "verification_missing" };
  if (Object.keys(value).some(key => !fields.has(key)) || contract.requiredFields.some(key => !(key in value)) || value.version !== 1) return { ok: false, reason: "verification_invalid" };
  // Operational proof and stored verification states must use the same
  // exact opaque UTF-8 identity as the heartbeat and geometry boundary.
  // A matching JS UTF-16 string is not sufficient for native execution.
  if (!isExactPrinterId(value.printer_id) || !isExactPrinterId(printer.id) || value.printer_id !== printer.id) {
    return { ok: false, reason: "verification_printer_mismatch" };
  }
  if (typeof value.binding_digest !== "string" || (value.binding_digest.length !== 64 || !hex.test(value.binding_digest)) || value.logical_queue_key !== value.binding_digest
      || (value.physical_device_key !== undefined && (typeof value.physical_device_key !== "string" || (value.physical_device_key.length !== 64 || !hex.test(value.physical_device_key))))) return { ok: false, reason: "verification_identity_invalid" };
  if (!(contract.methods as unknown[]).includes(value.method) || !(contract.identityStrengths as unknown[]).includes(value.identity_strength)
      || !(contract.outputMedia as unknown[]).includes(value.output_medium) || (value.physical_device_key !== undefined && value.identity_strength !== "device")) return { ok: false, reason: "verification_invalid" };
  const connection = String(printer.connectionType ?? "").trim().toLowerCase();
  const protocol = String(printer.protocol ?? "").trim().toLowerCase();
  const method = connection === "spooler" && ["spooler", "windows_spooler"].includes(protocol) ? "windows_queue"
    : (["ipp", "ipps"].includes(connection) || connection === "network" && ["ipp", "ipps"].includes(protocol)) ? "ipp_attributes"
    : connection === "usb" && ["raw", "escpos", "zpl", "tspl"].includes(protocol) ? "usb_interface"
    : connection === "network" && ["raw", "escpos", "zpl", "tspl"].includes(protocol) ? "snmp_printer" : null;
  // A live service/queue probe is not hardware chassis evidence. The native
  // Agent binds each method to one identity strength, not arbitrary metadata.
  // In particular, a forged device key must never upgrade an IPP service or
  // Windows spooler queue into a physical-device identity.
  const methodStrength = method ? contract.methodIdentityStrength[method] : null;
  if (!method || method !== value.method || value.identity_strength !== methodStrength
      || (value.physical_device_key !== undefined && methodStrength !== "device")
      || value.output_medium !== "physical") {
    return { ok: false, reason: "verification_transport_mismatch" };
  }
  const verified = utcTime(value.verified_at);
  if (verified === null) return { ok: false, reason: "verification_timestamp_invalid" };
  const age = now.getTime() - verified;
  if (!Number.isFinite(age) || age > PRINTER_VERIFICATION_MAX_AGE_SECONDS * 1000 || age < -PRINTER_VERIFICATION_MAX_FUTURE_SKEW_SECONDS * 1000) return { ok: false, reason: "verification_expired" };
  return { ok: true, value: { ...value } as unknown as PrinterOperationalVerification };
}

/** This projection is written only by authenticated Agent inventory, never a manager DTO. */
export function operationalVerificationProjection(value: unknown, printer: Pick<OperationalPrinterState, "id" | "connectionType" | "protocol">, now: Date) {
  const result = validatePrinterOperationalVerification(value, printer, now);
  return result.ok ? {
    verificationState: "verified" as const,
    verificationVerifiedAt: new Date(result.value.verified_at),
    verificationReceivedAt: now,
    verificationBindingDigest: result.value.binding_digest,
    verificationReason: null as string | null,
    logicalQueueKey: result.value.logical_queue_key,
    physicalDeviceKey: result.value.physical_device_key ?? null,
    outputMedium: result.value.output_medium,
  } : {
    verificationState: "pending" as const,
    verificationVerifiedAt: null,
    verificationReceivedAt: null,
    verificationBindingDigest: null,
    verificationReason: result.reason,
  };
}

export function isPrinterOperationallyVerified(printer: OperationalPrinterState, now = new Date()): boolean {
  if (printer.verificationState !== "verified" || !isExactPrinterId(printer.id) || !printer.verificationBindingDigest || (printer.verificationBindingDigest.length !== 64 || !hex.test(printer.verificationBindingDigest))
      || printer.logicalQueueKey !== printer.verificationBindingDigest) return false;
  if (printer.managementSource === "manager" && ((printer.appliedDesiredRevision ?? 0) < (printer.desiredRevision ?? 0) || (printer.observedDesiredRevision ?? 0) < (printer.desiredRevision ?? 0))) return false;
  const verified = parseDbTimeMs(printer.verificationVerifiedAt);
  const received = parseDbTimeMs(printer.verificationReceivedAt);
  if (verified === null || received === null || !Number.isFinite(now.getTime())) return false;
  const maxAge = PRINTER_VERIFICATION_MAX_AGE_SECONDS * 1000;
  return verified >= now.getTime() - maxAge && verified <= now.getTime() + PRINTER_VERIFICATION_MAX_FUTURE_SKEW_SECONDS * 1000
    && received >= now.getTime() - maxAge && received <= now.getTime();
}

export function operationalVerificationPresentation(printer: OperationalPrinterState, now = new Date()) {
  return {
    verificationState: isPrinterOperationallyVerified(printer, now) ? "verified" as const : "pending" as const,
    verificationVerifiedAt: printer.verificationVerifiedAt ?? null,
    verificationReceivedAt: printer.verificationReceivedAt ?? null,
    verificationReason: isPrinterOperationallyVerified(printer, now) ? null : printer.verificationReason ?? "verification_expired",
    outputMedium: "physical" as const,
  };
}
