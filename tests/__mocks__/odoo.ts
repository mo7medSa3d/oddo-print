/**
 * Shared Odoo module mocks for POS receipt rendering tests.
 *
 * The Yasser addon's pos_print_router.js imports Odoo POS modules
 * (@point_of_sale/*, @web/*) that are not installed in this repository.
 * Vitest aliases (see vitest.unit.config.mts) resolve every such import to
 * this single mock module so the real renderReceiptImage() can be driven in
 * isolation. The vi.fn() exports are shared singletons: the test imports the
 * same instances the module under test uses, so mockResolvedValue() calls
 * made in the test are observed by pos_print_router.js.
 */
import { vi } from "vitest";

export const PosStore = class {};
export const patch = vi.fn();
export const changesToOrder = vi.fn();
export const htmlToCanvas = vi.fn();
export const renderToElement = vi.fn();
// Direct vendored html-to-image entry (imported by pos_print_router.js from
// "@point_of_sale/app/utils/html-to-image", resolved here by the alias above)
// and the image-readiness helper (from "@point_of_sale/utils").
export const toCanvas = vi.fn();
export const waitImages = vi.fn().mockResolvedValue({ timedOut: false });
export const OrderReceipt = "OrderReceipt";
export const RetryPrintPopup = "RetryPrintPopup";
// gateway_limit_dialog.js (imported by pos_print_router.js) uses the Odoo
// translation helper and the confirmation dialog component.
export const _t = (s: string) => s;
export const ConfirmationDialog = "ConfirmationDialog";
