import { describe, expect, it } from "vitest";
import {
  GATEWAY_FAILURES_BEFORE_OFFLINE,
  GATEWAY_OUTAGE_CONFIRMATION_MS,
  emptyGatewayConnectivityEvidence,
  noteGatewayConnectivityFailure,
  noteGatewayConnectivitySuccess,
} from "../src/desktop/lib/gateway-connectivity";

describe("desktop Gateway connectivity evidence", () => {
  const origin = "https://print.yaseir.cloud";

  it("does not flap offline after transient failures following a success", () => {
    let evidence = noteGatewayConnectivitySuccess(
      emptyGatewayConnectivityEvidence(origin),
      origin,
      1_000,
    );

    for (let i = 1; i <= GATEWAY_FAILURES_BEFORE_OFFLINE + 1; i += 1) {
      const observation = noteGatewayConnectivityFailure(evidence, origin, 1_000 + i * 10_000);
      evidence = observation.evidence;
      expect(observation.confirmedOffline).toBe(false);
    }
  });

  it("confirms an outage only after repeated failures and one minute without success", () => {
    let evidence = noteGatewayConnectivitySuccess(
      emptyGatewayConnectivityEvidence(origin),
      origin,
      1_000,
    );

    for (let i = 1; i < GATEWAY_FAILURES_BEFORE_OFFLINE; i += 1) {
      const observation = noteGatewayConnectivityFailure(
        evidence,
        origin,
        1_000 + GATEWAY_OUTAGE_CONFIRMATION_MS + i,
      );
      evidence = observation.evidence;
      expect(observation.confirmedOffline).toBe(false);
    }

    const confirmed = noteGatewayConnectivityFailure(
      evidence,
      origin,
      1_000 + GATEWAY_OUTAGE_CONFIRMATION_MS + GATEWAY_FAILURES_BEFORE_OFFLINE,
    );
    expect(confirmed.confirmedOffline).toBe(true);
  });

  it("one success immediately resets an outage candidate", () => {
    let evidence = noteGatewayConnectivitySuccess(
      emptyGatewayConnectivityEvidence(origin),
      origin,
      1_000,
    );
    for (let i = 0; i < GATEWAY_FAILURES_BEFORE_OFFLINE; i += 1) {
      evidence = noteGatewayConnectivityFailure(
        evidence,
        origin,
        70_000 + i,
      ).evidence;
    }
    expect(evidence.consecutiveFailures).toBe(GATEWAY_FAILURES_BEFORE_OFFLINE);

    evidence = noteGatewayConnectivitySuccess(evidence, origin, 80_000);
    expect(evidence.consecutiveFailures).toBe(0);
    expect(evidence.lastSuccessAt).toBe(80_000);
  });

  it("does not carry success evidence across a different Gateway origin", () => {
    const first = noteGatewayConnectivitySuccess(
      emptyGatewayConnectivityEvidence(origin),
      origin,
      1_000,
    );
    const changed = noteGatewayConnectivityFailure(first, "https://other.example", 2_000);
    expect(changed.confirmedOffline).toBe(true);
    expect(changed.evidence.lastSuccessAt).toBe(0);
  });
});
