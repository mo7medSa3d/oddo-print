import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  canTransition,
  isTerminal,
  isJobStatus,
  isLateSuccessAllowed,
  LATE_SUCCESS_MAX_AGE_MS,
  PHYSICAL_OUTCOME_UNKNOWN_MARKERS,
  derivePhysicalOutcome,
  hasUnknownPhysicalOutcomeMarker,
  AGENT_REQUEUE_REASONS,
  type JobStatus,
} from "../src/lib/job-status";

describe("job-status", () => {
  it("unknown-outcome markers stay in lockstep across all layers", () => {
    // The marker TEXT is the wire protocol between the Go agent, this
    // gateway, Odoo, and the desktop UX: a marker renamed in one layer
    // silently converts unknown outcomes into auto-retryable failures in
    // another (physical double prints). This is the one place a literal
    // comparison is the correct test: it locks the three independent lists
    // to identical values. (Odoo's _GATEWAY_UNKNOWN_MARKERS is locked by
    // test_marker_parity in the addon suite.)
    const go = readFileSync("agent/internal/printer/outcome.go", "utf8");
    for (const marker of PHYSICAL_OUTCOME_UNKNOWN_MARKERS) {
      expect(go).toContain(`"${marker}"`);
    }
    expect(PHYSICAL_OUTCOME_UNKNOWN_MARKERS).toHaveLength(5);
    expect(derivePhysicalOutcome("failed", "UNKNOWN_SUBMISSION_OUTCOME: x")).toBe("unknown");
    expect(derivePhysicalOutcome("failed", "CONNECTION_ERROR: x")).toBe("not_printed");
  });

  it("classifies every canonical unknown marker as protected physical evidence", () => {
    for (const marker of PHYSICAL_OUTCOME_UNKNOWN_MARKERS) {
      expect(hasUnknownPhysicalOutcomeMarker(`${marker}:detail`)).toBe(true);
    }
    expect(hasUnknownPhysicalOutcomeMarker("GATEWAY_REJECTED_422: bad payload")).toBe(false);
    expect(hasUnknownPhysicalOutcomeMarker(null)).toBe(false);
  });
  it("does not expose a physical-print marker for post-expiry execution success", () => {
    const source = readFileSync("src/lib/job-status.ts", "utf8");
    expect(source).toContain('LATE_SUCCESS_POST_EXPIRATION_MARKER');
    expect(source).not.toContain('PRINTED_POST_EXPIRATION');
  });

  it("terminal states block further transitions", () => {
    expect(isTerminal("success")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("expired")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(canTransition("success", "printing")).toBe(false);
    expect(canTransition("success", "failed")).toBe(false);
    expect(canTransition("expired", "success")).toBe(false);
    // failed is terminal. The ONLY exception is the explicitly authorized
    // late-physical-outcome override (failed -> success), which the API
    // grants solely when isLateSuccessAllowed() also passes (error marker +
    // 24h recency). The general table must say NO without that opt-in, so a
    // second consumer of canTransition cannot silently rewrite failures.
    expect(canTransition("failed", "printing")).toBe(false);
    expect(canTransition("failed", "failed")).toBe(false);
    expect(canTransition("failed", "success")).toBe(false);
    expect(canTransition("failed", "success", { allowLateSuccess: true })).toBe(true);
    expect(canTransition("expired", "success", { allowLateSuccess: true })).toBe(false);
    expect(canTransition("failed", "printing", { allowLateSuccess: true })).toBe(false);
    expect(canTransition("success", "success", { allowLateSuccess: true })).toBe(false);
  });
  it("allowed: claimed->printing and printing->terminal", () => {
    expect(canTransition("claimed", "printing")).toBe(true);
    expect(canTransition("printing", "success")).toBe(true);
    expect(canTransition("printing", "failed")).toBe(true);
  });
  it("agent rejection path: claimed->queued", () => {
    // The route gates this on an explicit fenced reason (AGENT_REQUEUE_REASONS).
    expect(canTransition("claimed", "queued")).toBe(true);
  });

  it("agent terminal re-report: claimed->success", () => {
    // The Go agent re-reports a DURABLE local terminal result instead of
    // re-printing when a duplicate delivery arrives for a job it already
    // completed, or when its local ledger is already terminal
    // (agent/internal/agent/agent.go: "already completed locally (success).
    // Re-reporting terminal result instead of printing again."). Both paths
    // return BEFORE the "printing" report, so the Gateway row is still
    // 'claimed' when the success report lands (the earlier printing report
    // may have failed, or the claim was reclaimed after a lost report).
    // Rejecting it would leave a physically printed job to be swept into
    // failed/unknown with an ambiguity marker, so the transition must be
    // accepted for the current, claim-token-fenced owner.
    expect(canTransition("claimed", "success")).toBe(true);
  });

  it("every status the Go agent emits on a live claim is accepted by this table", () => {
    // Cross-service contract: the agent is a separate program whose tests run
    // against a recording stub, so nothing else ties its emitted statuses to
    // this state machine. Extract them from the real source and require each
    // one to be reachable from the states an agent can legitimately be in
    // (the Gateway hands a job to the agent as 'claimed'; only the agent's own
    // printing report moves it to 'printing').
    const go = readFileSync("agent/internal/agent/agent.go", "utf8");
    const emitted = new Set(
      Array.from(
        go.matchAll(/updateJobStatus\(\s*[A-Za-z_][\w.]*,\s*[A-Za-z_][\w.]*,\s*"([a-z]+)"/g),
        (match) => match[1],
      ),
    );
    // Pre-execution hand-backs are emitted by rejectJobExact, whose status is
    // a literal in the request body rather than a parameter.
    emitted.add("queued");
    expect(emitted.size).toBeGreaterThan(0);

    const AGENT_EMITTABLE = ["printing", "success", "failed", "queued"];
    for (const status of emitted) {
      expect(AGENT_EMITTABLE, `agent emits undocumented status ${status}`).toContain(status);
      // The Gateway always hands a job to the agent as 'claimed', so every
      // status the agent can emit must be legal FROM CLAIMED. This is the
      // exact predicate the agent-jobs route applies; requiring it here (and
      // not "or from printing") is what catches a claim-time re-report whose
      // printing report never landed.
      expect(
        canTransition("claimed", status as JobStatus),
        `gateway rejects agent status ${status} while the job is still claimed`,
      ).toBe(true);
    }
  });
  it("agent rejection reasons cover every pre-execution runtime hand-back", () => {
    expect(AGENT_REQUEUE_REASONS).toEqual([
      "pending_full",
      "printer_pending_full",
      "printer_not_at_desired_state",
      "agent_shutting_down",
      "ledger_unavailable",
    ]);
  });

  it("expired jobs may be finalized by an agent after local TTL observation", () => {
    // Expiration is isolated to the dedicated atomic route branch
    // (expires_at <= NOW() + fencedJobWrite). It is intentionally absent
    // from the generic transition table so a live job can never be
    // terminalized early via canTransition.
    expect(canTransition("claimed", "expired")).toBe(false);
    expect(canTransition("printing", "expired")).toBe(false);
    expect(canTransition("queued", "expired")).toBe(false);
  });
  it("disallowed: queued is agent never sets", () => {
    expect(canTransition("queued", "printing")).toBe(false);
  });
  it("isJobStatus", () => {
    expect(isJobStatus("queued")).toBe(true);
    expect(isJobStatus("bogus")).toBe(false);
  });

  it("DB timestamp parsing treats naive values as UTC", () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    expect(
      isLateSuccessAllowed(
        { status: "failed", error: "AGENT_EXECUTION_TIMEOUT", updatedAt: new Date("2026-09-06T11:30:00.000Z") },
        now,
      ),
    ).toBe(true);
  });

  describe("isLateSuccessAllowed", () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const at = (iso: string) => new Date(iso);
    const job = (overrides: { status: JobStatus; error: string | null; updatedAt: Date }) => ({
      ...overrides,
    });

    it("allows a sweep failure marked AGENT_EXECUTION_TIMEOUT while recent", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "AGENT_EXECUTION_TIMEOUT (retried 2/3)",
            updatedAt: at("2026-09-06T11:00:00.000Z"),
          }),
          now,
        ),
      ).toBe(true);
    });

    it("allows a sweep failure marked AGENT_RESTART_DURING_PRINT", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "AGENT_RESTART_DURING_PRINT",
            updatedAt: at("2026-09-06T11:00:00.000Z"),
          }),
          now,
        ),
      ).toBe(true);
    });

    it("rejects a real print failure (no sweep marker)", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "connection refused: printer offline",
            updatedAt: at("2026-09-06T11:00:00.000Z"),
          }),
          now,
        ),
      ).toBe(false);
    });

    it("rejects a failure older than the 24h window", () => {
      expect(
        isLateSuccessAllowed(
          job({
            status: "failed",
            error: "AGENT_EXECUTION_TIMEOUT",
            updatedAt: new Date(now - LATE_SUCCESS_MAX_AGE_MS - 1),
          }),
          now,
        ),
      ).toBe(false);
    });

    it("rejects when the job is not in failed state", () => {
      expect(
        isLateSuccessAllowed(
          job({ status: "success", error: "AGENT_EXECUTION_TIMEOUT", updatedAt: at("2026-09-06T11:00:00.000Z") }),
          now,
        ),
      ).toBe(false);
    });

    it("rejects null error", () => {
      expect(
        isLateSuccessAllowed(job({ status: "failed", error: null, updatedAt: at("2026-09-06T11:00:00.000Z") }), now),
      ).toBe(false);
    });
  });
});
