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
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  htmlToCanvas: vi.fn(),
  renderToElement: vi.fn(),
  patch: vi.fn(),
  showGatewayBillingLimitDialog: vi.fn(),
  changesToOrder: vi.fn(),
}));

vi.mock("@point_of_sale/app/services/render_service", () => ({
  htmlToCanvas: mocks.htmlToCanvas,
}), { virtual: true };
vi.mock("@web/core/utils/render", () => ({
  renderToElement: mocks.renderToElement,
}), { virtual: true };
vi.mock("@point_of_sale/app/screens/receipt_screen/receipt/order_receipt", () => ({
  OrderReceipt: "OrderReceipt",
}), { virtual: true };
vi.mock("@web/core/utils/patch", () => ({ patch: mocks.patch }), { virtual: true };
vi.mock("@point_of_sale/app/services/pos_store", () => ({ PosStore: class {} }), { virtual: true };
vi.mock("@point_of_sale/app/models/utils/order_change", () => ({
  changesToOrder: mocks.changesToOrder,
}), { virtual: true };
vi.mock("@point_of_sale/app/components/popups/retry_print_popup/retry_print_popup", () => ({
  RetryPrintPopup: "RetryPrintPopup",
}), { virtual: true };
vi.mock("../odoo_addons/print_gateway/static/src/js/gateway_limit_dialog", () => ({
  showGatewayBillingLimitDialog: mocks.showGatewayBillingLimitDialog,
}));

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

describe("renderReceiptImage — POS receipt font 404 resilience", () => {
  it("returns a valid JPEG payload when renderer.toJpeg succeeds", async () => {
    const renderer = { toJpeg: vi.fn().mockResolvedValue("VALIDJPEG") };
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
  });

  it("falls back to toCanvas when toJpeg fails (e.g. a font embed failure)", async () => {
    const renderer = {
      toJpeg: vi.fn().mockRejectedValue(new Error("Failed to fetch resource: font 404")),
      toCanvas: vi.fn().mockResolvedValue(makeCanvas()),
    };
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
  });

  it("falls back to toHtml when toJpeg and toCanvas fail", async () => {
    const renderer = {
      toJpeg: vi.fn().mockRejectedValue(new Error("fail")),
      toCanvas: vi.fn().mockRejectedValue(new Error("fail")),
      toHtml: vi.fn().mockResolvedValue(document.createElement("div")),
    };
    mocks.htmlToCanvas.mockResolvedValue(makeCanvas());
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
  });

  it("falls back to renderToElement when every renderer method fails", async () => {
    const renderer = {
      toJpeg: vi.fn().mockRejectedValue(new Error("fail")),
      toCanvas: vi.fn().mockRejectedValue(new Error("fail")),
      toHtml: vi.fn().mockRejectedValue(new Error("fail")),
    };
    mocks.renderToElement.mockReturnValue(document.createElement("div"));
    mocks.htmlToCanvas.mockResolvedValue(makeCanvas());
    const result = await renderReceiptImage(makePos(renderer), makeOrder());
    expect(result).toBe("VALIDJPEG");
  });
});
