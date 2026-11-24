/** @odoo-module */

/**
 * Exact native/Gateway printer identity: UTF-8 bytes, never JS UTF-16 units.
 * encodeURIComponent rejects lone surrogates (TextEncoder replaces them).
 * Every %XX escape represents one encoded byte; ordinary ASCII is one byte.
 */
export function isExactRuntimePrinterId(value) {
    if (typeof value !== "string" || !value || value !== value.trim() ||
        value.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
    try {
        const utf8 = encodeURIComponent(value);
        return utf8.replace(/%[0-9a-fA-F]{2}/g, "x").length <= 120;
    } catch {
        return false;
    }
}

// Mirrors the shared geometry v1 contract, without coercion or invented
// measurements. Receipt typography additionally needs both DPIs; the driver
// PDF consumer separately requires physical paper media.
export function validatedPrinterGeometry(value, printerId = null, fingerprint = null) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
    const validation = { windows_driver: "observed", ipp: "observed", validated_profile: "configured" };
    if (!Object.hasOwn(validation, value.source) || value.validation !== validation[value.source]) return null;
    if (!isExactRuntimePrinterId(value.printer_id) ||
        (printerId !== null && value.printer_id !== printerId)) return null;
    if (typeof value.config_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.config_fingerprint) ||
        (fingerprint !== null && value.config_fingerprint !== fingerprint)) return null;
    if (typeof value.observed_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value.observed_at) ||
        !Number.isFinite(Date.parse(value.observed_at))) return null;
    // Date.parse normalizes impossible dates in some browsers.
    if (new Date(value.observed_at).toISOString().slice(0, 19) !== value.observed_at.slice(0, 19)) return null;
    const integerFields = {
        printable_width_dots: [1, 16384], printable_height_dots: [1, 1000000],
        dpi_x: [1, 9600], dpi_y: [1, 9600], offset_x_dots: [0, 1000000], offset_y_dots: [0, 1000000],
    };
    const allowedKeys = new Set([...Object.keys(integerFields), "version", "source", "validation", "observed_at",
        "printer_id", "config_fingerprint", "paper_width_mm", "paper_height_mm", "raster_command"]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
    const result = Object.fromEntries(["version", "source", "validation", "observed_at", "printer_id", "config_fingerprint"]
        .map((key) => [key, value[key]]));
    for (const [key, [minimum, maximum]] of Object.entries(integerFields)) {
        if (Object.hasOwn(value, key)) {
            if (!Number.isInteger(value[key]) || value[key] < minimum || value[key] > maximum) return null;
            result[key] = value[key];
        }
    }
    for (const key of ["paper_width_mm", "paper_height_mm"]) {
        if (Object.hasOwn(value, key)) {
            if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0 || value[key] > 10000) return null;
            result[key] = value[key];
        }
    }
    if (!Object.hasOwn(result, "printable_width_dots")) return null;
    if (Object.hasOwn(value, "raster_command")) {
        if (value.raster_command !== "gs_v_0") return null;
        result.raster_command = value.raster_command;
    }
    for (const [size, dpi, printable, offset] of [
        ["paper_width_mm", "dpi_x", "printable_width_dots", "offset_x_dots"],
        ["paper_height_mm", "dpi_y", "printable_height_dots", "offset_y_dots"],
    ]) {
        if ([size, dpi, printable].every((key) => Object.hasOwn(result, key)) &&
            result[printable] + (result[offset] || 0) > result[size] * result[dpi] / 25.4 + 1) return null;
    }
    return result;
}

export function validatedReceiptGeometry(value, printerId = null) {
    const geometry = validatedPrinterGeometry(value, printerId);
    return geometry && ["dpi_x", "dpi_y"].every((key) => Object.hasOwn(geometry, key)) ? geometry : null;
}

