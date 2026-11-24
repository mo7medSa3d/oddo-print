import contract from "../../contracts/printer-geometry-contract.json";
import { isExactPrinterId } from "./exact-printer-id";

/** Physical observations and explicit operator profiles share units, never defaults. */
export interface PrinterGeometryProfile {
  printable_width_dots: number;
  printable_height_dots?: number;
  dpi_x?: number;
  dpi_y?: number;
  paper_width_mm?: number;
  paper_height_mm?: number;
  offset_x_dots?: number;
  offset_y_dots?: number;
  raster_command?: "gs_v_0";
}

export interface PrinterGeometry extends PrinterGeometryProfile {
  version: 1;
  source: "windows_driver" | "ipp" | "validated_profile";
  validation: "observed" | "configured";
  observed_at: string;
  printer_id: string;
  config_fingerprint: string;
}

type GeometryResult<T> = { ok: true; value: T } | { ok: false; reason: string };
export const GEOMETRY_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

const profileFields = new Set<string>(contract.profileFields);
const geometryFields = new Set<string>([...contract.requiredFields, ...contract.profileFields]);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value);

function checkMeasurements(value: Record<string, unknown>): string | null {
  if (!("printable_width_dots" in value)) return "printable_width_dots is required";
  for (const [key, bounds] of Object.entries(contract.bounds)) {
    if (!(key in value)) continue;
    const measurement = value[key];
    const millimetres = key.endsWith("_mm");
    if (typeof measurement !== "number" || !Number.isFinite(measurement)
        || (!millimetres && !Number.isInteger(measurement))
        || measurement < bounds[0] || measurement > bounds[1] || (millimetres && measurement === 0)) {
      return `${key} must be a finite ${millimetres ? "positive number" : "integer"} within ${bounds[0]}..${bounds[1]}`;
    }
  }
  if ("raster_command" in value && value.raster_command !== "gs_v_0") return "raster_command must be gs_v_0";
  for (const axis of ["x", "y"] as const) {
    const dimension = axis === "x" ? "width" : "height";
    const paper = value[`paper_${dimension}_mm`];
    const dpi = value[`dpi_${axis}`];
    const printable = value[`printable_${dimension}_dots`];
    const offset = value[`offset_${axis}_dots`];
    if (typeof paper !== "number" || typeof dpi !== "number") continue;
    const paperDots = paper * dpi / 25.4;
    // A missing offset remains unknown. This is a lower-bound consistency
    // check only, and does not manufacture a zero-offset observation.
    const knownExtent = (typeof printable === "number" ? printable : 0)
      + (typeof offset === "number" ? offset : 0);
    if (knownExtent - paperDots > contract.physicalConsistencyToleranceDots + 1e-9) {
      return `printable ${dimension} and offset exceed the physical paper ${dimension}`;
    }
  }
  return null;
}

export function validatePrinterGeometryProfile(value: unknown): GeometryResult<PrinterGeometryProfile> {
  if (!isRecord(value)) return { ok: false, reason: "geometry_profile must be an object" };
  if (Object.keys(value).some((key) => !profileFields.has(key))) return { ok: false, reason: "geometry_profile contains an unsupported field" };
  const reason = checkMeasurements(value);
  return reason ? { ok: false, reason } : { ok: true, value: { ...value } as unknown as PrinterGeometryProfile };
}

function validObservedAt(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

export function validatePrinterGeometry(
  value: unknown,
  expected?: { printerId?: string; fingerprint?: string },
): GeometryResult<PrinterGeometry> {
  if (!isRecord(value)) return { ok: false, reason: "verified printer geometry is required" };
  if (Object.keys(value).some((key) => !geometryFields.has(key))) return { ok: false, reason: "geometry contains an unsupported field" };
  if (value.version !== contract.version) return { ok: false, reason: "unsupported printer geometry version" };
  if (!(contract.sources as readonly unknown[]).includes(value.source)
      || value.validation !== (value.source === "validated_profile" ? "configured" : "observed")) {
    return { ok: false, reason: "printer geometry provenance is invalid" };
  }
  if (!validObservedAt(value.observed_at)) return { ok: false, reason: "geometry observed_at must be a valid UTC RFC3339 timestamp" };
  // Geometry provenance must use the *same* opaque UTF-8 printer identity
  // guard as Gateway inventory, heartbeat and the native Agent. JS string
  // length counts UTF-16 code units and silently accepts 121+ UTF-8 bytes.
  if (!isExactPrinterId(value.printer_id)) {
    return { ok: false, reason: "geometry printer_id is invalid" };
  }
  if (expected?.printerId !== undefined && value.printer_id !== expected.printerId) return { ok: false, reason: "geometry belongs to a different printer" };
  if (typeof value.config_fingerprint !== "string" || !GEOMETRY_FINGERPRINT_PATTERN.test(value.config_fingerprint)) {
    return { ok: false, reason: "geometry config_fingerprint must be lowercase SHA256 hex" };
  }
  if (expected?.fingerprint !== undefined && value.config_fingerprint !== expected.fingerprint) return { ok: false, reason: "printer geometry changed; refresh the printer and render the receipt again" };
  const reason = checkMeasurements(value);
  return reason ? { ok: false, reason } : { ok: true, value: { ...value } as unknown as PrinterGeometry };
}

export function printerGeometryFromCapabilities(
  capabilities: unknown,
  expected?: { printerId?: string; fingerprint?: string },
): PrinterGeometry | null {
  const parsed = validatePrinterGeometry(isRecord(capabilities) ? capabilities.geometry : undefined, expected);
  return parsed.ok ? parsed.value : null;
}

export function hasPhysicalReceiptGeometry(geometry: PrinterGeometry): geometry is PrinterGeometry & Required<Pick<PrinterGeometry, "dpi_x" | "dpi_y" | "paper_width_mm">> {
  return geometry.dpi_x !== undefined && geometry.dpi_y !== undefined && geometry.paper_width_mm !== undefined;
}

export interface GeometryPrinterState {
  id: string;
  capabilities?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  managementSource?: string | null;
  desiredRevision?: number | null;
  appliedDesiredRevision?: number | null;
  observedDesiredRevision?: number | null;
}

/** Do not publish an old measurement while a new desired configuration is applying. */
export function currentPrinterGeometry(printer: GeometryPrinterState): PrinterGeometry | null {
  if (printer.managementSource === "manager"
      && ((printer.appliedDesiredRevision ?? 0) < (printer.desiredRevision ?? 0)
        || (printer.observedDesiredRevision ?? 0) < (printer.desiredRevision ?? 0))) return null;
  const geometry = printerGeometryFromCapabilities(printer.capabilities, { printerId: printer.id });
  // A configured snapshot is the exact profile the Agent applied. Even a
  // reordered desired-state ACK cannot make the previous profile current.
  // Live driver/IPP measurements remain authoritative over fallback profiles.
  if (geometry?.source === "validated_profile") {
    // Driver/IPP observations remain independent; configured geometry must
    // never outlive the exact profile that explicitly authorized it.
    const profile = validatePrinterGeometryProfile(printer.config?.geometry_profile);
    if (!profile.ok || contract.profileFields.some((field) => {
      const key = field as keyof PrinterGeometryProfile;
      return profile.value[key] !== geometry[key];
    })) return null;
  }
  return geometry;
}

export function capabilitiesWithCurrentGeometry(printer: GeometryPrinterState): Record<string, unknown> | null {
  if (!printer.capabilities) return null;
  const { geometry: _previous, ...capabilities } = printer.capabilities;
  const geometry = currentPrinterGeometry(printer);
  return geometry ? { ...capabilities, geometry } : capabilities;
}
