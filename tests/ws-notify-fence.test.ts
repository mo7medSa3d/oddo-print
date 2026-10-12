import { describe, expect, it } from "vitest";
import { jobNoticeTenantAllowed, shouldCloseTenantSocketsForNotification } from "../src/server/ws";

describe("NOTIFY tenant fences (T-2)", () => {
  it("closes tenant sockets only for suspended/deleted lifecycles", () => {
    expect(shouldCloseTenantSocketsForNotification("suspended")).toBe(true);
    expect(shouldCloseTenantSocketsForNotification("deleted")).toBe(true);
    expect(shouldCloseTenantSocketsForNotification("active")).toBe(false);
    expect(shouldCloseTenantSocketsForNotification(null)).toBe(false);
    expect(shouldCloseTenantSocketsForNotification(undefined)).toBe(false);
    expect(shouldCloseTenantSocketsForNotification("bogus")).toBe(false);
  });
  it("requires explicit matching tenant on job notices, rejecting missing or mismatched tenant", () => {
    expect(jobNoticeTenantAllowed(undefined, "t1")).toBe(false);
    expect(jobNoticeTenantAllowed("", "t1")).toBe(false);
    expect(jobNoticeTenantAllowed("t1", "t1")).toBe(true);
    expect(jobNoticeTenantAllowed("t2", "t1")).toBe(false);
    expect(jobNoticeTenantAllowed("t1", undefined)).toBe(false);
  });
});
