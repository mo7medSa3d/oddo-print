import { describe, expect, it } from "vitest";
import { deriveSubmissionState } from "../src/lib/submission-evidence";

/**
 * v5 P4: submitted/completed/unknown derivation (v4 WP2, migration 0110).
 * DB status 'success' + submission_evidence derives the submission state;
 * completed is reachable ONLY with positive query evidence. Until live
 * GetJob/IPP adapters land, every old-agent success derives 'submitted'
 * and 'completed' is unreachable by design (v4 BLOCKED item, not a bug).
 */
describe("submission state derivation", () => {
  it("derives submitted for an old-agent success with no evidence", () => {
    expect(deriveSubmissionState("success", "physical", null)).toBe("submitted");
    expect(deriveSubmissionState("success", "physical", undefined)).toBe("submitted");
  });

  it("derives submitted for acceptance-response evidence only", () => {
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "submission", spoolerJobId: "42",
    })).toBe("submitted");
  });

  it("derives completed only with positive query evidence", () => {
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", windowsJobStatus: ["PRINTED"],
    })).toBe("completed");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", ippJobState: 9,
    })).toBe("completed");
  });

  it("keeps a bare query and COMPLETE-only flags at submitted", () => {
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", transport: "spooler",
    })).toBe("submitted");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", windowsJobStatus: ["COMPLETE"],
    })).toBe("submitted");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", ippJobState: 5,
    })).toBe("submitted");
  });

  it("derives unknown for terminal-bad query results, never failed", () => {
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", ippJobState: 7,
    })).toBe("unknown");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", ippJobState: 8,
    })).toBe("unknown");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", ippJobStateReasons: ["job-canceled-by-user"],
    })).toBe("unknown");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", windowsJobStatus: ["ERROR"],
    })).toBe("unknown");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", verificationAttempt: "timeout",
    })).toBe("unknown");
    expect(deriveSubmissionState("success", "physical", {
      verificationSource: "query", verificationAttempt: "unknown",
    })).toBe("unknown");
  });

  it("yields no submission state for non-success jobs", () => {
    expect(deriveSubmissionState("failed", "physical", null)).toBeNull();
    expect(deriveSubmissionState("queued", "physical", null)).toBeNull();
  });
});
