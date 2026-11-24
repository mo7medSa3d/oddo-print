// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toCanvas, waitImages } from "./__mocks__/odoo";
import sharedGeometry from "../contracts/printer-geometry-fixtures.json";
// @ts-expect-error Odoo JS modules have no TS declaration files.
import { validatedPrinterGeometry } from "../odoo_addons/print_gateway/static/src/js/printer_geometry";
// @ts-expect-error Odoo JS modules have no TS declaration files.
import { renderGatewayReceiptJpeg } from "../odoo_addons/print_gateway/static/src/js/receipt_raster";

function geometry(dpiX = 203, dpiY = dpiX, dots = 576) {
  return {
    version: 1, source: "validated_profile", validation: "configured",
    observed_at: "2026-10-24T00:00:00Z", printer_id: "selected-printer",
    config_fingerprint: "a".repeat(64), printable_width_dots: dots,
    dpi_x: dpiX, dpi_y: dpiY, paper_width_mm: 80,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = Number.parseFloat(this.style.width);
    return { width, height: 160, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 160, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return Math.ceil(Number.parseFloat(this.style.width));
  });
  toCanvas.mockImplementation(async (_node, options) => ({
    width: options.canvasWidth || options.width,
    height: options.canvasHeight || options.height,
    getContext: () => ({ fillRect() {} }),
    toDataURL: () => "data:image/jpeg;base64,VALIDJPEG",
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("Odoo receipt geometry v1", () => {
  it.each(sharedGeometry.geometryCases)("agrees with shared Gateway/Agent geometry: $name", (testCase) => {
    const expected = "expected" in testCase ? testCase.expected : undefined;
    const result = validatedPrinterGeometry(testCase.geometry,
      expected && "printerId" in expected ? expected.printerId : null,
      expected && "fingerprint" in expected ? expected.fingerprint : null);
    expect(Boolean(result)).toBe(testCase.valid);
    if (result) expect(result.printable_width_dots).toBe(testCase.rasterWidth);
  });
  it.each([
    ["120-byte ASCII", "a".repeat(120), true],
    ["121-byte ASCII", "a".repeat(121), false],
    ["120-byte Arabic", "ط".repeat(60), true],
    ["122-byte Arabic", "ط".repeat(61), false],
    ["120-byte emoji", "🖨".repeat(30), true],
    ["124-byte emoji", "🖨".repeat(31), false],
    ["leading BOM", "\uFEFFqueue", false],
    ["isolated high surrogate", "\uD800", false],
    ["isolated low surrogate", "\uDC00", false],
    ["interior BOM is exact", "que\uFEFFue", true],
  ] as const)("uses exact UTF-8 bytes and valid Unicode for geometry printer IDs: %s", (_label, id, allowed) => {
    const selected = { ...geometry(), printer_id: id };
    expect(Boolean(validatedPrinterGeometry(selected, id))).toBe(allowed);
  });

  it.each([undefined, null, {}, 512, { ...geometry(), dpi_x: undefined },
    { ...geometry(), dpi_y: 0 }, { ...geometry(), paper_width_mm: "80" },
    { ...geometry(), config_fingerprint: "unbound" }, { ...geometry(), printer_id: "" },
    { ...geometry(), source: "guess" }, { ...geometry(), validation: "observed" },
    { ...geometry(), printable_width_dots: 1000 },
  ])("rejects unknown or inconsistent geometry before capture (%j)", async (value) => {
    await expect(renderGatewayReceiptJpeg(document.createElement("div"), { geometry: value }))
      .rejects.toMatchObject({ code: "POS_RECEIPT_GEOMETRY" });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it.each([[203, 576], [300, 851], [600, 1702]])("separates CSS physical layout from %i DPI printer dots", async (dpi, dots) => {
    await renderGatewayReceiptJpeg(document.createElement("div"), { geometry: geometry(dpi, dpi, dots) });
    const [node, options] = toCanvas.mock.calls[0];
    expect(Number.parseFloat(node.style.width)).toBeCloseTo(dots * 96 / dpi, 7);
    expect(options.width).toBeCloseTo(dots * 96 / dpi, 7);
    expect(options.canvasWidth).toBe(dots);
    expect(options.canvasHeight).toBe(Math.ceil(160 * dpi / 96));
    expect(options.pixelRatio).toBe(1);
    expect(options.skipAutoScale).toBe(true);
    expect(options.skipFonts).toBe(true);
    expect(document.querySelector(".yaseir-gateway-receipt")).toBeNull();
  });

  it("uses the independent vertical DPI without stretching the physical layout", async () => {
    await renderGatewayReceiptJpeg(document.createElement("div"), { geometry: geometry(203, 300) });
    expect(toCanvas.mock.calls[0][1]).toMatchObject({ canvasWidth: 576, canvasHeight: 500, pixelRatio: 1 });
  });

  it("can lay out explicit ESC/POS raster geometry without inventing physical paper media", async () => {
    const profile: Record<string, unknown> = geometry();
    delete profile.paper_width_mm;
    profile.raster_command = "gs_v_0";
    await renderGatewayReceiptJpeg(document.createElement("div"), { geometry: profile });
    expect(toCanvas.mock.calls[0][1].canvasWidth).toBe(576);
    expect(profile).not.toHaveProperty("paper_width_mm");
  });

  it("rejects excessive output height before html-to-image can shrink its width", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(3000);
    await expect(renderGatewayReceiptJpeg(document.createElement("div"), { geometry: geometry(600, 600, 1702) }))
      .rejects.toMatchObject({ code: "POS_RECEIPT_GEOMETRY" });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("rejects a renderer that silently changes the requested raster dimensions", async () => {
    toCanvas.mockResolvedValue({ width: 300, height: 600, getContext: () => ({ fillRect() {} }), toDataURL: () => "data:image/jpeg;base64,CLIPPED" });
    await expect(renderGatewayReceiptJpeg(document.createElement("div"), { geometry: geometry() }))
      .rejects.toMatchObject({ code: "POS_RECEIPT_GEOMETRY" });
  });

  it("rejects timed-out image loading before encoding a receipt with missing QR or logos", async () => {
    waitImages.mockResolvedValueOnce({ timedOut: true });
    await expect(renderGatewayReceiptJpeg(document.createElement("div"), { geometry: geometry() }))
      .rejects.toMatchObject({ code: "POS_RECEIPT_GEOMETRY" });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("rejects a failed receipt image even when the loader has settled", async () => {
    const node = document.createElement("div");
    node.appendChild(document.createElement("img"));
    await expect(renderGatewayReceiptJpeg(node, { geometry: geometry() }))
      .rejects.toMatchObject({ code: "POS_RECEIPT_GEOMETRY" });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("rejects a canvas export failure before passing malformed image data to Odoo", async () => {
    toCanvas.mockImplementation(async (_node, options) => ({
      width: options.canvasWidth, height: options.canvasHeight,
      getContext: () => ({ fillRect() {} }), toDataURL: () => "data:,",
    }));
    await expect(renderGatewayReceiptJpeg(document.createElement("div"), { geometry: geometry() }))
      .rejects.toMatchObject({ code: "POS_RECEIPT_GEOMETRY" });
  });
});
