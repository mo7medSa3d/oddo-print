import { describe, expect, it } from "vitest";
import {
  derivePhysicalOutcome,
  isLateSuccessAllowed,
  PHYSICAL_OUTCOMES,
} from "../src/lib/job-status";
import { jobLabel, jobGuidance } from "../src/shared/job-vocabulary";
import { translate } from "../src/i18n/translate";

describe("physical print outcome semantics", () => {
  it("defines the three physical outcome values", () => {
    expect(PHYSICAL_OUTCOMES).toEqual(["not_printed", "printed", "unknown"]);
  });

  it("does not treat transport success as proof of physical paper output", () => {
    expect(derivePhysicalOutcome("success", null)).toBe("unknown");
    expect(jobLabel("success", "unknown")).toBe("Delivered to printer");
    // The copy is localized now, so assert against the resolved guidance. The
  // invariant is unchanged: a Gateway "success" means the Agent handed the
  // document to the printer transport, NOT that paper physically emerged.
  expect(jobGuidance("success", "unknown")).toBe(translate("en", "job.guidance.success"));
  });

  it("does not confuse an ordinary failed job with an unknown physical result", () => {
    expect(derivePhysicalOutcome("failed", "CAPABILITY_MISMATCH")).toBe("not_printed");
    expect(derivePhysicalOutcome("failed", "connection refused")).toBe("not_printed");
  });

  it("classifies crash, execution-timeout, and expiry-during-print as UNKNOWN", () => {
    expect(derivePhysicalOutcome("failed", "AGENT_RESTART_DURING_PRINT: physical output unknown")).toBe("unknown");
    expect(derivePhysicalOutcome("failed", "AGENT_EXECUTION_TIMEOUT: printer did not finish")).toBe("unknown");
    expect(derivePhysicalOutcome("expired", "JOB_EXPIRED_DURING_PRINT: physical output is unknown")).toBe("unknown");
  });

  it("allows late success only for a recent unknown-outcome failure", () => {
    const now = Date.now();
    expect(isLateSuccessAllowed({
      status: "failed",
      error: "AGENT_RESTART_DURING_PRINT: physical output is unknown",
      updatedAt: new Date(now - 1_000),
    }, now)).toBe(true);

    expect(isLateSuccessAllowed({
      status: "failed",
      error: "CAPABILITY_MISMATCH",
      updatedAt: new Date(now - 1_000),
    }, now)).toBe(false);
  });

  it("does not turn an old unknown outcome into success after the late-success window", () => {
    const now = Date.now();
    expect(isLateSuccessAllowed({
      status: "failed",
      error: "AGENT_EXECUTION_TIMEOUT: physical output is unknown",
      updatedAt: new Date(now - 25 * 60 * 60 * 1000),
    }, now)).toBe(false);
  });
});
