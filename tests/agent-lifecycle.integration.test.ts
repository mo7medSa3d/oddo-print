import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { agents, auditEvents, printers, tenants } from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { applyMigrations, closePool, hasTestDatabase, seedFixture } from "./helpers/pg";
import { hashPairingCode } from "../src/lib/agent-auth";
import { transitionAgentLifecycle, LifecycleConflict, type AgentLifecycleResult } from "../src/lib/agent-lifecycle";
import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

suite("Agent Lifecycle", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });

  it("returns the persisted pairing expiry when reenabling and no credentials on an unchanged transition", async () => {
    const fixture = await seedFixture();
    const actor = { type: "user" as const, id: "reenable-user" };
    await transitionAgentLifecycle(fixture.agentId, "disabled", fixture.tenantId, actor);
    const result = await transitionAgentLifecycle(fixture.agentId, "active", fixture.tenantId, actor);
    expect(result?.changed).toBe(true);
    expect(result?.pairingCode).toBeTruthy();
    expect(result?.pairingCodeExpiresAt).toBeInstanceOf(Date);
    const row = await db.query.agents.findFirst({ where: and(eq(agents.id, fixture.agentId), eq(agents.tenantId, fixture.tenantId)) });
    expect(row?.pairingCodeExpiresAt?.getTime()).toBe(result!.pairingCodeExpiresAt!.getTime());
    expect(row?.pairingCodeHash).toBe(hashPairingCode(result!.pairingCode!));
    expect(row?.secret).toBeNull();
    expect(row?.status).toBe("offline");
    const unchanged = await transitionAgentLifecycle(fixture.agentId, "active", fixture.tenantId, actor);
    expect(unchanged).toEqual({ changed: false, lifecycle: "active", pairingCode: null, pairingCodeExpiresAt: null });
  });

  it("serializes concurrent lifecycle requests without stale overwrite", async () => {
    const tenantId = `tenant_agent_lifecycle_${nanoid(8)}`;
    const agentId = `agent_lifecycle_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Agent Lifecycle Test" });
    await db.insert(agents).values({ id: agentId, tenantId, name: "Agent", lifecycle: "active", status: "online" });
    const printerId = `printer_agent_lifecycle_${nanoid(8)}`;
    await db.insert(printers).values({
      id: printerId,
      tenantId,
      agentId,
      name: "Managed Printer",
      printerType: "physical",
      deviceClass: "thermal",
      connectionType: "network",
      protocol: "raw",
      status: "unknown",
      lifecycle: "active",
      config: { ip: "192.0.2.10", port: 9100 },
      managementSource: "manager",
      desiredRevision: 1,
      appliedDesiredRevision: 0,
      observedDesiredRevision: 0,
    });

    const [retired, disabled] = await Promise.allSettled([
      transitionAgentLifecycle(agentId, "retired", tenantId, { type: "user", id: "retire-user" }),
      transitionAgentLifecycle(agentId, "disabled", tenantId, { type: "user", id: "disable-user" }),
    ]);

    const row = await db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)) });
    // Retirement wins in either lock order: retiring first fences disable;
    // disabling first permits a second, valid disabled -> retired transition.
    expect(row!.lifecycle).toBe("retired");

    const succeeded = [retired, disabled].filter((result): result is PromiseFulfilledResult<AgentLifecycleResult | null> => result.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.every((result) => result.value?.lifecycle)).toBe(true);
    expect(row!.lifecycleRevision).toBe(succeeded.length);
    const printerRow = await db.query.printers.findFirst({
      where: and(eq(printers.id, printerId), eq(printers.tenantId, tenantId)),
    });
    expect(printerRow!.lifecycle).toBe("active");
    expect(printerRow!.managementSource).toBe("manager");


    if (row!.lifecycle === "retired") {
      expect(retired.status).toBe("fulfilled");
      expect((retired as PromiseFulfilledResult<{ changed: boolean; lifecycle: string; pairingCode: string | null }>).value.lifecycle).toBe("retired");
    }
    if (row!.lifecycle === "disabled") {
      expect(disabled.status).toBe("fulfilled");
      expect((disabled as PromiseFulfilledResult<{ changed: boolean; lifecycle: string; pairingCode: string | null }>).value.lifecycle).toBe("disabled");
    }

    if (retired.status === "rejected") expect(retired.reason).toBeInstanceOf(LifecycleConflict);
    if (disabled.status === "rejected") expect(disabled.reason).toBeInstanceOf(LifecycleConflict);

    const audits = await db.query.auditEvents.findMany({ where: eq(auditEvents.tenantId, tenantId) });
    expect(audits.filter((event) => event.resourceId === agentId && event.action.startsWith("agent.lifecycle."))).toHaveLength(succeeded.length);
  });
});
