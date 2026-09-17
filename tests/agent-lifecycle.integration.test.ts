import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db";
import { agents, tenants } from "../src/db/schema";
import { and, eq } from "drizzle-orm";
import { applyMigrations, closePool, hasTestDatabase } from "./helpers/pg";
import { transitionAgentLifecycle, LifecycleConflict } from "../src/lib/agent-lifecycle";
import { nanoid } from "../src/lib/nanoid";

const suite = describe.skipIf(!hasTestDatabase);

suite("Agent Lifecycle", () => {
  beforeAll(async () => { await applyMigrations(); });
  afterAll(async () => { await closePool(); });

  it("serializes retired versus disabled so retired cannot be overwritten", async () => {
    const tenantId = `tenant_agent_lifecycle_${nanoid(8)}`;
    const agentId = `agent_lifecycle_${nanoid(8)}`;
    await db.insert(tenants).values({ id: tenantId, name: "Agent Lifecycle Test" });
    await db.insert(agents).values({ id: agentId, tenantId, name: "Agent", lifecycle: "active", status: "online" });

    const [retired, disabled] = await Promise.allSettled([
      transitionAgentLifecycle(agentId, "retired", tenantId),
      transitionAgentLifecycle(agentId, "disabled", tenantId),
    ]);

    const row = await db.query.agents.findFirst({ where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)) });
    expect(row!.lifecycle).toBe("retired");
    expect(retired.status).toBe("fulfilled");
    expect(retired.status === "fulfilled" ? retired.value.lifecycle : null).toBe("retired");
    if (disabled.status === "fulfilled") {
      throw new Error("disabled transition must not commit after retirement");
    }
    expect(disabled.reason).toBeInstanceOf(LifecycleConflict);
  });
});