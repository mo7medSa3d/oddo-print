import { describe, expect, it } from "vitest";
import { computeAgentHealthStatus } from "../src/lib/agent-health";
import { agentLiveView } from "../src/shared/job-vocabulary";
import { normalizePrinterStatus } from "../src/lib/printer-health";
import { translate } from "../src/i18n/translate";

describe("cross-layer health freshness contracts", () => {
  const now = new Date("2026-09-29T00:00:00.000Z");

  it("never reports an offline agent as ONLINE from a fresh timestamp", () => {
    const seen = new Date(now.getTime() - 10_000);
    expect(computeAgentHealthStatus(seen, undefined, now, "offline")).toBe("OFFLINE");
  });

  it("never treats a future agent heartbeat as fresh in the shared UI", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(agentLiveView({ status: "online", lifecycle: "active", lastSeenAt: future }, now.getTime()).label)
      // "Heartbeat" is engineering vocabulary; the UI states the consequence.
      // Assert against the resolved copy so this test checks the invariant
      // (a future heartbeat must not read as fresh) rather than frozen wording.
      .toBe(translate("en", "status.heartbeatLost"));
  });

  it("requires fresh parent-agent evidence for a printer to be ONLINE", () => {
    const printerSeen = new Date(now.getTime() - 10_000);
    const agentSeen = new Date(now.getTime() - 200_000);
    const result = normalizePrinterStatus("online", {
      lastSeenAt: printerSeen,
      agentLastSeenAt: agentSeen,
      agentStatus: "online",
      now,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.freshness.fresh).toBe(false);
  });
});
