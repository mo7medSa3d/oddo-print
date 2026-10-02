import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  agentStaleThresholdSeconds,
  DEFAULT_AGENT_STALE_THRESHOLD_SECONDS,
  MIN_AGENT_STALE_THRESHOLD_SECONDS,
  MAX_AGENT_STALE_THRESHOLD_SECONDS,
  printerStaleThresholdSeconds,
} from "../src/lib/stale-threshold";

/**
 * The stale threshold is not a tuning knob you can set freely: it is one half
 * of the claim-lease contract. The Agent heartbeats every 30s and budgets 15s
 * per attempt, so any threshold below a full cycle plus one hung attempt
 * declares a healthy agent stale — and job claiming, which requires
 * `last_seen_at >= now() - threshold`, would then almost never succeed.
 */
describe("agent stale threshold bounds", () => {
  const key = "STALE_AGENT_THRESHOLD_SECONDS";
  const original = process.env[key];

  afterEach(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });

  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  };

  it("falls back to the default when unset", () => {
    set(undefined);
    expect(agentStaleThresholdSeconds()).toBe(DEFAULT_AGENT_STALE_THRESHOLD_SECONDS);
  });

  it("rejects thresholds below one heartbeat cycle plus one attempt timeout", () => {
    // The old floor was 10s. With a 30s heartbeat that marks a healthy agent
    // stale for ~2/3 of its life, which is worse than not configuring it.
    for (const bad of ["0", "1", "10", "15", "30", "45", "59"]) {
      set(bad);
      expect(agentStaleThresholdSeconds(), `threshold ${bad} must be rejected`).toBe(
        DEFAULT_AGENT_STALE_THRESHOLD_SECONDS,
      );
    }
  });

  it("accepts a threshold at or above the floor", () => {
    // The floor is the Agent's 90s safety window, not a heartbeat-derived
    // number: below it the Gateway could reclaim a job the Agent still
    // believes it owns.
    set(String(MIN_AGENT_STALE_THRESHOLD_SECONDS));
    expect(agentStaleThresholdSeconds()).toBe(MIN_AGENT_STALE_THRESHOLD_SECONDS);
    set("120");
    expect(agentStaleThresholdSeconds()).toBe(120);
    set(String(MAX_AGENT_STALE_THRESHOLD_SECONDS));
    expect(agentStaleThresholdSeconds()).toBe(MAX_AGENT_STALE_THRESHOLD_SECONDS);
  });

  it("rejects non-finite and out-of-range values instead of trusting them", () => {
    for (const bad of ["", "abc", "NaN", "Infinity", "-30", "99999"]) {
      set(bad);
      expect(agentStaleThresholdSeconds(), `threshold "${bad}" must be rejected`).toBe(
        DEFAULT_AGENT_STALE_THRESHOLD_SECONDS,
      );
    }
  });

  it("keeps the floor at or above the heartbeat cycle plus attempt timeout", () => {
    // Agent: 30s ticker + 15s per-attempt budget. If the Agent's heartbeat
    // interval ever changes, this assertion is the tripwire.
    const heartbeatSeconds = 30;
    const attemptTimeoutSeconds = 15;
    expect(MIN_AGENT_STALE_THRESHOLD_SECONDS).toBeGreaterThanOrEqual(
      heartbeatSeconds + attemptTimeoutSeconds,
    );
  });
});

/**
 * Cross-language lease invariant.
 *
 * The Gateway's claim lease is `agentStaleThresholdSeconds()`; the Agent's is a
 * hardcoded `staleClaimSafetyWindow`. The Agent proves ownership after a failed
 * `claimed -> printing` report by showing its delivery arrived less than one
 * window ago, i.e. "no reclaim could have completed". That proof is only valid
 * while the Gateway cannot reclaim sooner, so the Gateway floor must be at
 * least the Agent's window. These tests read the Agent's constant straight out
 * of the Go source so the two cannot drift apart unnoticed.
 */
describe("Gateway/Agent claim-lease coupling", () => {
  const agentGo = fs.readFileSync("agent/internal/agent/agent.go", "utf8");
  const key = "STALE_AGENT_THRESHOLD_SECONDS";
  const original = process.env[key];

  afterEach(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });

  const set = (v: string) => {
    process.env[key] = v;
  };

  /** Parse `staleClaimSafetyWindow = 90 * time.Second` out of the Go source. */
  function agentSafetyWindowSeconds(): number {
    const m = /staleClaimSafetyWindow\s*=\s*(\d+)\s*\*\s*time\.Second/.exec(agentGo);
    expect(m, "could not parse staleClaimSafetyWindow from agent.go").not.toBeNull();
    return Number(m![1]);
  }

  it("finds the Agent's safety window in the Go source", () => {
    // Guards the parser itself: if the constant is renamed or reformatted this
    // fails loudly instead of the coupling tests silently passing.
    expect(agentSafetyWindowSeconds()).toBe(90);
  });

  it("never allows a Gateway threshold below the Agent's safety window", () => {
    // Below this, the Gateway can requeue and reassign while the Agent still
    // believes it owns the job -> duplicate physical print.
    expect(MIN_AGENT_STALE_THRESHOLD_SECONDS).toBeGreaterThanOrEqual(agentSafetyWindowSeconds());
  });

  it("rejects every configured value below the Agent's safety window", () => {
    const window = agentSafetyWindowSeconds();
    for (const bad of [window - 30, window - 1, window - 0.5].filter((v) => v >= 0)) {
      set(String(bad));
      expect(agentStaleThresholdSeconds(), `threshold ${bad} is below the Agent window`).toBe(
        DEFAULT_AGENT_STALE_THRESHOLD_SECONDS,
      );
    }
  });

  it("accepts the Agent's window exactly, which is the default", () => {
    set(String(agentSafetyWindowSeconds()));
    expect(agentStaleThresholdSeconds()).toBe(agentSafetyWindowSeconds());
  });

  it("documents the coupling in the Gateway source so it is not lost", () => {
    const src = fs.readFileSync("src/lib/stale-threshold.ts", "utf8");
    expect(src).toContain("staleClaimSafetyWindow");
    expect(src).toContain("duplicate physical print");
  });

  it("keeps the printer threshold non-configurable so it cannot drift from the claim gate", () => {
    // A mismatch would let the UI report UNKNOWN while routing still executes.
    expect(printerStaleThresholdSeconds()).toBe(90);
  });
});
