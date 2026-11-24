import payloadContract from "../../contracts/print-payload-contract.json";
import { z } from "zod";
import { receiptPaperWidthMM } from "./receipt-width";
import { validatePayloadForPrinter } from "./printer-capability";
import { GEOMETRY_FINGERPRINT_PATTERN } from "./printer-geometry";

const MAX_PAYLOAD_BYTES = payloadContract.maxPayloadBytes;
const PAYLOAD_TYPES = payloadContract.wireTypes as ["raw", "escpos", "pdf", "image"];
const RAW_PROTOCOLS = payloadContract.rawProtocols as ["raw", "escpos", "zpl", "tspl"];
const DRAWER_MODES = payloadContract.peripherals.drawer as ["pin2", "pin5", "none"];
const CUTTER_MODES = payloadContract.peripherals.cutter as ["partial", "full", "none"];
const BUZZER_MODES = payloadContract.peripherals.buzzer as ["epson_pulse", "star_bel", "none"];

export const printJobPayloadSchema = z.object({
  type: z.enum(PAYLOAD_TYPES),
  encoding: z.literal(payloadContract.encoding),
  protocol: z.enum(RAW_PROTOCOLS).optional(),
  geometry_fingerprint: z.string().regex(GEOMETRY_FINGERPRINT_PATTERN, "geometry_fingerprint must be lowercase SHA256 hex").optional(),
  peripherals: z.object({
    drawer: z.enum(DRAWER_MODES).optional(),
    cutter: z.enum(CUTTER_MODES).optional(),
    buzzer: z.enum(BUZZER_MODES).optional(),
    // Strict: an unknown peripheral key (e.g. a "cuttter" typo) must fail
    // admission loudly instead of printing without the requested device
    // action. The wire contract lists exactly these three keys.
  }).strict().optional(),
  data: z.string().min(1).max((MAX_PAYLOAD_BYTES / 3) * 4 + 8, { message: `payload.data must be valid base64 and decode to 1..${MAX_PAYLOAD_BYTES} bytes` }),
}).superRefine((payload, ctx) => {
  // Optional at the syntax boundary so historical accepted image operations
  // can still reconcile their exact original payload. New image admission
  // requires a matching fingerprint under the authoritative printer row lock.
  if (payload.type !== "image" && payload.geometry_fingerprint !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["geometry_fingerprint"], message: "geometry_fingerprint is only applicable to image payloads" });
  }
  // Single base64 decode for the whole admission: the round-trip check below
  // rejects non-canonical input, then every signature check reuses `decoded`.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(payload.data, "base64");
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length === 0 || decoded.length > MAX_PAYLOAD_BYTES || decoded.toString("base64") !== payload.data) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: `payload.data must be valid base64 and decode to 1..${MAX_PAYLOAD_BYTES} bytes` });
    return;
  }
  const pdfSignature = Buffer.from(payloadContract.signatures.pdfPrefix);
  const jpegSignature = decoded.length >= 3 && decoded.subarray(0, 3).equals(Buffer.from(payloadContract.signatures.jpegHexPrefix, "hex"));
  const looksLikePdf = decoded.length >= pdfSignature.length && decoded.subarray(0, pdfSignature.length).equals(pdfSignature);

  if (payload.type === "pdf" && !looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF payload must start with the %PDF- signature" });
  }
  // The Windows Agent's ValidatePDF refuses documents without a %%EOF marker
  // in the final 4 KiB. Reject those at Gateway admission, before creating a
  // durable job that is guaranteed to fail after Agent delivery.
  if (payload.type === "pdf" && looksLikePdf && !decoded.subarray(Math.max(0, decoded.length - 4096)).includes(Buffer.from("%%EOF"))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF payload is incomplete (missing %%EOF trailer)" });
  }
  if (payload.type === "image" && !jpegSignature) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "Image payload must be a JPEG" });
  }
  if ((payload.type === "raw" || payload.type === "escpos") && looksLikePdf) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "PDF bytes cannot be labeled as raw/escpos; provide a real byte-stream payload or convert explicitly" });
  }

  if (payload.type === "raw") {
    if (!payload.protocol) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol is required for raw payloads" });
    }
  }
  if (payload.type === "escpos") {
    if (!payload.protocol || payload.protocol !== "escpos") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol 'escpos' is required for escpos payloads" });
    }
  }
  if ((payload.type === "pdf" || payload.type === "image") && payload.protocol) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["protocol"], message: "protocol is not applicable for pdf/image payloads" });
  }
  if (payload.peripherals) {
    const hasPeripherals = [payload.peripherals.drawer, payload.peripherals.cutter, payload.peripherals.buzzer]
      .some((mode) => Boolean(mode) && mode !== "none");
    if (hasPeripherals && payload.protocol !== "escpos") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["peripherals"], message: "peripherals are only supported for escpos protocol" });
    }
  }
});

export type PrintJobPayload = z.infer<typeof printJobPayloadSchema>;

export function validatePrintJobPayload(payload: unknown): PrintJobPayload {
  return printJobPayloadSchema.parse(payload);
}

