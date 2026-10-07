import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Diagnostic test prints are physical operations: a second click or a retry
// after an ambiguous timeout must not mint a second operation. The Gateway
// test-print route honors Idempotency-Key; clients must send a per-printer
// operation key, guard in-flight requests, and reuse the key only while the
// outcome is unobserved.
describe("diagnostic test-print operation identity", () => {
  it("desktop sends a preserved operation key with a per-printer flight guard", () => {
    const ipc = readFileSync("src/desktop/lib/ipc.ts", "utf8");
    const main = readFileSync("src/desktop/main.tsx", "utf8");
    expect(ipc).toContain('"Idempotency-Key": idempotencyKey');
    expect(main).toContain("testFlightRef");
    expect(main).toContain("testOpKeyRef");
    expect(main).toContain("testGatewayPrinter(savedGatewayUrl, id, key)");
  });

  it("dashboard test page sends an idempotency key under a per-printer busy guard", () => {
    const dashboard = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    expect(dashboard).toContain('"Idempotency-Key": generateIdempotencyKey()');
    expect(dashboard).toContain("setTestingPrinterId(printerId)");
  });

  it("certification wizard preserves one operation key for the session", () => {
    const wizard = readFileSync("src/components/PrintCertificationWizard.tsx", "utf8");
    expect(wizard).toContain('"Idempotency-Key": operationKey.current');
  });
});
