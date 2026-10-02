import { afterEach, describe, expect, it } from "vitest";
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
    set("60");
    expect(agentStaleThresholdSeconds()).toBe(60);
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

  it("keeps the printer threshold non-configurable so it cannot drift from the claim gate", () => {
    // A mismatch would let the UI report UNKNOWN while routing still executes.
    expect(printerStaleThresholdSeconds()).toBe(90);
  });
});
