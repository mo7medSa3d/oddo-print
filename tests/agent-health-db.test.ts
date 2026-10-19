import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { hasTestDatabase, applyMigrations, truncateAll, seedFixture, pool, closePool } from "./helpers/pg";
import { renderPrometheusMetrics } from "../src/lib/metrics";
import { getAgentHealth, getAllAgentsHealth } from "../src/lib/agent-health";
import { checkPrinters } from "../src/lib/system-health";
import { BoundedQueryRunner } from "../src/lib/bounded-query";
import { Pool as IsolatedPool } from "pg";

/**
 * Database-backed coverage for the two lines changed when the `as any` casts
 * were removed from src/lib/agent-health.ts:
 *   - `const agent = agentRows[0]`     (was `agentRows[0] as any`)
 *   - `const meta = agent.metadata`    (was `agent.metadata as any`)
 * plus the widened `lastOk?: Date | null` declaration.
 *
 * No test previously called getAgentHealth/getAllAgentsHealth at all, so a
 * regression in the metadata/version check or in the never-seen representation
 * would not have been caught.
 */
const suite = describe.skipIf(!hasTestDatabase);

suite("agent health (database-backed)", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });
  beforeEach(async () => { await truncateAll(); });

  it("reports the Version check from agents.metadata.version", async () => {
    const f = await seedFixture();
    await pool().query(
      `UPDATE agents SET metadata = $2::jsonb WHERE id = $1`,
      [f.agentId, JSON.stringify({ version: "1.26.0", os: "windows", hostname: "pos-1" })]
    );
    const health = await getAgentHealth(f.tenantId, f.agentId);
    expect(health).not.toBeNull();
    const version = health!.checks.find((c) => c.name === "Version");
    expect(version).toBeDefined();
    expect(version!.status).toBe("ok");
    expect(version!.message).toContain("v1.26.0");
    expect(version!.details).toMatchObject({ version: "1.26.0", os: "windows", hostname: "pos-1" });
  });

  it("leaves the Version check unknown when metadata has no version", async () => {
    const f = await seedFixture();
    await pool().query(`UPDATE agents SET metadata = '{}'::jsonb WHERE id = $1`, [f.agentId]);
    const health = await getAgentHealth(f.tenantId, f.agentId);
    const version = health!.checks.find((c) => c.name === "Version");
    expect(version!.status).toBe("unknown");
    expect(version!.message).toContain("Version unknown");
  });

  it("exposes a never-seen agent as null last_ok rather than inventing a timestamp", async () => {
    const f = await seedFixture();
    // A freshly seeded agent has last_seen_at set by the fixture; clear it to
    // represent an agent that has never sent a heartbeat.
    await pool().query(`UPDATE agents SET last_seen_at = NULL WHERE id = $1`, [f.agentId]);
    const health = await getAgentHealth(f.tenantId, f.agentId);
    expect(health).not.toBeNull();

    const gateway = health!.checks.find((c) => c.name === "Gateway");
    expect(gateway).toBeDefined();
    expect(gateway!.message).toContain("Never seen");
    // The observed Gateway check omits lastOk entirely when there is no signal.
    expect(gateway!.lastOk).toBeUndefined();

    // The inferred heartbeat check passes agents.last_seen_at through verbatim,
    // so a never-seen agent yields `null` here. This is the line that failed to
    // compile once the `as any` cast was removed, and it is why lastOk is
    // declared `Date | null` rather than `Date | undefined`: the value is
    // serialized into the API response, so it must not be silently rewritten.
    const inferred = health!.checks.find((c) => c.name.startsWith("Heartbeat (inferred"));
    expect(inferred).toBeDefined();
    expect(inferred!.lastOk).toBeNull();
  });

  it("separates printer physical evidence from Agent routability", async () => {
    const f = await seedFixture();
    await pool().query("UPDATE printers SET status = 'busy' WHERE id = $1", [f.printerId]);
    const metric = (text: string, name: string) => Number(text.match(new RegExp(`^${name} ([0-9]+)$`, "m"))?.[1]);
    let output = await renderPrometheusMetrics();
    expect(metric(output, "agents_online")).toBe(1);
    expect(metric(output, "printers_online")).toBe(0);
    expect(metric(output, "printers_busy")).toBe(1);
    expect(metric(output, "printers_routable")).toBe(1);
    await pool().query("UPDATE agents SET last_seen_at = now() - interval '1 day' WHERE id = $1", [f.agentId]);
    output = await renderPrometheusMetrics();
    expect(metric(output, "agents_online")).toBe(0);
    expect(metric(output, "agents_stale")).toBe(1);
    expect(metric(output, "printers_busy")).toBe(1);
    expect(metric(output, "printers_routable")).toBe(0);
    await pool().query("UPDATE agents SET lifecycle = 'disabled', last_seen_at = now() WHERE id = $1", [f.agentId]);
    output = await renderPrometheusMetrics();
    expect(metric(output, "agents_online")).toBe(0);
    expect(metric(output, "agents_stale")).toBe(0);
    expect(metric(output, "printers_busy")).toBe(1);
    expect(metric(output, "printers_routable")).toBe(0);
  });

  it("returns null for an unknown agent id", async () => {
    const f = await seedFixture();
    expect(await getAgentHealth(f.tenantId, "agt_does_not_exist")).toBeNull();
  });

  it("excludes saved, disabled and legacy virtual queues from current health capacity", async () => {
    const f = await seedFixture();
    await seedFixture();
    for (const [present, lifecycle, capabilities, expected] of [
      [true, "active", {}, 1],
      [false, "active", {}, 0],
      [true, "disabled", {}, 0],
      [true, "active", { spoolerName: "Microsoft XPS Document Writer" }, 0],
    ] as const) {
      await pool().query("UPDATE printers SET inventory_present=$1, lifecycle=$2, capabilities=$3::jsonb WHERE id=$4",
        [present, lifecycle, JSON.stringify(capabilities), f.printerId]);
      const detail = await getAgentHealth(f.tenantId, f.agentId);
      const fleet = await getAllAgentsHealth(f.tenantId);
      expect(detail).toMatchObject({ printerCount: expected, onlinePrinterCount: expected });
      expect(fleet).toHaveLength(1);
      expect(fleet[0]).toMatchObject({ printerCount: expected, onlinePrinterCount: expected });
      const system = await checkPrinters(f.tenantId);
      expect(system.details).toMatchObject({ total: expected, routable: expected });
      const metrics = await renderPrometheusMetrics();
      // The other tenant's one physical queue remains part of global metrics.
      expect(metrics.match(/^printers_online (\d+)$/m)?.[1]).toBe(String(expected + 1));
    }
  });

  it("excludes stale and non-active printers from the online count (C018)", async () => {
    const f = await seedFixture();
    // Fixture printer is active/fresh/online: counted.
    let health = await getAgentHealth(f.tenantId, f.agentId);
    expect(health!.onlinePrinterCount).toBe(1);
    expect(health!.printerCount).toBe(1);
    // Stale observation: present but not evidence of availability.
    await pool().query("UPDATE printers SET last_seen_at = now() - interval '1 hour' WHERE id = $1", [f.printerId]);
    health = await getAgentHealth(f.tenantId, f.agentId);
    expect(health!.printerCount).toBe(1);
    expect(health!.onlinePrinterCount).toBe(0);
    // Disabled lifecycle with a fresh observation: still not capacity.
    await pool().query("UPDATE printers SET lifecycle = 'disabled', last_seen_at = now() WHERE id = $1", [f.printerId]);
    health = await getAgentHealth(f.tenantId, f.agentId);
    expect(health!.onlinePrinterCount).toBe(0);
  });
  it("fleet aggregates match detail health, respect tenant bounds and include busy-but-fresh printers", async () => {
    const f = await seedFixture();
    const otherTenant = await seedFixture();
    const secondAgentId = "agt_fleet_health_second";
    await pool().query(
      "INSERT INTO agents (id, tenant_id, name, status, lifecycle, last_seen_at) VALUES ($1, $2, 'Second agent', 'online', 'active', now())",
      [secondAgentId, f.tenantId],
    );
    await pool().query(
      "INSERT INTO printers (id, tenant_id, agent_id, name, status, lifecycle, last_seen_at) VALUES ($1, $2, $3, 'Busy printer', 'busy', 'active', now())",
      ["fleet_busy_printer", f.tenantId, secondAgentId],
    );
    await pool().query(
      "INSERT INTO printers (id, tenant_id, agent_id, name, status, lifecycle, last_seen_at) VALUES ($1, $2, $3, 'Stale printer', 'online', 'active', now() - interval '5 minutes')",
      ["fleet_stale_printer", f.tenantId, secondAgentId],
    );
    await pool().query("UPDATE printers SET status = 'busy' WHERE tenant_id = $1 AND id = $2", [f.tenantId, f.printerId]);
    await pool().query(
      "INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, status, payload, expires_at) VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, now() + interval '1 hour')",
      ["fleet_health_pending", f.tenantId, f.agentId, f.printerId, JSON.stringify({ type: "raw", protocol: "raw", encoding: "base64", data: "aGVsbG8=" })],
    );
    const fleet = await getAllAgentsHealth(f.tenantId, 50, 0);
    expect(fleet.map((agent) => agent.agentId)).toEqual([f.agentId, secondAgentId].sort());
    expect(fleet.every((agent) => agent.tenantId === f.tenantId)).toBe(true);
    expect(fleet.some((agent) => agent.agentId === otherTenant.agentId)).toBe(false);
    for (const summary of fleet) {
      const detail = await getAgentHealth(f.tenantId, summary.agentId);
      expect(summary).toMatchObject({
        status: detail!.status,
        queueDepth: detail!.queueDepth,
        printerCount: detail!.printerCount,
        onlinePrinterCount: detail!.onlinePrinterCount,
      });
      expect(summary.checks.map((c) => [c.name, c.status]))
        .toEqual(detail!.checks.map((c) => [c.name, c.status]));
    }
    expect(fleet.find((agent) => agent.agentId === secondAgentId)).toMatchObject({
      printerCount: 2, onlinePrinterCount: 1, queueDepth: 0,
    });
    expect(fleet.find((agent) => agent.agentId === f.agentId)).toMatchObject({
      printerCount: 1, onlinePrinterCount: 1, queueDepth: 1,
    });
    // The fixture's first Agent ID is random. SQL orders by agent ID, so
    // either Agent may occupy page two. Assert stable pagination against the
    // actual ordering contract instead of a particular fixture identity.
    const orderedIds = [f.agentId, secondAgentId].sort();
    const firstPage = await getAllAgentsHealth(f.tenantId, 1, 0);
    const secondPage = await getAllAgentsHealth(f.tenantId, 1, 1);
    expect(firstPage.map((agent) => agent.agentId)).toEqual(orderedIds.slice(0, 1));
    expect(secondPage.map((agent) => agent.agentId)).toEqual(orderedIds.slice(1));
  });

  it("caller timeouts cannot silently exceed the underlying PostgreSQL pool budget", async () => {
    // pg's server-side statement_timeout bounds actual execution; unlike
    // query_timeout this leaves Drizzle's transaction BEGIN path untouched.
    const limitedPool = new IsolatedPool({
      connectionString: process.env.DATABASE_URL!,
      max: 2,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 400,
    });
    const runner = new BoundedQueryRunner(2);
    try {
      const attempts = Array.from({ length: 2 }, (_, i) =>
        runner.run(() => limitedPool.query("SELECT pg_sleep(0.25)"), 20, `saturated-${i}`));
      const expired = await Promise.allSettled(attempts);
      expect(expired.every((r) => r.status === "rejected")).toBe(true);
      expect(runner.activeCount).toBe(2);
      await expect(runner.run(() => limitedPool.query("SELECT 1"), 20, "overflow"))
        .rejects.toThrow("DB diagnostics overloaded");
      // Wait for the actual two server queries, not just their caller deadlines.
      for (let i = 0; i < 30 && runner.activeCount > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(runner.activeCount).toBe(0);
      expect(limitedPool.waitingCount).toBe(0);
      expect(limitedPool.totalCount).toBeLessThanOrEqual(2);
      expect((await limitedPool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
    } finally {
      await limitedPool.end();
    }
  });

  it("keeps fleet and detail printer freshness equal in non-UTC host timezones", async () => {
    const f = await seedFixture();
    await pool().query("UPDATE printers SET status = 'busy', last_seen_at = now() - interval '1 second' WHERE id = $1", [f.printerId]);
    const previousTZ = process.env.TZ;
    try {
      for (const timezone of ["Africa/Cairo", "America/New_York", "Asia/Tokyo"]) {
        process.env.TZ = timezone;
        const fleet = await getAllAgentsHealth(f.tenantId);
        const detail = await getAgentHealth(f.tenantId, f.agentId);
        expect(detail?.onlinePrinterCount).toBe(1);
        expect(fleet).toHaveLength(1);
        expect(fleet[0].onlinePrinterCount).toBe(detail?.onlinePrinterCount);
      }
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    }
  });

});
