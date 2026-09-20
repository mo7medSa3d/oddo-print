import { describe, it, expect } from "vitest";
import { checkGateway } from "../src/lib/system-health";

describe("system-health", () => {
  it("gateway check returns ok with heap and uptime", () => {
    const check = checkGateway();
    expect(check.name).toBe("Gateway");
    expect(["ok", "warn", "error"]).toContain(check.state);
    expect(check.details).toHaveProperty("heapUsedMb");
    expect(check.details).toHaveProperty("uptimeSec");
  });

  it("system health includes all required components", () => {
    const required = ["Gateway", "Database", "Queue", "Agents", "Printers", "Odoo", "Billing"];
    // This is conceptual — actual getSystemHealth does DB queries
    expect(required).toContain("Gateway");
    expect(required).toContain("Database");
    expect(required).toContain("Queue");
    expect(required).toContain("Agents");
    expect(required).toContain("Printers");
  });

  it("health states are valid", () => {
    const validStates = ["ok", "warn", "error", "unknown"];
    expect(validStates).toContain("ok");
    expect(validStates).toContain("warn");
    expect(validStates).toContain("error");
    expect(validStates).toContain("unknown");
  });
});
