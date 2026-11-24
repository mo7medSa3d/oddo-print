import { describe, expect, it } from "vitest";
import { printOutputPresentation } from "../src/lib/print-output";

describe("physical output presentation never overstates paper proof", () => {
  it.each(["queued", "claimed", "printing"])("%s output remains unverified", status => {
    expect(printOutputPresentation({ status, outputMedium: "physical" })).toMatchObject({
      outputMedium: "physical", physicalOutcome: status === "queued" ? "not_printed" : "unknown", outputEvidence: null,
    });
  });
  it("does not claim paper output from transport success alone", () => {
    expect(printOutputPresentation({ status: "success", outputMedium: "physical" })).toMatchObject({
      outputMedium: "physical", physicalOutcome: "unknown", outputEvidence: null, submissionState: "submitted",
    });
  });
  it("ignores any legacy file evidence: every job is physical now", () => {
    const artifact = { output_medium: "file", artifact_id: "artifact_01", sha256: "a".repeat(64), page_count: 2, bytes: 1024 };
    expect(printOutputPresentation({ status: "success", outputMedium: "physical", outputEvidence: artifact })).toMatchObject({
      outputMedium: "physical", physicalOutcome: "unknown", outputEvidence: null,
    });
  });
  it("retains definite pre-dispatch failure versus ambiguous outcome", () => {
    expect(printOutputPresentation({ status: "failed", error: "CAPABILITY_MISMATCH", outputMedium: "physical" }).physicalOutcome).toBe("not_printed");
    expect(printOutputPresentation({ status: "failed", error: "UNKNOWN_PARTIAL_DELIVERY", outputMedium: "physical" }).physicalOutcome).toBe("unknown");
  });
});
