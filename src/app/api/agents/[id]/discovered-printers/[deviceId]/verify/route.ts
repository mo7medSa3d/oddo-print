import { NextResponse } from "next/server";
import { db } from "../../../../../../../db";
import { discoveredDevices } from "../../../../../../../db/schema";
import { validateWorkspaceManager } from "../../../../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../../../../lib/authorization";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../../../../../lib/manager-mutation-authorization";
import { requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../../../../../../../lib/tenant-guard";
import { discoveryObservationFingerprint } from "../../../../../../../lib/discovery-observation";
import { and, eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Approve exactly the observation displayed by discovery GET, not merely a
 * mutable Agent-provided device id. The client MUST send the GET row's
 * observationFingerprint as a strong `If-Match: "<hex>"` header.
 * A rescan/changed endpoint yields HTTP 409 and requires a fresh GET.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; deviceId: string }> }) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.manage"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const ifMatch = req.headers.get("If-Match");
  if (!ifMatch) return NextResponse.json({ error: "PRECONDITION_REQUIRED: reload discovery and submit its observationFingerprint in If-Match", code: "PRECONDITION_REQUIRED" }, { status: 428 });
  const parsed = /^"([a-f0-9]{64})"$/.exec(ifMatch);
  if (!parsed) return NextResponse.json({ error: "If-Match must be a single, strong quoted discovery fingerprint", code: "INVALID_OBSERVATION_FINGERPRINT" }, { status: 400 });

  const { id: agentId, deviceId } = await params;
  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Agent lifecycle and discovery row are locked in the same order as the
      // provisioning route. Discovery upsert takes a row lock on the device;
      // it cannot replace the reviewed observation while we authorize it.
      const agentsLocked = await tx.execute(sql`
        SELECT id, lifecycle FROM agents
        WHERE id = ${agentId} AND tenant_id = ${claims.tenantId}
        FOR UPDATE
      `);
      const agent = agentsLocked.rows[0] as { id?: string; lifecycle?: string } | undefined;
      if (!agent?.id) return { kind: "agent_not_found" as const };
      if (agent.lifecycle !== "active") return { kind: "agent_not_active" as const };

      const locked = await tx.execute(sql`
        SELECT id FROM discovered_devices
        WHERE id = ${deviceId} AND agent_id = ${agentId} AND tenant_id = ${claims.tenantId}
        FOR UPDATE
      `);
      if (locked.rows.length !== 1) return { kind: "not_found" as const };
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireManagerActorInTransaction(tx, claims, "printers.manage");

      const device = await tx.query.discoveredDevices.findFirst({
        where: and(eq(discoveredDevices.id, deviceId), eq(discoveredDevices.agentId, agentId), eq(discoveredDevices.tenantId, claims.tenantId)),
      });
      if (!device) return { kind: "not_found" as const };
      if (discoveryObservationFingerprint(device) !== parsed[1]) return { kind: "observation_changed" as const };
      if (device.candidateStatus === "provisioned") return { kind: "provisioned" as const };
      if (device.verification === "verified" && device.candidateStatus === "verified") return { kind: "already" as const };
      if (device.candidateStatus !== "discovered" || device.verification !== "candidate") return { kind: "state_changed" as const };

      const updated = await tx.update(discoveredDevices)
        .set({ verification: "verified", candidateStatus: "verified", updatedAt: sql`now()` })
        .where(and(
          eq(discoveredDevices.id, deviceId), eq(discoveredDevices.agentId, agentId), eq(discoveredDevices.tenantId, claims.tenantId),
          eq(discoveredDevices.candidateStatus, "discovered"), eq(discoveredDevices.verification, "candidate"),
        ))
        .returning({ id: discoveredDevices.id });
      return updated.length === 1 ? { kind: "verified" as const } : { kind: "state_changed" as const };
    });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError || error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  if (result.kind === "agent_not_found") return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (result.kind === "agent_not_active") return NextResponse.json({ error: "Agent is not active" }, { status: 409 });
  if (result.kind === "not_found") return NextResponse.json({ error: "Device not found" }, { status: 404 });
  if (result.kind === "provisioned") return NextResponse.json({ error: "Device is already provisioned" }, { status: 409 });
  if (result.kind === "observation_changed") return NextResponse.json({ error: "DISCOVERY_OBSERVATION_CHANGED: reload discovery before approving this device", code: "DISCOVERY_OBSERVATION_CHANGED" }, { status: 409 });
  if (result.kind === "state_changed") return NextResponse.json({ error: "Device state changed concurrently; reload and retry" }, { status: 409 });
  if (result.kind === "already") return NextResponse.json({ ok: true, already: true, deviceId });
  return NextResponse.json({ ok: true, verified: true, deviceId });
}