export function buildTestPrintPayload(printerName: string, agentName: string): PrintJobPayload {
  // Names are user-controlled: strip C0 controls (incl. ESC) so a crafted
  // name cannot inject command bytes into the diagnostic ticket.
  const safeName = String(printerName ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 60);
  const safeAgent = String(agentName ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 60);
  const lines = [
    "\x1b\x40",
    "Yaseir Agent\n",
    "Test Print\n",
    `Printer: ${safeName}\n`,
    `Agent: ${safeAgent}\n`,
    "------------------------\n",
    "Connection OK\n",
    "------------------------\n\n\n",
  ].join("");

  return { type: "escpos", protocol: "escpos", encoding: "base64", data: Buffer.from(lines, "binary").toString("base64") };
}

function safeTestText(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").slice(0, 60);
}

// Explicit selected paper only, never device names, printer class, or a list
// of supported (but unselected) forms. Windows Spooler will read actual driver
// media at Agent dispatch when documentType=test_page is claimed.
const DIAGNOSTIC_SHEET_POINTS = {
  a3: [841.89, 1190.55],
  a4: [595.276, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
} as const;
type DiagnosticSheet = keyof typeof DIAGNOSTIC_SHEET_POINTS;

export function selectedDiagnosticSheet(value: Record<string, unknown> | null | undefined): DiagnosticSheet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value.selected_paper ?? value.paper_format;
  if (typeof raw !== "string") return null;
  const sheet = raw.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SHEET_POINTS, sheet) ? sheet as DiagnosticSheet : null;
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildTestPdfPayload(printerName: string, agentName: string, operationId?: string, paperWidthMM?: number, selectedSheet?: DiagnosticSheet): string {
  // receiptPaperWidthMM accepts verified/selected roll widths from 40–120 mm,
  // including non-standard and fractional media. Keep this lower-level PDF
  // builder equally defensive because it can also be called directly.
  if (paperWidthMM !== undefined && (!Number.isFinite(paperWidthMM) || paperWidthMM < 40 || paperWidthMM > 120)) {
    throw new RangeError("Diagnostic receipt paper width must be a finite value between 40 and 120 mm");
  }
  const isRoll = paperWidthMM !== undefined;
  const stamp = operationId ? `Operation ${safeTestText(operationId)}` : new Date().toISOString().replace("T", " ").slice(0, 19);

  const sheet = selectedSheet ? DIAGNOSTIC_SHEET_POINTS[selectedSheet] : DIAGNOSTIC_SHEET_POINTS.letter;
  const width = isRoll ? Number((paperWidthMM * 72 / 25.4).toFixed(3)) : sheet[0];
  const height = isRoll ? Number((payloadContract.diagnosticPage.rollLengthMM * 72 / 25.4).toFixed(3)) : sheet[1];
  const ticketLines = [
    `Printer: ${safeTestText(printerName)}`, `Agent: ${safeTestText(agentName)}`, `Status: OK | ${stamp}`,
  ].flatMap((line) => line.match(new RegExp(`.{1,${Math.floor((width - (isRoll ? 24 : 100)) / (isRoll ? 8 : 12))}}`, "g")) ?? []);
  const streamContent = (isRoll ? [
    "BT", "/F1 12 Tf", `12 ${height - 24} Td`, "(YASEIR TEST PAGE) Tj", "/F1 8 Tf", "0 -22 Td",
    ...ticketLines.flatMap((line, index) => [...(index ? ["0 -12 Td"] : []), `(${escapePdfText(line)}) Tj`]), "ET",
  ] : [
    "BT",
    "/F1 18 Tf",
    `50 ${Number((height - 72).toFixed(3))} Td`,
    "(YASEIR TEST PAGE) Tj",
    "/F1 12 Tf",
    "0 -30 Td",
    ...ticketLines.flatMap((line, index) => [...(index ? ["0 -20 Td"] : []), `(${escapePdfText(line)}) Tj`]),
    "ET",
  ]).join("\n");

  const streamLength = Buffer.byteLength(streamContent, "utf-8");

  const header = "%PDF-1.4\n";
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`;
  const obj4 = "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const obj5 = `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`;

  const off1 = Buffer.byteLength(header);
  const off2 = off1 + Buffer.byteLength(obj1);
  const off3 = off2 + Buffer.byteLength(obj2);
  const off4 = off3 + Buffer.byteLength(obj3);
  const off5 = off4 + Buffer.byteLength(obj4);
  const startxref = off5 + Buffer.byteLength(obj5);

  const pad = (n: number) => String(n).padStart(10, "0");

  const xref = [
    "xref",
    "0 6",
    "0000000000 65535 f ",
    `${pad(off1)} 00000 n `,
    `${pad(off2)} 00000 n `,
    `${pad(off3)} 00000 n `,
    `${pad(off4)} 00000 n `,
    `${pad(off5)} 00000 n `,
    "trailer",
    "<< /Size 6 /Root 1 0 R >>",
    "startxref",
    String(startxref),
    "%%EOF\n",
  ].join("\n");

  return header + obj1 + obj2 + obj3 + obj4 + obj5 + xref;
}

/**
 * Build a test ticket in the LANGUAGE THE PRINTER ACTUALLY SPEAKS. An
 * ESC/POS ticket sent to a ZPL printer is garbage, and the strict capability
 * model now rejects it — so the gateway (like the Odoo router's
 * route_test_page) selects the template from the printer's declared
 * protocol. Document transports (spooler/ipp) use a minimal printable PDF ticket.
 */
export function buildTestPrintPayloadForPrinter(
  printerName: string,
  agentName: string,
  printer: { protocol?: string | null; connectionType?: string | null; capabilities?: Record<string, unknown> | null; config?: Record<string, unknown> | null },
  operationId?: string,
): PrintJobPayload {
  const rawDeclared = (printer.protocol ?? "").toLowerCase().trim();
  const declared = rawDeclared === "windows_spooler" ? "spooler" : rawDeclared;
  const rawConn = (printer.connectionType ?? "").toLowerCase().trim();
  const conn = rawConn === "windows_spooler" ? "spooler" : rawConn === "tcp" ? "network" : rawConn;
  const capabilities = printer.capabilities ?? null;
  const physicalPrinter = { protocol: declared, connectionType: conn, capabilities };
  const byteCandidates = RAW_PROTOCOLS;
  const declaredByteProtocol = byteCandidates.includes(declared as (typeof byteCandidates)[number])
    ? declared as (typeof byteCandidates)[number]
    : null;
  // For a declared byte protocol, explicit capabilities can only confirm
  // that protocol; they cannot replace it with another language. The Gateway
  // routing contract fences physical byte transports to the declared protocol.
  // Unknown byte transports remain dark until a protocol is explicitly declared.
  const byteProto = declaredByteProtocol && validatePayloadForPrinter({
    type: declaredByteProtocol === "escpos" ? "escpos" : "raw", protocol: declaredByteProtocol,
  }, physicalPrinter).ok ? declaredByteProtocol : "";
  const plainName = safeTestText(printerName);
  const plainAgent = safeTestText(agentName);
  const stamp = operationId ? `Operation ${safeTestText(operationId)}` : new Date().toISOString().replace("T", " ").slice(0, 19);

  if (byteProto === "escpos") {
    return buildTestPrintPayload(printerName, agentName);
  }
  if (byteProto === "zpl") {
    // A small buffered format also works while the printer is busy. Keep
    // calibrated media and avoid a fixed wide border or unbounded names.
    const zpl = "^XA\n^FO4,4^A0N,12,12^FDTEST^FS\n^XZ\n";
    return { type: "raw", protocol: "zpl", encoding: "base64", data: Buffer.from(zpl, "utf-8").toString("base64") };
  }
  if (byteProto === "tspl") {
    // The firmware prints its own diagnostic using its calibrated stock.
    // Width-only inventory cannot safely supply label length or gap mode.
    const tspl = "SELFTEST\r\n";
    return { type: "raw", protocol: "tspl", encoding: "base64", data: Buffer.from(tspl, "utf-8").toString("base64") };
  }
  if (byteProto === "raw") {
    const raw = [
      "================================",
      "  YASEIR TEST PAGE ",
      "================================",
      `Printer : ${plainName}`,
      `Agent   : ${plainAgent}`,
      "Protocol: RAW",
      "--------------------------------",
      `Status  : OK | ${stamp}`,
      "================================\n\n\n",
    ].join("\n");
    return { type: "raw", protocol: "raw", encoding: "base64", data: Buffer.from(raw, "utf-8").toString("base64") };
  }

  // Same physical transport predicate as validatePayloadForPrinter(): a
  // network/TCP printer merely labelled "spooler" is not a Windows print
  // queue, so it must not receive a driver-rendered PDF test ticket.
  // Existing USB-backed Windows queues retain their documented compatibility.
  const physicalSpooler = conn === "spooler" || (conn === "usb" && declared === "spooler");
  const physicalDocumentTransport = physicalSpooler ||
    conn === "ipp" || conn === "ipps" ||
    (conn === "network" && (declared === "ipp" || declared === "ipps"));
  // Document transports keep their intrinsic document-rendering baseline.
  // supported_protocols may opt a spooler into byte passthrough, but it must
  // never make an otherwise valid spooler/IPP test page stop being printable.
  if (physicalDocumentTransport && validatePayloadForPrinter({ type: "pdf" }, physicalPrinter).ok) {
    const roll = receiptPaperWidthMM(capabilities) ?? receiptPaperWidthMM(printer.config);
    const sheet = selectedDiagnosticSheet(capabilities) ?? selectedDiagnosticSheet(printer.config);
    const pdf = buildTestPdfPayload(plainName, plainAgent, operationId, roll ?? undefined, sheet ?? undefined);
    return {
      type: "pdf",
      encoding: "base64",
      data: Buffer.from(pdf, "utf-8").toString("base64"),
    };
  }

  throw new Error("This printer transport has no supported test ticket format; print a real report to validate the path.");
}
