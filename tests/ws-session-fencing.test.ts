import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  shouldAcceptAgentSocketForLifecycleState,
  shouldCloseAgentSocketForLifecycleRevision,
} from "../src/server/ws";

describe("WebSocket lifecycle session fencing", () => {
  it("closes sessions authenticated before the invalidating revision", () => {
    expect(shouldCloseAgentSocketForLifecycleRevision(4, 5)).toBe(true);
    expect(shouldCloseAgentSocketForLifecycleRevision(0, 1)).toBe(true);
  });

  it("keeps the session established at the transition revision", () => {
    expect(shouldCloseAgentSocketForLifecycleRevision(5, 5)).toBe(false);
  });

  it("keeps newer sessions when an older PostgreSQL notification is delayed", () => {
    // Disabled at revision 5, re-enabled at revision 6, new WebSocket at
    // revision 6. A delayed notification for revision 5 must not kill it.
    expect(shouldCloseAgentSocketForLifecycleRevision(6, 5)).toBe(false);
  });

  it("keeps sessions from an even newer transition", () => {
    expect(shouldCloseAgentSocketForLifecycleRevision(7, 5)).toBe(false);
  });

  it("closes sockets that do not carry the revision fence", () => {
    expect(shouldCloseAgentSocketForLifecycleRevision(undefined, 5)).toBe(true);
  });

  it("accepts a socket only when durable lifecycle is active at the authenticated revision", () => {
    expect(shouldAcceptAgentSocketForLifecycleState(5, 5, "active")).toBe(true);
    expect(shouldAcceptAgentSocketForLifecycleState(5, 5, "disabled")).toBe(false);
    expect(shouldAcceptAgentSocketForLifecycleState(5, 6, "active")).toBe(false);
  });

  it("fails closed when lifecycle state or revision is missing or invalid", () => {
    expect(shouldAcceptAgentSocketForLifecycleState(undefined, 5, "active")).toBe(false);
    expect(shouldAcceptAgentSocketForLifecycleState(5, undefined, "active")).toBe(false);
    expect(shouldAcceptAgentSocketForLifecycleState(5, 5, undefined)).toBe(false);
    expect(shouldAcceptAgentSocketForLifecycleState(-1, 5, "active")).toBe(false);
  });

  it("registers an upgraded socket under the lifecycle row lock", () => {
    const source = readFileSync(resolve(process.cwd(), "src/server/ws.ts"), "utf8");
    const helper = source.slice(
      source.indexOf("async function verifyAndTrackAgentSocket"),
      source.indexOf("export function closeAgentSockets"),
    );

    expect(helper).toContain("FOR SHARE");
    expect(helper.indexOf("FOR SHARE")).toBeLessThan(helper.indexOf("trackAgentSocket(agentId, ws)"));
    expect(helper.indexOf("trackAgentSocket(agentId, ws)")).toBeLessThan(helper.indexOf('await client.query("COMMIT")'));
  });
});
