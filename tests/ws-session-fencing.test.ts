import { describe, expect, it } from "vitest";
import { shouldCloseAgentSocketForLifecycleRevision } from "../src/server/ws";

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
});
