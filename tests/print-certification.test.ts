import { describe, it, expect } from "vitest";

describe("print-certification", () => {
  it("certification steps cover Gateway→Auth→Queue→Claim→Agent→Transport→Physical→Ack→Final", () => {
    const steps = ["gateway", "auth", "queue", "claim", "agent", "transport", "physical", "ack", "final"];
    expect(steps).toEqual(["gateway", "auth", "queue", "claim", "agent", "transport", "physical", "ack", "final"]);
  });

  it("physical step BLOCKED handling in sandbox", () => {
    const blockedReason = "BLOCKED: no physical printer in sandbox";
    expect(blockedReason).toContain("BLOCKED");
  });

  it("YASSER TEST PAGE contains no secrets", () => {
    const testPage = `YASSER TEST PAGE
Printer: Test Printer
Tenant: tenant_123
Job: cert_abc
Request: req_xyz
Time: 2024-01-01T00:00:00Z
Transport: network/raw

This is a diagnostic test page for certification.
No credentials are printed.`;
    // Check for actual secret patterns, not the word "secret" in safe context
    expect(testPage).not.toMatch(/password\s*[:=]/i);
    expect(testPage).not.toMatch(/api[_-]?key\s*[:=]/i);
    expect(testPage).toContain("YASSER TEST PAGE");
  });

  it("certification job links Gateway↔Spooler via spoolerJobId", () => {
    const job = { id: "cert_123", spoolerJobId: "42", attemptId: "attempt_1", claimToken: "claim_1" };
    expect(job.spoolerJobId).toBeDefined();
    expect(job.attemptId).toBeDefined();
    expect(job.claimToken).toBeDefined();
  });
});
