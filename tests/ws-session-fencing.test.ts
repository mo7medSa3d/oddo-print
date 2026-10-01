import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  __canReserveAgentSocketSlotForTests,
  shouldAcceptAgentSocketForLifecycleState,
  shouldCloseAgentSocketForLifecycleRevision,
} from "../src/server/ws";

describe("WebSocket capacity reservation", () => {
  it("guards upgrade reservation cleanup before registration", () => {
    const source = readFileSync(resolve(process.cwd(), "src/server/ws.ts"), "utf8");
    const handleUpgrade = source.indexOf("wss.handleUpgrade(req, socket, head");
    const reservationClose = source.indexOf('socket.once("close", releaseReservation)', 0);
    const catchStart = source.indexOf("} catch (error)", handleUpgrade);
    const releaseInCatch = source.indexOf("releaseReservation();", catchStart);
    expect(handleUpgrade).toBeGreaterThanOrEqual(0);
    expect(reservationClose).toBeGreaterThanOrEqual(0);
    expect(catchStart).toBeGreaterThan(handleUpgrade);
    expect(releaseInCatch).toBeGreaterThan(catchStart);
  });

  it("counts in-flight upgrades before admitting another connection", () => {
    expect(__canReserveAgentSocketSlotForTests(4095, 0)).toBe(true);
    expect(__canReserveAgentSocketSlotForTests(4096, 0)).toBe(false);
    expect(__canReserveAgentSocketSlotForTests(4095, 1)).toBe(false);
    expect(__canReserveAgentSocketSlotForTests(4094, 1)).toBe(true);
  });

  it("reserves the global slot before handleUpgrade", () => {
    const source = readFileSync(resolve(process.cwd(), "src/server/ws.ts"), "utf8");
    const reserve = source.indexOf("if (!reserveAgentSocketSlot())");
    const handleUpgrade = source.indexOf("wss.handleUpgrade(req, socket, head", reserve);
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(handleUpgrade).toBeGreaterThan(reserve);
    expect(source).toContain("canReserveAgentSocketSlot(totalAgentSockets, pendingAgentSocketReservations)");
    expect(source).toContain("pendingAgentSocketReservations += 1;");
    expect(source).toContain("pendingAgentSocketReservations = Math.max(0, pendingAgentSocketReservations - 1);");
    expect(source).toContain("ws.readyState === WebSocket.OPEN");
  });
});

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
