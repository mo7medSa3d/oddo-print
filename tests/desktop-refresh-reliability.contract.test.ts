import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Manager refresh reliability (C042): concurrent 401s must share one refresh
// flight, and only authoritative rejection (401 invalid/revoked family) may
// clear the live session — never a timeout, 503, or other transient failure.
describe("desktop manager refresh reliability", () => {
  it("shares one refresh flight per origin", () => {
    const ipc = readFileSync("src/desktop/lib/ipc.ts", "utf8");
    expect(ipc).toContain("const refreshFlights = new Map<string, Promise<ManagerSessionStatus>>()");
    expect(ipc).toContain("const ongoing = refreshFlights.get(base)");
  });

  it("clears the session only on authoritative rejection", () => {
    const ipc = readFileSync("src/desktop/lib/ipc.ts", "utf8");
    expect(ipc).toContain("clearManagerSessionUnlessTransient");
    // No unconditional clear remains on any refresh-failure path outside the
    // guarded helper and the deliberate operator logout.
    const rawClears = ipc.match(/await clearManagerSession\(\);/g) ?? [];
    expect(rawClears.length).toBe(2);
  });

  it("does not clear twice around the shared gateway refresh cycle", () => {
    const ipc = readFileSync("src/desktop/lib/ipc.ts", "utf8");
    expect(ipc).not.toContain("if (status === 401) await clearManagerSession();");
  });
});
