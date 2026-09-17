import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { agents, auditEvents, printers, tenants } from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { applyMigrations, closePool, hasTestDatabase } from "./helpers/pg";
import { transitionAgentLifecycle, LifecycleConflict } from "../src/lib/agent-lifecycle";
import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

suite("Agent Lifecycle", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });

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
    expect(row!.lifecycle === "retired" || row!.lifecycle === "disabled").toBe(true);

    const succeeded = [retired, disabled].filter((result): result is PromiseFulfilledResult<{ changed: boolean; lifecycle: string; pairingCode: string | null } | null> => result.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.every((result) => result.value?.lifecycle)).toBe(true);
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