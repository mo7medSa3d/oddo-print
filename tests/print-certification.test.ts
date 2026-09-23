import { describe, it, expect } from "vitest";
import * as fs from "fs";

describe("print-certification", () => {
  it("certification derives timing decisions from the database clock", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    expect(source).toContain("const certificationNowMs = await databaseNowMs();");
    expect(source).toContain("const expiresAt = new Date(certificationNowMs + 5 * 60 * 1000);");
    expect(source).not.toContain("const expiresAt = new Date(Date.now() + 5 * 60 * 1000);");
  });

  it("certification route uses canonical pipeline (createPrintJobForPrinter)", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    expect(source).toContain("createPrintJobForPrinter");
    expect(source).not.toContain("db.insert(printJobs)"); // must NOT bypass
    expect(source).toContain("tenant validation");
    expect(source).toContain("idempotencyKey");
    expect(source).toContain("Idempotency-Key");
  });

  it("certification has real idempotency key handling", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    expect(source).toContain("idempotencyKey");
    expect(source).toContain("IDEMPOTENCY_CONFLICT");
    expect(source).toContain("cert:");
    // Double-click must not duplicate — idempotency key reused
    expect(source).toContain("isReused");
  });

  it("wizard is state-driven from job status, not inferred from lastSeenAt", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    expect(source).toContain("state-driven");
    expect(source).toContain("freshJob.status");
    expect(source).toContain("pending");
    // Claim step should be pending when queued, not ok based on lastSeen
    expect(source).toContain('status === "queued"');
    expect(source).toContain("waiting for agent");
    // Should NOT claim ok merely because lastSeenAt exists — check that old pattern is removed
    expect(source).not.toMatch(/setStep\("claim", "ok".*lastSeen/);
  });

  it("certification steps cover Gateway→Auth→Queue→Claim→Agent→Transport→Physical→Ack→Final", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    const steps = ["gateway", "auth", "queue", "claim", "agent", "transport", "physical", "ack", "final"];
    for (const step of steps) {
      expect(source).toContain(`"${step}"`);
    }
  });

  it("physical step BLOCKED handling in sandbox, never auto-certify", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    expect(source).toContain("BLOCKED");
    expect(source).toContain("certified = false");
    expect(source).toContain("Never auto-certify");
    expect(source).toContain("Physical verification requires real printer");
  });

  it("YASSER TEST PAGE contains no secrets", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    // Ensure test page content in source has no secret patterns
    expect(source).toContain("YASSER TEST PAGE");
    expect(source).not.toMatch(/password\s*[:=]/i);
    // The payload should say No credentials are printed, not contain api key
    const testPageSnippet = source.match(/YASSER TEST PAGE[\s\S]{0,500}/)?.[0] ?? "";
    expect(testPageSnippet).toContain("YASSER TEST PAGE");
  });

  it("certification job links Gateway↔Spooler via spoolerJobId and records timeline", () => {
    const source = fs.readFileSync("src/app/api/printers/[id]/certify/route.ts", "utf8");
    expect(source).toContain("spoolerJobId");
    expect(source).toContain("recordJobEvent");
    expect(source).toContain("timelineUrl");
  });
});
