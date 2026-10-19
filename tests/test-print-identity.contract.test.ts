import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiagnosticOperations, decodeDiagnosticResult, diagnosticScope, diagnosticMessageKey } from "../src/shared/diagnostic-test";

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
    expect(main).toContain("diagnosticOps.current.begin(scope)");
    expect(main).toContain("diagnosticOps.current.uncertain(scope)");
    expect(main).toContain("testGatewayPrinter(savedGatewayUrl, id, key)");
  });

  it("dashboard test page sends an idempotency key under a per-printer busy guard", () => {
    const dashboard = readFileSync("src/app/dashboard/dashboard-client.tsx", "utf8");
    expect(dashboard).toContain('"Idempotency-Key": operationKey');
    expect(dashboard).toContain("diagnosticOps.current.begin(scope)");
    expect(dashboard).toContain("setTestingPrinterId(printerId)");
  });

  it("shares a synchronous per-actor and printer identity across retries", () => {
    let seq = 0;
    const operations = new DiagnosticOperations(() => `operation-identity-${++seq}`);
    const ctx = diagnosticScope("https://gateway.example/", "tenant:operator", "printer-1");
    const first = operations.begin(ctx);
    expect(operations.begin(ctx)).toBeNull();
    operations.uncertain(ctx);
    expect(operations.begin(ctx)).toBe(first);
    const accepted = decodeDiagnosticResult({ ok: true, jobId: "job-1", printerId: "printer-1", status: "queued" }, "printer-1");
    operations.accept(ctx, accepted);
    expect(operations.observed(ctx)?.jobId).toBe("job-1");
    expect(operations.confirmRepeat(ctx)).toBe(true);
    expect(operations.begin(ctx)).not.toBe(first);
  });

  it("refuses forged identity and does not describe terminal failure as newly queued", () => {
    expect(() => decodeDiagnosticResult({ ok: true, jobId: "j", printerId: "other", status: "queued" }, "printer-1")).toThrow();
    const terminal = decodeDiagnosticResult({ ok: true, jobId: "j", printerId: "printer-1", status: "failed", isReused: true }, "printer-1");
    expect(diagnosticMessageKey(terminal)).toBe("diagnostic.unverified");
  });

  it("certification wizard preserves one operation key for the session", () => {
    const wizard = readFileSync("src/components/PrintCertificationWizard.tsx", "utf8");
    expect(wizard).toContain('"Idempotency-Key": operationKey.current');
  });
});
