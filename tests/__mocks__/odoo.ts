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
export const OrderReceipt = "OrderReceipt";
export const RetryPrintPopup = "RetryPrintPopup";
