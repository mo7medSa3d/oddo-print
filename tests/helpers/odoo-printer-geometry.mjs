import { createHash } from "node:crypto";

// Explicit synthetic measurements for Odoo software tests. These are never
// used as product defaults and do not claim any physical printer calibration.
export function receiptGeometry(dots = 384, dpi = 203, printerId = "fixture-printer") {
  const measurements = { printable_width_dots: dots, dpi_x: dpi, dpi_y: dpi, paper_width_mm: dots <= 384 ? 58 : 80 };
  return {
    version: 1, source: "validated_profile", validation: "configured",
    observed_at: "2026-10-24T12:00:00Z", printer_id: printerId,
    config_fingerprint: createHash("sha256").update(JSON.stringify({ printerId, ...measurements })).digest("hex"),
    ...measurements, raster_command: "gs_v_0",
  };
}

export function verifiedPrinter(printer) {
  const stamp = new Date().toISOString();
  const connection = printer.connectionType, protocol = printer.protocol;
  const medium = "physical";
  // The fixture must mirror the shipping Odoo/Gateway proof vocabulary.
  // Every physical byte transport is *device* strength, IPP is
  // *service*, and only a real Windows spooler queue has *queue* strength.
  const method = connection === "spooler" ? "windows_queue"
    : ["ipp", "ipps"].includes(connection) || ["ipp", "ipps"].includes(protocol) ? "ipp_attributes"
      : connection === "usb" ? "usb_interface" : "snmp_printer";
  const identityStrength = method === "windows_queue" ? "queue"
    : method === "ipp_attributes" ? "service" : "device";
  return { ...printer, verificationState: "verified", verificationVerifiedAt: stamp, verificationReceivedAt: stamp,
    outputMedium: medium, printerType: "physical",
    capabilities: { ...printer.capabilities, operational_verification: { version: 1, verified_at: stamp, printer_id: printer.id,
      binding_digest: "a".repeat(64), logical_queue_key: "a".repeat(64), method, identity_strength: identityStrength, output_medium: medium } } };
}
