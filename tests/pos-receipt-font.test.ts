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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { htmlToCanvas, renderToElement, toCanvas, waitImages } from "./__mocks__/odoo";
// No @ts-expect-error here: this branch ships pos_print_router.d.ts next to
// the JS module under test, so the import is typed (main has no .d.ts and
// keeps the suppression there). Odoo dependencies resolve via vitest aliases.
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
  // Default: the direct vendored rasterization succeeds (each test overrides
  // with rejections to drive a specific fallback leg).
  toCanvas.mockResolvedValue(makeCanvas());
});

describe("renderReceiptImage — POS receipt font 404 resilience", () => {
  it("returns a valid JPEG payload when renderer.toJpeg succeeds", async () => {
    const renderer = { toJpeg: vi.fn().mockResolvedValue("VALIDJPEG") };
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
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
    // The render_service wrapper (whose fixed options drop skipFonts) is
    // bypassed on the primary path.
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
    const props = renderer.toHtml.mock.calls[0][1] as { data: { lines: Array<{ productName: string }> } };
    expect(props.data.lines[0].productName).toBe("قهوة عربية");
    expect(toCanvas.mock.calls[0][1]).toMatchObject({ skipFonts: true });
  });

  it("falls back to renderer.toJpeg when the no-fonts rasterization fails", async () => {
    toCanvas.mockRejectedValueOnce(new Error("rasterize failed"));
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn().mockResolvedValue("VALIDJPEG"),
    };
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
    expect(renderer.toJpeg).toHaveBeenCalledTimes(1);
  });

  it("falls back to toCanvas when toJpeg fails (e.g. a font embed failure)", async () => {
    toCanvas.mockRejectedValueOnce(new Error("rasterize failed"));
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn().mockRejectedValue(new Error("Failed to fetch resource: font 404")),
      toCanvas: vi.fn().mockResolvedValue(makeCanvas()),
    };
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
  });

  it("falls back to render_service htmlToCanvas when toJpeg and toCanvas fail", async () => {
    toCanvas.mockRejectedValueOnce(new Error("fail"));
    const renderer = {
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
      toJpeg: vi.fn().mockRejectedValue(new Error("fail")),
      toCanvas: vi.fn().mockRejectedValue(new Error("fail")),
    };
    htmlToCanvas.mockResolvedValue(makeCanvas());
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
    expect(htmlToCanvas).toHaveBeenCalledTimes(1);
  });

  it("falls back to renderToElement when every renderer method fails", async () => {
    const renderer = {
      toJpeg: vi.fn().mockRejectedValue(new Error("fail")),
      toCanvas: vi.fn().mockRejectedValue(new Error("fail")),
      toHtml: vi.fn().mockRejectedValue(new Error("fail")),
    };
    renderToElement.mockReturnValue(document.createElement("div"));
    htmlToCanvas.mockResolvedValue(makeCanvas());
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
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
    expect(source).toContain('from "@point_of_sale/app/utils/html-to-image"');
    expect(source).toContain("skipFonts: true");
  });

  it("keeps the full fallback chain for resilience", () => {
    expect(source).toContain("renderer.toJpeg");
    expect(source).toContain("renderer.toCanvas");
    expect(source).toContain("renderer.toHtml");
    expect(source).toContain("renderToElement");
  });
});
