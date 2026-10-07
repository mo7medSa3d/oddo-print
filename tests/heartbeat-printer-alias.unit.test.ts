import { describe, expect, it } from "vitest";
import { aliasPrinterIdForAgent } from "../src/lib/printer-identity";

describe("agent-scoped printer alias identity", () => {
  it("is deterministic per agent and local id", () => {
    expect(aliasPrinterIdForAgent("printer_net_deadbeef", "agt_aaaaaaaa")).toBe(
      aliasPrinterIdForAgent("printer_net_deadbeef", "agt_aaaaaaaa"),
    );
  });

  it("scopes the same local id distinctly per agent", () => {
    const a = aliasPrinterIdForAgent("printer_net_deadbeef", "agt_aaaaaaaa");
    const b = aliasPrinterIdForAgent("printer_net_deadbeef", "agt_bbbbbbbb");
    expect(a).not.toBe(b);
    expect(a.startsWith("printer_net_deadbeef~")).toBe(true);
    expect(b.startsWith("printer_net_deadbeef~")).toBe(true);
  });

  it("uses the tilde sentinel with an 8-hex suffix the agent strips", () => {
    const alias = aliasPrinterIdForAgent("printer_usb_1234abcd", "agt_aaaaaaaa");
    expect(alias).toMatch(/^printer_usb_1234abcd~[0-9a-f]{8}$/);
    expect(alias.length).toBeLessThanOrEqual(120 + 1 + 8);
  });
});
