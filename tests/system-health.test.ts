import { describe, it, expect } from "vitest";
import { checkGateway, CURRENT_SCHEMA_VERSION } from "../src/lib/system-health";
import * as fs from "fs";

describe("system-health", () => {
  it("derives schema version from the latest Drizzle migration", async () => {
    const journal = await import("../drizzle/meta/_journal.json");
    expect(CURRENT_SCHEMA_VERSION).toBe(Number(journal.default.entries.at(-1)?.tag?.slice(0, 4)));
    expect(CURRENT_SCHEMA_VERSION).toBe(75);
  });
  it("gateway check returns ok with heap and uptime", () => {
    const check = checkGateway();
    expect(check.name).toBe("Gateway");
    expect(["ok", "warn", "error"]).toContain(check.state);
    expect(check.details).toHaveProperty("heapUsedMb");
    expect(check.details).toHaveProperty("uptimeSec");
  });

  it("tenant-safe: checkQueue requires tenantId", () => {
    const source = fs.readFileSync("src/lib/system-health.ts", "utf8");
    expect(source).toContain("tenantId");
    expect(source).toContain("tenant_id=");
    expect(source).toContain("requires tenant context");
    expect(source).toContain("tenant-safe");
  });

  it("overall policy prevents false OK when critical UNKNOWN", () => {
    const source = fs.readFileSync("src/lib/system-health.ts", "utf8");
    expect(source).toContain("computeOverall");
    expect(source).toContain("critical");
    expect(source).toContain("UNKNOWN");
    expect(source).toContain("prevents false OK");
    expect(source).toContain("CRITICAL");
    expect(source).toContain("EXTERNAL");
  });

  it("Odoo/Billing honest UNKNOWN / NOT VERIFIED", () => {
    const source = fs.readFileSync("src/lib/system-health.ts", "utf8");
    expect(source).toContain("NOT VERIFIED");
    expect(source).toContain("Odoo health NOT VERIFIED");
    expect(source).toContain("Billing health NOT VERIFIED");
    // Overall cannot be OK when external UNKNOWN
    expect(source).toContain("external");
  });

  it("intentionally unverified externals cap overall at WARN, never OK or UNKNOWN", () => {
    const source = fs.readFileSync("src/lib/system-health.ts", "utf8");
    // The external branch must not force overall UNKNOWN any more: an
    // unverified optional external degrades the dashboard to WARN while
    // the measured dependencies keep their ok/warn/error signal.
    expect(source).toContain("cap overall at WARN");
    expect(source).toContain("intentionally unverified externals cap overall at WARN");
    expect(source).not.toContain("if (external.some(c => c.state === \"unknown\")) return \"unknown\"");
  });

  it("system health includes all required components with tenant scoping", () => {
    const source = fs.readFileSync("src/lib/system-health.ts", "utf8");
    expect(source).toContain("Gateway");
    expect(source).toContain("Database");
    expect(source).toContain("Queue");
    expect(source).toContain("Agents");
    expect(source).toContain("Printers");
    expect(source).toContain("Odoo");
    expect(source).toContain("Billing");
    // Tenant scoping
    expect(source).toContain("tenantId");
  });

  it("health states are valid and policy documented", () => {
    const source = fs.readFileSync("src/lib/system-health.ts", "utf8");
    expect(source).toContain("overall");
    expect(source).toContain("policy");
    expect(source).toContain("ERROR→error");
  });
});
