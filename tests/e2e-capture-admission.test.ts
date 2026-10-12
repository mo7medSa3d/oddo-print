import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { captureEnabled, parseCaptureRequest, CAPTURE_MAX_BYTES, readBoundedCaptureJSON } from "../src/lib/e2e-capture";

const odooPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const body = (type: "pdf" | "image", data: Buffer, paperMm: 0 | 58 | 80 = 0) => ({
  agentId: "agt_12345678",
  idempotencyKey: "capture-unique-request-1234",
  paperMm,
  payload: { type, data: data.toString("base64"), encoding: "base64" },
});

describe("isolated Odoo -> Agent E2E capture admission", () => {
  it("is disabled by default, requiring an explicit gateway opt-in", () => {
    const original = process.env.YASEIR_E2E_CAPTURE_ENABLED;
    try {
      delete process.env.YASEIR_E2E_CAPTURE_ENABLED;
      expect(captureEnabled()).toBe(false);
      process.env.YASEIR_E2E_CAPTURE_ENABLED = "true";
      expect(captureEnabled()).toBe(false);
      process.env.YASEIR_E2E_CAPTURE_ENABLED = "1";
      expect(captureEnabled()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.YASEIR_E2E_CAPTURE_ENABLED;
      else process.env.YASEIR_E2E_CAPTURE_ENABLED = original;
    }
  });

  it("caps the actual body stream even without a Content-Length header", async () => {
    const req = new Request("https://test.invalid/api/odoo/test-captures", {
      method: "POST", body: "x".repeat(4096),
    });
    req.headers.delete("content-length");
    await expect(readBoundedCaptureJSON(req, 128)).rejects.toMatchObject({
      code: "DOCUMENT_TOO_LARGE", status: 413,
    });
  });

  it("accepts valid Odoo PDF and JPEG, preserving source geometry", () => {
    expect(parseCaptureRequest(body("pdf", odooPdf)).payload.type).toBe("pdf");
    expect(parseCaptureRequest(body("image", jpeg, 58)).paperMm).toBe(58);
    expect(parseCaptureRequest(body("image", jpeg, 80)).paperMm).toBe(80);
    expect(parseCaptureRequest(body("image", jpeg)).paperMm).toBe(0);
  });

  it("rejects commands, peripherals, forged agents and invalid paper sizes", () => {
    expect(() => parseCaptureRequest({ ...body("pdf", odooPdf), paperMm: 80 })).toThrow();
    expect(() => parseCaptureRequest({ ...body("image", jpeg), paperMm: 42 })).toThrow();
    expect(() => parseCaptureRequest({ ...body("pdf", odooPdf), agentId: "agt_bad" })).toThrow();
    expect(() => parseCaptureRequest({ ...body("pdf", odooPdf),
      payload: { ...body("pdf", odooPdf).payload, peripherals: { cutter: "full" } } })).toThrow();
    expect(() => parseCaptureRequest({ ...body("pdf", odooPdf),
      payload: { type: "raw", protocol: "escpos", encoding: "base64", data: jpeg.toString("base64") } })).toThrow();
    expect(() => parseCaptureRequest({ ...body("image", jpeg), maliciousPrinterId: "p1" })).toThrow();
    expect(() => parseCaptureRequest({ ...body("image", jpeg), idempotencyKey: "short" })).toThrow();
    expect(() => parseCaptureRequest(body("image", Buffer.alloc(CAPTURE_MAX_BYTES + 1, 5)))).toThrow();
  });

  it("fingerprints routing, paper and payload for collision-safe replay", () => {
    const a = parseCaptureRequest(body("image", jpeg, 58));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.fingerprint).not.toBe(parseCaptureRequest(body("image", jpeg, 80)).fingerprint);
    expect(a.fingerprint).not.toBe(parseCaptureRequest(body("pdf", odooPdf)).fingerprint);
  });

  it("does not register virtual printers, create normal print jobs or report physical success", () => {
    const migration = readFileSync("drizzle/0083_e2e_capture_runs.sql", "utf8");
    const captureAgent = readFileSync("agent/internal/agent/e2e_capture.go", "utf8");
    const odoo = readFileSync("src/app/api/odoo/test-captures/route.ts", "utf8");
    const agent = readFileSync("src/app/api/agent/test-captures/route.ts", "utf8");
    const view = readFileSync("odoo_addons/print_gateway/views/e2e_capture_wizard_views.xml", "utf8");
    expect(migration).toContain('"e2e_capture_runs"');
    expect(migration).not.toMatch(/REFERENCES "printers"|REFERENCES "print_jobs"/);
    expect(odoo).not.toContain("createPrintJobForPrinter");
    expect(agent).not.toContain("createPrintJobForPrinter");
    expect(captureAgent).toContain("printer.CaptureTestDocument");
    expect(captureAgent).not.toMatch(/dispatchJob\(|printer.New\(|OpenPrinter\(/);
    // The rendered/printed distinction is a Selection label in Odoo Python;
    // the XML displays that field as a badge rather than duplicating the text.
    const wizard = readFileSync("odoo_addons/print_gateway/models/e2e_capture_wizard.py", "utf8");
    expect(wizard).toContain('("rendered_locally", "Rendered locally — not printed")');
    expect(view).toContain('<field name="capture_status" widget="badge"');
    expect(view).toContain("capture_status == 'rendered_locally'");
    expect(readFileSync("src/lib/printer-virtual.ts", "utf8")).toContain("isVirtualPrinterRecord");
  });
});
