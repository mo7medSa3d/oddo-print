import { describe, it, expect, vi } from "vitest";
import { closeTenantSockets } from "../src/server/ws";

describe("Tenant Suspension Socket Invalidation", () => {
  it("closeTenantSockets function exists and executes safely without active sockets", () => {
    expect(typeof closeTenantSockets).toBe("function");
    expect(() => closeTenantSockets("ten_nonexistent")).not.toThrow();
  });
});
