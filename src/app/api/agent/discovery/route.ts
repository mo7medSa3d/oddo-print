import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { discoverySessions, discoveredDevices } from "../../../../db/schema";
import { validateAgent } from "../../../../lib/agent-auth";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "../../../../lib/nanoid";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { isPrivateNetworkAddress } from "../../../../lib/network-address";
import { requireActiveTenantInTransaction } from "../../../../lib/tenant-guard";

export const dynamic = "force-dynamic";
const MAX_DISCOVERY_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_DEVICES = 1000;
const DISCOVERY_INSERT_BATCH = 250;

export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  const rows = await db.query.discoverySessions.findMany({ where: and(eq(discoverySessions.agentId, agent.id), eq(discoverySessions.status, "running")), orderBy: [desc(discoverySessions.createdAt)], limit: 5 });
  return NextResponse.json(rows);
}

const deviceSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  stableId: z.string().min(1).max(120).optional(),
  source: z.array(z.string().max(64)).max(32).optional(),
  protocol: z.string().min(1).max(32).optional(),
  ipAddress: z.string().max(45).optional(),
  hostname: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  uri: z.string().max(1024).optional(),
  deviceName: z.string().max(255).optional(),
  spoolerName: z.string().max(255).optional(),
  deviceClass: z.enum(["thermal", "laser", "inkjet", "label", "other", "unknown"]).optional(),
  transport: z.string().max(32).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(120).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  verification: z.enum(["candidate", "verified"]).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  rawMetadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export async function POST(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  if (hasBodyOverLimit(req, MAX_DISCOVERY_BODY_BYTES)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const bodyRecord = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const discoveryId = typeof bodyRecord.discoveryId === "string" ? bodyRecord.discoveryId : null;
  const status = typeof bodyRecord.status === "string" ? bodyRecord.status : null;
  const devices: unknown[] = Array.isArray(bodyRecord.devices) ? bodyRecord.devices : [];
  if (!discoveryId) return NextResponse.json({ error: "discoveryId required" }, { status: 400 });
  if (devices.length > MAX_DISCOVERY_DEVICES) return NextResponse.json({ error: `Too many devices in one discovery report; maximum is ${MAX_DISCOVERY_DEVICES}` }, { status: 413 });

  const parsedDevices = [] as Array<ReturnType<typeof deviceSchema.parse>>;
  const skippedDevices: Array<{ id: string; reason: string }> = [];
  for (const raw of devices) {
    const parsed = deviceSchema.safeParse(raw);
    const rawId = raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).id === "string"
      ? String((raw as Record<string, unknown>).id)
      : "(unknown)";
    if (!parsed.success) {
      skippedDevices.push({ id: rawId, reason: `invalid_device: ${parsed.error.issues[0]?.message ?? "invalid payload"}` });
      continue;
    }
    const ip = parsed.data.ipAddress;
    if (ip && !isPrivateNetworkAddress(ip)) {
      skippedDevices.push({ id: parsed.data.id ?? rawId, reason: "invalid_ip: device IP must be private or link-local" });
      continue;
    }
    parsedDevices.push(parsed.data);
  }

  if (devices.length > 0 && parsedDevices.length === 0) {
    return NextResponse.json(
      { error: skippedDevices[0]?.reason ?? "No valid discovery devices were supplied" },
      { status: 400 },
    );
  }

  function identityKeyForDevice(d: ReturnType<typeof deviceSchema.parse>): string | null {
    const supplied = typeof d.stableId === "string" ? d.stableId.trim() : "";
    if (supplied) return supplied;
    const explicitId = typeof d.id === "string" ? d.id.trim() : "";
    if (explicitId) return explicitId;
    const fingerprint = [
      d.protocol ?? "",
      d.ipAddress ?? "",
      d.port ?? "",
      d.uri ?? "",
      d.spoolerName ?? "",
      d.serialNumber ?? "",
      d.hostname ?? "",
      d.manufacturer ?? "",
      d.model ?? "",
    ].map(String).join("\u001f").trim();
    return fingerprint.replace(/\u001f/g, "").trim() ? createHash("sha256").update(fingerprint).digest("hex") : null;
  }

  // Discovery is observation, not authorization. Approval is handled by the
  // manager endpoint before a discovered device can become a runtime printer.
  // Keep the report bounded and batch writes so one authenticated Agent cannot
  // force thousands of sequential database round trips in a single request.
  // identityKey is stable across repeated scans for the same Agent. The
  // database uniqueness boundary is tenant+agent+identity, so two Agents can
  // legitimately observe similar hardware without colliding.
  const rows = parsedDevices.map((d) => ({
    id: typeof d.id === "string" && d.id ? d.id : `dev_${nanoid(10)}`,
    identityKey: identityKeyForDevice(d),
    discoveryId,
    agentId: agent.id,
    source: d.source ?? [],
    protocol: d.protocol ?? "unknown",
    ipAddress: d.ipAddress ?? null,
    hostname: d.hostname ?? null,
    port: d.port ?? null,
    uri: d.uri ?? null,
    deviceName: d.deviceName ?? null,
    spoolerName: d.spoolerName ?? null,
    deviceClass: d.deviceClass ?? "unknown",
    transport: d.transport ?? null,
    manufacturer: d.manufacturer ?? null,
    model: d.model ?? null,
    serialNumber: d.serialNumber ?? null,
    confidence: "low" as const,
    verification: "candidate" as const,
    capabilities: d.capabilities ?? null,
    rawMetadata: d.rawMetadata ?? null,
    tenantId: agent.tenantId,
  }));
  const result = await db.transaction(async (tx) => {
    // Serialize reporting against manager cancellation on the discovery session row.
    // Once this lock is held, the running-state check and all device/status writes
    // form one lifecycle decision: either the report lands before cancellation,
    // or cancellation wins and no late device report is accepted.
    const lockedSession = await tx.execute(sql`
      SELECT id, status
      FROM discovery_sessions
      WHERE id = ${discoveryId}
        AND agent_id = ${agent.id}
        AND tenant_id = ${agent.tenantId}
      FOR UPDATE
    `);
    const currentSession = lockedSession.rows[0] as { id?: string; status?: string } | undefined;
    if (!currentSession?.id) return { kind: "not_found" as const };
    if (currentSession.status !== "running") return { kind: "not_running" as const, status: currentSession.status ?? "unknown" };

    await requireActiveTenantInTransaction(tx, agent.tenantId);

    let insertedCount = 0;
    let updatedCount = 0;

    for (let i = 0; i < rows.length; i += DISCOVERY_INSERT_BATCH) {
      const batch = rows.slice(i, i + DISCOVERY_INSERT_BATCH);
      // A single INSERT ... ON CONFLICT cannot update the same target row twice.
      // Collapse duplicate identities inside one report before the database upsert.
      const identityRows = Array.from(
        new Map(
          batch.filter((row) => row.identityKey).map((row) => [row.identityKey, row]),
        ).values(),
      );
      const anonymousRows = batch.filter((row) => !row.identityKey);

      if (anonymousRows.length > 0) {
        const inserted = await tx.insert(discoveredDevices)
          .values(anonymousRows)
          .onConflictDoNothing({ target: [discoveredDevices.tenantId, discoveredDevices.id] })
          .returning({ id: discoveredDevices.id });
        insertedCount += inserted.length;
      }

      if (identityRows.length > 0) {
        const upserted = await tx.insert(discoveredDevices)
          .values(identityRows)
          .onConflictDoUpdate({
            target: [discoveredDevices.tenantId, discoveredDevices.agentId, discoveredDevices.identityKey],
            set: {
              discoveryId: sql`excluded.discovery_id`,
              source: sql`excluded.source`,
              protocol: sql`excluded.protocol`,
              ipAddress: sql`excluded.ip_address`,
              hostname: sql`excluded.hostname`,
              port: sql`excluded.port`,
              uri: sql`excluded.uri`,
              deviceName: sql`excluded.device_name`,
              spoolerName: sql`excluded.spooler_name`,
              deviceClass: sql`excluded.device_class`,
              transport: sql`excluded.transport`,
              manufacturer: sql`excluded.manufacturer`,
              model: sql`excluded.model`,
              serialNumber: sql`excluded.serial_number`,
              capabilities: sql`excluded.capabilities`,
              rawMetadata: sql`excluded.raw_metadata`,
              lastSeenAt: sql`now()`,
              updatedAt: sql`now()`,
            },
          })
          .returning({ id: discoveredDevices.id, inserted: sql<boolean>`xmax = 0` });
        insertedCount += upserted.filter((row) => row.inserted).length;
        updatedCount += upserted.filter((row) => !row.inserted).length;
      }
    }

    const effectiveStatus =
      skippedDevices.length > 0 && status === "completed"
        ? "partial"
        : status;

    if (effectiveStatus && ["completed", "partial", "failed", "cancelled"].includes(effectiveStatus)) {
      await tx.update(discoverySessions)
        .set({
          status: effectiveStatus,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
          stats: {
            candidates: devices.length,
            inserted: insertedCount,
            updated: updatedCount,
            skipped: skippedDevices.length,
          },
        })
        .where(and(eq(discoverySessions.id, discoveryId), eq(discoverySessions.agentId, agent.id), eq(discoverySessions.tenantId, agent.tenantId)));
    }
    return { kind: "ok" as const, insertedCount, updatedCount };
  });

  if (result.kind === "not_found") return NextResponse.json({ error: "Discovery not found" }, { status: 404 });
  if (result.kind === "not_running") return NextResponse.json({ error: `Discovery already ${result.status}` }, { status: 409 });
  return NextResponse.json({ ok: true, inserted: result.insertedCount, updated: result.updatedCount, skipped: skippedDevices, verification: "candidate-only" });
}