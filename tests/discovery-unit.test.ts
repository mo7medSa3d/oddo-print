import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isPrivateCIDR, confidenceFor, DISCOVERY_SOURCES, DISCOVERY_PROTOCOLS } from "../src/lib/discovery";

import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, pool, closePool } from "./helpers/pg";
import { POST as discoveryReport } from "../src/app/api/agent/discovery/route";

describe("discovery taxonomy", () => {
  it("canonical sources include all required", () => {
    expect(DISCOVERY_SOURCES).toContain("mdns");
    expect(DISCOVERY_SOURCES).toContain("snmp");
    expect(DISCOVERY_SOURCES).toContain("wsd");
    expect(DISCOVERY_SOURCES).toContain("windows_spooler");
    expect(DISCOVERY_SOURCES).toContain("usb");
    expect(DISCOVERY_PROTOCOLS).not.toContain("pcl" as any);
  });
  it("PCL never treated as discovery protocol", () => {
    expect(DISCOVERY_PROTOCOLS).not.toContain("pcl");
    expect((DISCOVERY_PROTOCOLS as readonly string[]).includes("pcl")).toBe(false);
  });
});

describe("CIDR validation (private only, /16-/30)", () => {
  it("rejects public and loopback", () => {
    expect(isPrivateCIDR("8.8.8.0/24")).toBe(false);
    expect(isPrivateCIDR("127.0.0.0/8")).toBe(false);
    expect(isPrivateCIDR("192.168.1.0/24")).toBe(true);
    expect(isPrivateCIDR("10.0.0.0/16")).toBe(true);
    expect(isPrivateCIDR("172.16.0.0/16")).toBe(true);
    expect(isPrivateCIDR("172.32.0.0/16")).toBe(false);
    expect(isPrivateCIDR("192.168.1.0/31")).toBe(false); // too narrow
    expect(isPrivateCIDR("not-a-cidr")).toBe(false);
  });
  it("rejects /8 and /15", () => {
    expect(isPrivateCIDR("10.0.0.0/8")).toBe(false);
    expect(isPrivateCIDR("192.168.0.0/15")).toBe(false);
  });
});

describe("confidence scoring deterministic", () => {
  it("high when verified IPP + model", () => {
    expect(confidenceFor(["ipp","mdns"], "verified", true)).toBe("high");
  });
  it("medium when candidate but model present", () => {
    expect(confidenceFor(["raw"], "candidate", true)).toBe("medium");
  });
  it("low when single low-signal candidate", () => {
    expect(confidenceFor(["raw"], "candidate", false)).toBe("low");
  });
  it("deterministic: same inputs same output", () => {
    const a = confidenceFor(["ipp","snmp"], "verified", true);
    const b = confidenceFor(["ipp","snmp"], "verified", true);
    expect(a).toBe(b);
  });
});

describe.skipIf(!hasTestDatabase)("discovery identity deduplication at the actual ingestion boundary", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  it("stores one logical device for multiple observations with the same stable identity", async () => {
    await truncateAll();
    const fixture = await seedFixture();
    await pool().query("INSERT INTO discovery_sessions (id, tenant_id, agent_id, status, config, stats) VALUES ('disc_identity_dedupe', $1, $2, 'running', '{}'::jsonb, '{}'::jsonb)", [fixture.tenantId, fixture.agentId]);
    const response = await discoveryReport(new Request("https://gateway.test/api/agent/discovery", { method: "POST", headers: { Authorization: fixture.agentAuth, "Content-Type": "application/json" }, body: JSON.stringify({ discoveryId: "disc_identity_dedupe", status: "completed", devices: ["mdns", "ipp", "snmp"].map(source => ({ id: "observed-" + source, stableId: "same-physical-printer", source: [source], protocol: "ipp", ipAddress: "192.168.1.50", port: 631 })) }) }));
    expect(response.status).toBe(200);
    const rows = await pool().query("SELECT identity_key, source FROM discovered_devices WHERE tenant_id=$1 AND agent_id=$2", [fixture.tenantId, fixture.agentId]);
    expect(rows.rows).toEqual([{ identity_key: "same-physical-printer", source: ["snmp"] }]);
  });
});

  it("rejects nondecimal CIDR octets/prefixes instead of numeric coercion", () => {
    for (const cidr of ["10..1.0/24", "10.0x10.0.0/24", "10.1.5e1.0/24", "10.1.1.0/0x18", "10.1.1.0/2.4e1", "10.01.1.0/24", "10.1.1.0/ 24"]) expect(isPrivateCIDR(cidr)).toBe(false);
    expect(isPrivateCIDR("10.255.254.0/24")).toBe(true);
  });
