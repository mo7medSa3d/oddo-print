import type { PrinterGeometry } from "../../src/lib/printer-geometry";

export const fixtureGeometryFingerprint = "a".repeat(64);
export const fixtureImagePayload = { type: "image", geometry_fingerprint: fixtureGeometryFingerprint };

/** Explicit test measurement; callers must declare its driver/profile origin. */
export function fixturePrinterGeometry(printerId = "fixture-printer", raster = false): PrinterGeometry {
  return {
    version: 1, source: raster ? "validated_profile" : "windows_driver",
    validation: raster ? "configured" : "observed", observed_at: "2026-10-24T12:00:00Z",
    printer_id: printerId, config_fingerprint: fixtureGeometryFingerprint,
    printable_width_dots: 576, paper_width_mm: 80, dpi_x: 203, dpi_y: 203,
    ...(raster ? { raster_command: "gs_v_0" as const } : {}),
  };
}
