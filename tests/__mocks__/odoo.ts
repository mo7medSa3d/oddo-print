/**
 * Shared Odoo module mocks for POS receipt rendering tests.
 *
 * The Yasser addon's pos_print_router.js imports Odoo POS modules
 * (@point_of_sale/*, @web/*) that are not installed in this repository.
 * Vitest aliases resolve those imports to this mock module so the real
 * renderReceiptImage() can be driven in isolation.
 */
import { vi } from "vitest";

export const PosStore = class {};
export const patch = vi.fn();
export const changesToOrder = vi.fn();
export const htmlToCanvas = vi.fn();
export const renderToElement = vi.fn();
export const OrderReceipt = "OrderReceipt";
export const RetryPrintPopup = "RetryPrintPopup";
export const _t = (s: string) => s;
export const ConfirmationDialog = "ConfirmationDialog";
