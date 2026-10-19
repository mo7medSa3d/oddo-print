// @vitest-environment jsdom
/**
 * POS receipt rendering must not depend on remote web fonts.
 *
 * Root cause of the historical console 404s (NotoSansArabic/Hebrew-RegIta.woff2
 * on fonts.odoocdn.com): Odoo's `render_service.htmlToCanvas` calls
 * `html-to-image`'s `toCanvas`, whose `embedWebFonts` scans EVERY `@font-face`
 * rule in the POS document — including Odoo's Noto POS-UI fonts, whose italic
 * variants were removed from the CDN — and fetches them eagerly. The receipt
 * template itself declares no custom font (it uses Bootstrap classes), so it
 * never needed those fonts. The 404 was non-fatal: `html-to-image`'s
 * `resourceToDataURL` catches the fetch failure, substitutes an empty data URL,
 * and continues rendering.
 *
 * These tests lock the functional outcome — receipt -> image -> valid payload —
 * and prove the pipeline degrades gracefully when a renderer step fails (the
 * meaningful failure mode: a future where font embedding becomes fatal). They
 * do NOT assert "no console 404"; they assert a valid JPEG payload is still
 * produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { htmlToCanvas, renderToElement, toCanvas } from "./__mocks__/odoo";
// @ts-expect-error - the JS module under test has no type declarations; its Odoo
// dependencies resolve to the shared mock module via vitest aliases.
import { renderReceiptImage } from "../odoo_addons/print_gateway/static/src/js/pos_print_router";

function makeCanvas(): HTMLCanvasElement {
  return {
    width: 100,
    height: 100,
    getContext: () => ({
      globalCompositeOperation: "",
      fillStyle: "",
      fillRect: vi.fn(),
    }),
    toDataURL: () => "data:image/jpeg;base64,VALIDJPEG",
  } as unknown as HTMLCanvasElement;
}

function makePos(renderer: unknown): never {
  return {
    env: { services: { renderer } },
    formatCurrency: (n: unknown) => String(n),
  } as never;
}

function makeOrder(): never {
  return { export_for_printing: () => ({}) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  toCanvas.mockResolvedValue(makeCanvas());
  // jsdom has no CSS layout engine, so provide a simulated 512px receipt
  // while retaining real DOM mount/unmount behavior for the capture tests.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const width = Number.parseInt(this.style.width, 10) || 512;
      return { width, height: 160, x: 0, y: 0, top: 0, left: 0,
        right: width, bottom: 160, toJSON: () => ({}) };
    });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get")
    .mockImplementation(function (this: HTMLElement) {
      return Number.parseInt(this.style.width, 10) || 512;
    });
});
afterEach(() => vi.restoreAllMocks());

describe("renderReceiptImage — POS receipt font 404 resilience", () => {
  it("never bypasses paper-width validation when only legacy renderer.toJpeg exists", async () => {
    const renderer = { toJpeg: vi.fn().mockResolvedValue("UNMEASURED_IMAGE") };
    renderToElement.mockReturnValue(document.createElement("div"));
    const result = await renderReceiptImage(makePos(renderer), makeOrder(), false, 384);
    expect(result).toBe("VALIDJPEG");
    expect(renderer.toJpeg).not.toHaveBeenCalled();
    expect(toCanvas.mock.calls[0][0].style.width).toBe("384px");
  });

  it("prefers the no-fonts path and never touches renderer.toJpeg on success", async () => {
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn(),
      toCanvas: vi.fn(),
    };
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
    expect(renderer.toHtml).toHaveBeenCalledTimes(1);
    expect(renderer.toJpeg).not.toHaveBeenCalled();
    expect(renderer.toCanvas).not.toHaveBeenCalled();
    expect(toCanvas).toHaveBeenCalledTimes(1);
    expect(toCanvas.mock.calls[0][1]).toMatchObject({ skipFonts: true });
    // Capture must be mounted and measured before rasterization: unlike
    // renderer.toHtml's disappearing node, our host is always in the DOM.
    expect(htmlToCanvas).not.toHaveBeenCalled();
  });

  it("issues zero remote font requests on the primary path", async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      throw new Error("network disabled in test");
    });
    try {
      const renderer = { toHtml: vi.fn().mockResolvedValue(document.createElement("div")) };
      const result = await renderReceiptImage(makePos(renderer), makeOrder());
      expect(result).toBe("VALIDJPEG");
      expect(seen.filter((u) => u.includes("fonts.odoocdn.com"))).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("renders Arabic content through the no-fonts path", async () => {
    const renderer = { toHtml: vi.fn().mockResolvedValue(document.createElement("div")) };
    const order = { export_for_printing: () => ({ lines: [{ productName: "قهوة عربية" }] }) } as never;
    const result = await renderReceiptImage(makePos(renderer), order);
    expect(result).toBe("VALIDJPEG");
    const props = renderer.toHtml.mock.calls[0][1] as { order: typeof order; basic_receipt: boolean };
    expect(props.order).toBe(order);
    expect(Object.keys(props).sort()).toEqual(["basic_receipt", "order"]);
    expect((props.order as unknown as { export_for_printing(): { lines: Array<{ productName: string }> } }).export_for_printing().lines[0].productName).toBe("قهوة عربية");
    expect(toCanvas.mock.calls[0][1]).toMatchObject({ skipFonts: true });
  });

  it("retries through the same mounted width-checked renderer after a transient failure", async () => {
    toCanvas.mockRejectedValueOnce(new Error("temporary raster error"));
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn().mockResolvedValue("UNMEASURED_IMAGE"),
      toCanvas: vi.fn().mockResolvedValue(makeCanvas()),
    };
    const result = await renderReceiptImage(makePos(renderer), makeOrder(), false, 384);
    expect(result).toBe("VALIDJPEG");
    expect(renderer.toHtml).toHaveBeenCalledTimes(2);
    expect(renderer.toJpeg).not.toHaveBeenCalled();
    expect(renderer.toCanvas).not.toHaveBeenCalled();
    expect(toCanvas).toHaveBeenCalledTimes(2);
    expect(toCanvas.mock.calls[1][0].style.width).toBe("384px");
  });

  it("uses a mounted template after both toHtml render attempts fail", async () => {
    toCanvas.mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("unavailable"));
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn().mockResolvedValue("UNMEASURED_IMAGE"),
      toCanvas: vi.fn().mockResolvedValue(makeCanvas()),
    };
    renderToElement.mockReturnValue(document.createElement("div"));
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
    expect(renderer.toJpeg).not.toHaveBeenCalled();
    expect(renderer.toCanvas).not.toHaveBeenCalled();
    expect(toCanvas).toHaveBeenCalledTimes(3);
  });

  it("renders the direct template when every toHtml attempt fails", async () => {
    const renderer = { toHtml: vi.fn().mockRejectedValue(new Error("renderer unavailable")) };
    renderToElement.mockReturnValue(document.createElement("div"));
    expect(await renderReceiptImage(makePos(renderer), makeOrder())).toBe("VALIDJPEG");
    expect(renderer.toHtml).toHaveBeenCalledTimes(2);
    expect(toCanvas).toHaveBeenCalledTimes(1);
  });

  it("uses a custom hardware width when available and safely falls back for invalid widths", async () => {
    const renderer = { toHtml: vi.fn().mockResolvedValue(document.createElement("div")) };
    await renderReceiptImage(makePos(renderer), makeOrder(), false, 384);
    expect(toCanvas.mock.calls[0][0].style.width).toBe("384px");
    toCanvas.mockClear();
    await renderReceiptImage(makePos(renderer), makeOrder(), false, 10000);
    expect(toCanvas.mock.calls[0][0].style.width).toBe("512px");
  });

  it("refuses an overflowing receipt instead of falling back to a clipped job", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn().mockResolvedValue("LEGACY_CLIPPED_IMAGE"),
    };
    await expect(renderReceiptImage(makePos(renderer), makeOrder()))
      .rejects.toThrow(/wider than the paper/);
    expect(renderer.toJpeg).not.toHaveBeenCalled();
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("a verified first-attempt paper overflow is terminal, not re-rendered with unbounded helpers", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(999);
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn().mockResolvedValue("CLIPPED"),
      toCanvas: vi.fn().mockResolvedValue(makeCanvas()),
    };
    await expect(renderReceiptImage(makePos(renderer), makeOrder(), false, 384))
      .rejects.toThrow(/wider than the paper/);
    expect(renderer.toHtml).toHaveBeenCalledTimes(1);
    expect(renderer.toJpeg).not.toHaveBeenCalled();
    expect(renderer.toCanvas).not.toHaveBeenCalled();
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("never rasterizes a detached DOM node", async () => {
    toCanvas.mockImplementation(async (node: HTMLElement) => {
      expect(node.isConnected).toBe(true);
      expect(node.classList.contains("yaseir-gateway-receipt")).toBe(true);
      return makeCanvas();
    });
    const renderer = { toHtml: vi.fn().mockResolvedValue(document.createElement("div")) };
    await renderReceiptImage(makePos(renderer), makeOrder());
    expect(document.querySelector(".yaseir-gateway-receipt")).toBeNull();
  });
});

describe("renderReceiptImage — no-fonts static contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "odoo_addons/print_gateway/static/src/js/pos_print_router.js"),
    "utf8",
  );

  it("rasterizes through the vendored build with web-font embedding disabled", () => {
    // Odoo's render_service.htmlToCanvas drops every option except addClass,
    // so skipFonts must reach html-to-image via a direct call.
    const helper = readFileSync(resolve(process.cwd(), "odoo_addons/print_gateway/static/src/js/receipt_raster.js"), "utf8");
    expect(source).toContain('from "./receipt_raster"');
    expect(helper).toContain('from "@point_of_sale/app/utils/html-to-image"');
    expect(helper).toContain("skipFonts: true");
    expect(helper).toContain("renderer.whenMounted");
    expect(helper).toContain("node.scrollWidth");
    const css = readFileSync(resolve(process.cwd(), "odoo_addons/print_gateway/static/src/css/receipt_raster.css"), "utf8");
    expect(css).toContain(".pos-receipt-amount");
    expect(css).toContain(".pos-receipt-qr");
    expect(css).toContain("flex-wrap: nowrap");
  });

  it("never caches POS receipt geometry by POS config across different printers", () => {
    const source = readFileSync(
      resolve(process.cwd(), "odoo_addons/print_gateway/static/src/js/pos_print_router.js"),
      "utf8",
    );
    const start = source.indexOf("async function gatewayReceiptRasterWidth(");
    const end = source.indexOf("patch(PosStore.prototype", start);
    expect(start).toBeGreaterThan(0);
    const lookup = source.slice(start, end);
    expect(lookup).toContain('"get_gateway_receipt_raster_width"');
    expect(lookup).toContain("[[orderId]]");
    expect(lookup).not.toContain("gatewayReceiptRasterWidths");
    expect(lookup).not.toContain("cache.set(");
    expect(lookup).not.toContain("5 * 60 * 1000");
  });

  it("never bypasses measured paper geometry through unbounded fallback helpers", () => {
    expect(source).not.toContain("renderer.toJpeg");
    expect(source).not.toContain("renderer.toCanvas");
    expect(source).toContain("renderer.toHtml");
    expect(source).toContain("renderToElement");
    expect(source).toContain('if (err?.code === "POS_RECEIPT_GEOMETRY")');
  });
});
