// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { patch } from "./__mocks__/odoo";
import "../odoo_addons/print_gateway/static/src/js/pos_print_router";

type Outcome = { successful: boolean; gatewayOutcome?: string; canRetry?: boolean };
const methods = patch.mock.calls.at(-1)?.[1] as { printChanges: (this: unknown, order: unknown, changes: unknown[], reprint?: boolean, printers?: unknown) => Promise<boolean> };
function fixture(outcome: Outcome) {
  const printers = [{ id: 1, config: { name: "Kitchen A" } }, { id: 2, config: { name: "Kitchen B" } }];
  const order = { id: 21, isSynced: true, uiState: { lastPrints: [] as unknown[] } };
  const pos = {
    session: { id: 5 }, unwatched: { printers }, models: {},
    data: { call: vi.fn(async (_model: string, method: string) => method === "is_gateway_printing_enabled" ? true : { routes: printers.map((p) => ({ pos_printer_id: p.id, category_ids: [1] })), missing_routes: [] }) },
    notification: { add: vi.fn() }, dialog: { add: vi.fn() },
    syncAllOrders: vi.fn(), displayPrinterWarning: vi.fn(),
    generateOrderChange: vi.fn(() => ({ orderData: { __gateway_print_id: "operation" }, changes: {} })),
    generateReceiptsDataToPrint: vi.fn(async () => [{ orderData: { __gateway_print_id: "operation" } }]),
    printOrderChanges: vi.fn(async (_data: unknown, _printer: unknown, id: number) => id === 1 ? { successful: true } : outcome),
  };
  return { pos, order };
}
beforeEach(() => vi.clearAllMocks());
describe("kitchen completion and replay safety", () => {
  it("keeps a partially accepted change unconsumed and never resends accepted or unknown tickets", async () => {
    const { pos, order } = fixture({ successful: false, gatewayOutcome: "unknown", canRetry: false });
    expect(await methods.printChanges.call(pos, order, [{ new: [] }])).toBe(false);
    expect(order.uiState.lastPrints).toHaveLength(0);
    expect(pos.dialog.add).not.toHaveBeenCalled();
    expect(pos.printOrderChanges).toHaveBeenCalledTimes(2);
    expect(await methods.printChanges.call(pos, order, [{ new: [] }])).toBe(false);
    expect(pos.printOrderChanges).toHaveBeenCalledTimes(2);
  });
  it("does not offer automatic retry for a definitive plan refusal", async () => {
    const { pos, order } = fixture({ successful: false, canRetry: false });
    expect(await methods.printChanges.call(pos, order, [{ new: [] }])).toBe(false);
    expect(pos.dialog.add).not.toHaveBeenCalled();
  });
  it("completes only when every attempted station accepts", async () => {
    const { pos, order } = fixture({ successful: true });
    expect(await methods.printChanges.call(pos, order, [{ new: [] }])).toBe(true);
    expect(order.uiState.lastPrints).toHaveLength(1);
  });
  it("catches the activation RPC failure without calling hardware", async () => {
    const { pos, order } = fixture({ successful: true });
    pos.data.call.mockRejectedValueOnce(new Error("Odoo is unreachable"));
    expect(await methods.printChanges.call(pos, order, [{ new: [] }])).toBe(false);
    expect(pos.printOrderChanges).not.toHaveBeenCalled();
    expect(pos.notification.add).toHaveBeenCalled();
  });
});
