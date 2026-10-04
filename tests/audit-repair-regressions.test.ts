import { describe, expect, it } from "vitest";
import { codeMessageKey } from "../src/lib/api-error-keys";
import { isVirtualPrinterRecord } from "../src/lib/printer-virtual";
import { stripeSubscriptionPeriod } from "../src/lib/stripe";

describe("audit repair regressions", () => {
  it("rejects inherited error-code properties while resolving known codes", () => {
    for (const code of ["constructor", "toString", "__proto__"]) expect(codeMessageKey(code)).toBeNull();
    expect(codeMessageKey("PRINTER_NOT_FOUND")).toBe("errors.printerNotFound");
  });
  it("keeps physical Enhanced Point and Print queues selectable", () => {
    expect(isVirtualPrinterRecord({ name: "Office", connectionType: "spooler", protocol: "spooler", driverName: "Microsoft enhanced point and print compatibility driver", port: "\\\\server\\queue" })).toBe(false);
    expect(isVirtualPrinterRecord({ name: "Office", driverName: "Microsoft Print to PDF", port: "PORTPROMPT:" })).toBe(true);
  });
  it("normalizes Basil item periods and keeps legacy subscriptions compatible", () => {
    const first = 1_700_000_000, last = first + 2_592_000;
    const modern = stripeSubscriptionPeriod({ items: { data: [{ current_period_start: first, current_period_end: last }] } });
    const legacy = stripeSubscriptionPeriod({ current_period_start: first, current_period_end: last });
    expect(modern).toEqual(legacy);
    expect(modern.start?.getTime()).toBe(first * 1000);
    expect(modern.end?.getTime()).toBe(last * 1000);
    expect(stripeSubscriptionPeriod({ current_period_start: NaN, current_period_end: -1 })).toEqual({ start: null, end: null });
  });
});
