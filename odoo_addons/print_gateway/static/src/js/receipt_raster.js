/** @odoo-module */

import { toCanvas } from "@point_of_sale/app/utils/html-to-image";
import { waitImages } from "@point_of_sale/utils";

// The printer's usable dot width differs across 58/80mm and 180/203dpi
// models. 512px is Odoo 19's existing 80mm/180dpi default, NOT a universal
// hardware assumption. Optional per-device value must be vetted by Odoo.
export const DEFAULT_RECEIPT_RASTER_WIDTH = 512;
export function normalizedReceiptRasterWidth(value) {
    const width = Number(value);
    return Number.isInteger(width) && width >= 288 && width <= 576
        ? width : DEFAULT_RECEIPT_RASTER_WIDTH;
}

function captureJpeg(canvas) {
    // JPEG has no alpha. Composite black QR modules and text over white.
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL("image/jpeg", 0.90)
        .replace(/^data:image\/[a-z]+(?:;[^,]*)?;base64,/, "");
}

/**
 * Rasterize an Odoo receipt in a MOUNTED, fixed-width container.
 *
 * Odoo renderer.toHtml immediately schedules disposal of its source element.
 * Calling html-to-image on that detached element loses the POS styling and
 * sometimes measures auto-width/line heights using fallback metrics. This
 * is why the receipt's totals, item names and QR text can overlap in JPEG
 * even when the POS screen looks correct.
 *
 * Renderer.whenMounted clones into Odoo's normal render-container; if the
 * helper is unavailable, an isolated temporary DOM mount provides the same
 * layout precondition without leaving any visible nodes behind.
 */
export async function renderGatewayReceiptJpeg(element, { renderer, width } = {}) {
    if (!element || typeof document === "undefined") {
        throw new Error("A receipt DOM element is required for image printing.");
    }
    const rasterWidth = normalizedReceiptRasterWidth(width);

    const captureMounted = async (node) => {
        node.classList.add("pos-receipt-print", "yaseir-gateway-receipt");
        node.classList.toggle("yaseir-gateway-receipt-narrow", rasterWidth < 480);
        node.style.setProperty("--yaseir-print-width", rasterWidth + "px");
        node.style.width = rasterWidth + "px";

        // All images, including QR and logos, must finish loading before
        // measuring the *new* CSS layout and snapshotting SVG foreignObject.
        await waitImages(node);
        const measuredWidth = Math.ceil(node.getBoundingClientRect().width);
        const measuredHeight = Math.ceil(node.scrollHeight);
        if (measuredWidth !== rasterWidth || measuredHeight < 1 ||
            measuredHeight > 16384 || measuredWidth > 576) {
            const err = new Error("POS receipt dimensions are invalid; check custom receipt CSS.");
            err.code = "POS_RECEIPT_GEOMETRY";
            throw err;
        }
        // Avoid silent right-edge clipping (which can hide prices/QRs).
        if (node.scrollWidth > measuredWidth + 2) {
            const err = new Error("POS receipt has content wider than the paper; review its receipt template.");
            err.code = "POS_RECEIPT_GEOMETRY";
            throw err;
        }
        const canvas = await toCanvas(node, {
            backgroundColor: "#ffffff",
            width: measuredWidth,
            height: measuredHeight,
            pixelRatio: 1,
            includeQueryParams: true,
            skipFonts: true,
        });
        return captureJpeg(canvas);
    };

    if (renderer && typeof renderer.whenMounted === "function") {
        return renderer.whenMounted({ el: element, callback: captureMounted });
    }
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:-99999px;top:0;width:max-content;pointer-events:none;z-index:-1";
    const clone = element.cloneNode(true);
    host.appendChild(clone);
    document.body.appendChild(host);
    try {
        return await captureMounted(clone);
    } finally {
        host.remove();
    }
}
