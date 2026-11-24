/** @odoo-module */

import { isExactRuntimePrinterId } from "./printer_geometry";

const methodIdentityStrength = Object.freeze({
    windows_queue: "queue",
    ipp_attributes: "service",
    usb_interface: "device",
    snmp_printer: "device",
});

function utcTime(value) {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : null;
}

export function validatedOperationalVerification(value, printer, now = Date.now()) {
    const required = ["version", "verified_at", "printer_id", "binding_digest", "logical_queue_key", "method", "identity_strength", "output_medium"];
    const allowed = new Set([...required, "physical_device_key"]);
    if (!value || typeof value !== "object" || Array.isArray(value) || !printer ||
        required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key)) || value.version !== 1) return null;
    if (!isExactRuntimePrinterId(value.printer_id) || value.printer_id !== printer.id) return null;
    const hex = /^[0-9a-f]{64}$/;
    if (typeof value.binding_digest !== "string" || !hex.test(value.binding_digest) || value.logical_queue_key !== value.binding_digest ||
        !["queue", "service", "device"].includes(value.identity_strength) ||
        (Object.hasOwn(value, "physical_device_key") && (value.identity_strength !== "device" || typeof value.physical_device_key !== "string" || !hex.test(value.physical_device_key)))) return null;
    const connection = String(printer.connectionType || "").trim().toLowerCase();
    const protocol = String(printer.protocol || "").trim().toLowerCase();
    const method = connection === "spooler" && ["spooler", "windows_spooler"].includes(protocol) ? "windows_queue"
        : ["ipp", "ipps"].includes(connection) || connection === "network" && ["ipp", "ipps"].includes(protocol) ? "ipp_attributes"
        : ["network", "usb"].includes(connection) && ["raw", "escpos", "zpl", "tspl"].includes(protocol)
            ? connection === "usb" ? "usb_interface" : "snmp_printer" : null;
    // Method-specific identity strength must match native Go and Gateway:
    // an IPP service or spooler queue cannot claim chassis/device evidence.
    if (!method || value.method !== method ||
        value.identity_strength !== methodIdentityStrength[method] ||
        (Object.hasOwn(value, "physical_device_key") && methodIdentityStrength[method] !== "device") ||
        value.output_medium !== "physical") return null;
    const verified = utcTime(value.verified_at);
    const age = now - verified;
    if (verified === null || !Number.isFinite(age) || age > 300000 || age < -60000) return null;
    return { ...value };
}

export function isVerifiedRuntimePrinter(printer, now = Date.now()) {
    if (!printer || printer.verificationState !== "verified") return false;
    const proof = validatedOperationalVerification(printer.capabilities?.operational_verification, printer, now);
    if (!proof || printer.outputMedium !== proof.output_medium) return false;
    const verified = utcTime(printer.verificationVerifiedAt);
    const received = utcTime(printer.verificationReceivedAt);
    return verified === utcTime(proof.verified_at) && received !== null && now - received >= 0 && now - received <= 300000;
}
