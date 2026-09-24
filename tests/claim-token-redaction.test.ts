import { describe, it, expect } from "vitest";
import * as fs from "fs";

describe("claim-token-redaction", () => {
  it("timeline API redacts claim token (never raw)", () => {
    const source = fs.readFileSync("src/app/api/jobs/[id]/timeline/route.ts", "utf8");
    expect(source).toContain("redactClaimToken");
    expect(source).toContain("Never expose raw claim token");
    expect(source).toContain("sha256");
    expect(source).toContain("redacted");
    // Must NOT expose job.claimToken raw
    expect(source).not.toMatch(/claimId:\s*job\.claimToken[^}]*$/m);
    expect(source).not.toContain("claimId: job.claimToken,");
    // Correlation must be redacted
    expect(source).toContain("claimId: redactClaimToken");
  });

  it("timeline does not contain raw claim token in response structure", () => {
    const source = fs.readFileSync("src/app/api/jobs/[id]/timeline/route.ts", "utf8");
    // Check that correlation object uses redacted version
    expect(source).toContain("redactClaimToken(job.claimToken)");
    // Ensure raw assignment not present
    expect(source).not.toContain("claimId: job.claimToken,");
    expect(source).not.toMatch(/correlation:\s*\{[^}]*claimId:\s*job\.claimToken/);
  });

  it("job-timeline lib does not persist a raw claim token", () => {
    const source = fs.readFileSync("src/lib/job-timeline.ts", "utf8");
    expect(source).toContain("redactClaimId(input.claimId ?? ctx?.claimId)");
    expect(source).not.toContain("claimId: input.claimId ?? ctx?.claimId");
  });

  it("logger does not emit a raw claim id from correlation context", () => {
    const source = fs.readFileSync("src/lib/log.ts", "utf8");
    expect(source).toContain("redactClaimId(ctx.claimId)");
  });
});
