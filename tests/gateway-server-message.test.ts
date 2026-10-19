import { describe, expect, it } from "vitest";
// @ts-expect-error - addon JS has no type declarations; @web/* resolves to the shared mock module.
import { gatewayServerMessage } from "../odoo_addons/print_gateway/static/src/js/gateway_limit_dialog";

/**
 * POS must surface the server-side message, not the generic RPC title.
 * Odoo serializes server exceptions into an RPCError whose `.message` is the
 * fixed string "Odoo Server Error"; the real text lives in `data.message`.
 * Reading only `error.message` turned every deterministic printer failure
 * (e.g. PRINTER_OFFLINE ValidationError) into a generic server-error alert.
 */
describe("gatewayServerMessage", () => {
  it("prefers the server message over the generic RPC title", () => {
    expect(
      gatewayServerMessage({
        message: "Odoo Server Error",
        data: { message: "Printer 'printer_sp' is offline or unavailable (PRINTER_OFFLINE). The receipt was not sent." },
      })
    ).toBe("Printer 'printer_sp' is offline or unavailable (PRINTER_OFFLINE). The receipt was not sent.");
  });

  it("falls back to string arguments when data.message is absent", () => {
    expect(
      gatewayServerMessage({ message: "Odoo Server Error", data: { arguments: ["Printer X is offline."] } })
    ).toBe("Printer X is offline.");
  });

  it("keeps genuine local Error messages intact", () => {
    expect(gatewayServerMessage(new Error("No receipt element to rasterize"))).toBe(
      "No receipt element to rasterize"
    );
  });

  it("never returns the generic title itself", () => {
    expect(gatewayServerMessage({ message: "Odoo Server Error", data: {} })).toBe("");
    expect(gatewayServerMessage({ message: "Odoo Server Error" })).toBe("");
  });

  it("handles string and empty inputs without throwing", () => {
    expect(gatewayServerMessage("Printer X is offline.")).toBe("Printer X is offline.");
    expect(gatewayServerMessage(null)).toBe("");
    expect(gatewayServerMessage(undefined)).toBe("");
  });
});
