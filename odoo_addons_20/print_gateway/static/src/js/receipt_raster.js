/** @odoo-module */

import { toCanvas } from "@point_of_sale/app/utils/html-to-image";
import { waitImages } from "@point_of_sale/utils";
import { _t } from "@web/core/l10n/translation";
import { validatedReceiptGeometry } from "./printer_geometry";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const MAX_RECEIPT_JPEG_B64_LENGTH = 4 * Math.ceil(5 * 1024 * 1024 / 3);

function geometryError(message) {
    const error = new Error(message);
    error.code = "POS_RECEIPT_GEOMETRY";
    return error;
}

function hasUnloadedImage(node) {
    for (const image of node.querySelectorAll("img")) {
        if (!image.complete || image.naturalWidth < 1) {
            return true;
        }
    }
    return false;
}

function captureJpeg(canvas) {
    // JPEG has no alpha. Composite black QR modules and text over white.
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // WP7-measured: JPEG quality 0.95 halves the mean gray error vs 0.90
    // (0.043 vs 0.098 on an anti-aliased receipt fixture) and eliminates
    // pixels deviating by more than 10 gray levels (0 vs 36), while growing
    // a 576x3600 receipt only from ~150 KB to ~178 KB — far under the
    // 5 MiB fail-closed cap. Quality 1.00 was measured too (mean error
    // 0.002) but rejected as the default: photo/logo-heavy receipts
    // balloon toward the cap for no visible gain on the 1-bit thermal
    // path (threshold 180 already absorbs q90 ringing) and none beyond
    // q95 on the grayscale PDF path. The Gateway contract requires a
    // JPEG signature for image payloads, so PNG is not an available
    // lossless alternative without a contract change.
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
        throw geometryError(_t("The receipt renderer could not encode a JPEG image. No print was sent."));
    }
    return dataUrl.slice(JPEG_DATA_URL_PREFIX.length);
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
export async function renderGatewayReceiptJpeg(element, { renderer, geometry } = {}) {
    if (!element || typeof document === "undefined") {
        throw new Error("A receipt DOM element is required for image printing.");
    }
    const measured = validatedReceiptGeometry(geometry);
    if (!measured) {
        throw geometryError(_t("The selected printer has no validated receipt geometry. Sync its driver measurements or configure a validated profile with printable width and horizontal and vertical DPI; driver printing also requires the actual paper width."));
    }
    // CSS uses 96 pixels per inch. On thermal receipt rolls, render at exact
    // printable_width_dots. On full-page office/PDF printers (e.g. Letter/A4
    // >= 140mm at 600 DPI where full page width is 5100+ dots), frame the POS
    // ticket at Odoo 20's native 512px receipt column width (3200 dots @ 600 DPI,
    // centered on the page by the Agent) so nothing clips/overflows horizontally
    // while keeping total raster pixels comfortably under the 40 MP safety cap.
    const fullRasterWidth = measured.printable_width_dots;
    const fullCssWidth = fullRasterWidth * 96 / measured.dpi_x;
    const isFullPageMedia = typeof measured.paper_width_mm === "number" && measured.paper_width_mm >= 140 && fullCssWidth > 512;
    const cssWidth = isFullPageMedia ? 512 : fullCssWidth;
    const rasterWidth = isFullPageMedia ? Math.min(fullRasterWidth, Math.round(cssWidth * measured.dpi_x / 96)) : fullRasterWidth;

    const captureMounted = async (node, iframe = null) => {
        const doc = node.ownerDocument || document;
        const inIframe = Boolean(iframe || doc !== document);
        const isNarrow = rasterWidth * 25.4 / measured.dpi_x < 60;
        let injectedStyle = null;
        if (inIframe) {
            if (iframe) {
                iframe.style.width = `${Math.ceil(cssWidth)}px`;
                iframe.style.height = "auto";
            }
            const head = node.querySelector?.("head") || doc.head;
            if (head) {
                const fontScale = isFullPageMedia ? 0.85 : (cssWidth < 512 ? Math.max(0.45, cssWidth / 512) : 1);
                const fontOverride = fontScale < 1 ? `
                    #pos-receipt .text-small { font-size: ${(18 * fontScale).toFixed(2)}px !important; line-height: ${(24 * fontScale).toFixed(2)}px !important; }
                    #pos-receipt .text-normal { font-size: ${(22 * fontScale).toFixed(2)}px !important; line-height: ${(28 * fontScale).toFixed(2)}px !important; }
                    #pos-receipt .text-large { font-size: ${(30 * fontScale).toFixed(2)}px !important; line-height: ${(36 * fontScale).toFixed(2)}px !important; }
                    #pos-receipt .text-huge { font-size: ${(45 * fontScale).toFixed(2)}px !important; line-height: ${(52 * fontScale).toFixed(2)}px !important; }
                    #pos-receipt .text-insane { font-size: ${(50 * fontScale).toFixed(2)}px !important; line-height: ${(58 * fontScale).toFixed(2)}px !important; }
                ` : "";
                const mediaConstrain = isFullPageMedia ? `
                    #pos-receipt [name="logo"] img { max-height: 75px !important; width: auto !important; }
                    #pos-receipt img { max-height: 150px !important; width: auto !important; object-fit: contain !important; }
                ` : "";
                injectedStyle = doc.createElement("style");
                injectedStyle.id = "yaseir-gateway-receipt-style";
                injectedStyle.textContent = `
                    #pos-receipt {
                        box-sizing: border-box !important;
                        width: ${cssWidth}px !important;
                        max-width: ${cssWidth}px !important;
                        min-width: 0 !important;
                        height: auto !important;
                        min-height: 0 !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        background: #ffffff !important;
                        color: #000000 !important;
                        overflow: visible !important;
                        overflow-wrap: anywhere !important;
                        word-break: break-word !important;
                        font-size: ${(22 * fontScale).toFixed(2)}px !important;
                        line-height: 1.35 !important;
                    }
                    #pos-receipt > body {
                        box-sizing: border-box !important;
                        margin: 0 !important;
                        padding: 4px 12px !important;
                        height: auto !important;
                        min-height: 0 !important;
                        width: 100% !important;
                        max-width: 100% !important;
                        overflow-wrap: anywhere !important;
                    }
                    #pos-receipt *, #pos-receipt *::before, #pos-receipt *::after {
                        box-sizing: border-box !important;
                        max-width: 100% !important;
                        overflow-wrap: anywhere !important;
                    }
                    #pos-receipt table {
                        table-layout: fixed !important;
                        border-collapse: collapse !important;
                        width: 100% !important;
                        max-width: 100% !important;
                    }
                    #pos-receipt td, #pos-receipt th {
                        word-break: break-word !important;
                        overflow-wrap: anywhere !important;
                    }
                    ${fontOverride}
                    ${mediaConstrain}
                `;
                head.appendChild(injectedStyle);
            }
        }
        node.classList.add("pos-receipt-print", "yaseir-gateway-receipt");
        node.classList.toggle("yaseir-gateway-receipt-narrow", isNarrow);
        node.style.setProperty("--yaseir-print-width", cssWidth + "px");
        node.style.setProperty("width", cssWidth + "px", "important");
        node.style.setProperty("max-width", cssWidth + "px", "important");
        node.style.setProperty("padding", "0", "important");
        node.style.setProperty("margin", "0", "important");

        try {
            // All images, including QR and logos, must finish loading before
            // measuring the *new* CSS layout and snapshotting SVG foreignObject.
            const imageState = await waitImages(node);
            if (imageState?.timedOut || hasUnloadedImage(node)) {
                throw geometryError(_t("A receipt image or code did not load. Wait for all images to load before printing; no print was sent."));
            }
            // Capture after the mounted element's used fonts have settled. The
            // canvas exporter intentionally skips font embedding, so measuring
            // before FontFaceSet.ready can freeze fallback-font line heights and
            // misplaced Arabic/Latin columns into the printed JPEG.
            if (doc.fonts?.ready) {
                await doc.fonts.ready;
            }
            const rect = node.getBoundingClientRect();
            const measuredWidth = rect.width;
            const measuredHeight = Math.ceil(inIframe ? Math.max(rect.height || 0, node.scrollHeight || 0) : node.scrollHeight);
            const rasterHeight = Math.ceil(measuredHeight * measured.dpi_y / 96);
            if (!Number.isFinite(measuredWidth) || measuredWidth <= 0 || Math.abs(measuredWidth - cssWidth) > 0.5 || measuredHeight < 1 ||
                !Number.isSafeInteger(rasterHeight) || rasterHeight > 16384 || rasterWidth * rasterHeight > 40000000) {
                throw geometryError(_t("POS receipt dimensions exceed the safe raster limits or do not match the selected printer. Split an oversized receipt or review its receipt CSS; no print was sent."));
            }
            // Avoid silent right-edge clipping (which can hide prices/QRs).
            if (node.scrollWidth > measuredWidth + 2) {
                throw geometryError(_t("POS receipt has content wider than the paper; review its receipt template."));
            }
            const canvas = await toCanvas(node, {
                backgroundColor: "#ffffff",
                width: cssWidth,
                height: measuredHeight,
                canvasWidth: rasterWidth,
                canvasHeight: rasterHeight,
                pixelRatio: 1,
                skipAutoScale: true,
                includeQueryParams: true,
                skipFonts: true,
            });
            try {
                if (canvas.width !== rasterWidth || canvas.height !== rasterHeight) {
                    throw geometryError(_t("The receipt renderer changed the printer's measured dimensions. No print was sent."));
                }
                const jpeg = captureJpeg(canvas);
                if (!jpeg || jpeg.length > MAX_RECEIPT_JPEG_B64_LENGTH) {
                    throw geometryError(_t("The receipt image exceeds the 5 MiB safety limit. Split the receipt before printing."));
                }
                return jpeg;
            } finally {
                canvas.width = 0;
                canvas.height = 0;
            }
        } finally {
            injectedStyle?.remove();
        }
    };

    if (element.isConnected && element.ownerDocument !== document) {
        const frame = element.ownerDocument?.defaultView?.frameElement || null;
        return captureMounted(element, frame);
    }
    if (renderer && typeof renderer.whenMounted === "function") {
        return renderer.whenMounted({ el: element, callback: (mounted) => captureMounted(mounted) });
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
