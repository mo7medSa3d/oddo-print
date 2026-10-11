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
import { expireStaleAgentDiscovery } from "../../../../lib/discovery-session-expiry";

export const dynamic = "force-dynamic";
const MAX_DISCOVERY_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_DEVICES = 1000;
const DISCOVERY_INSERT_BATCH = 250;

export async function GET(req: Request) {
  const agent = await validateAgent(req.headers.get("Authorization"));
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (agent.lifecycle !== "active") return NextResponse.json({ error: `Agent is ${agent.lifecycle}` }, { status: 409 });
  await expireStaleAgentDiscovery((query) => db.execute(query), agent.tenantId, agent.id);
  const rows = await db.query.discoverySessions.findMany({ where: and(eq(discoverySessions.agentId, agent.id), eq(discoverySessions.tenantId, agent.tenantId), eq(discoverySessions.status, "running")), orderBy: [desc(discoverySessions.createdAt)], limit: 5 });
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
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const bodyRecord = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const discoveryId = typeof bodyRecord.discoveryId === "string" ? bodyRecord.discoveryId : null;
  const status = typeof bodyRecord.status === "string" ? bodyRecord.status : null;
  if (!status || !["running", "completed", "partial", "failed", "cancelled"].includes(status)) {
    return NextResponse.json({ error: "Invalid discovery report status" }, { status: 400 });
  }
  const chunkIndex = bodyRecord.chunkIndex;
  const chunkCount = bodyRecord.chunkCount;
  const hasChunk = chunkIndex !== undefined || chunkCount !== undefined;
  const isChunkOrdinal = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
  let chunkIndexValue: number | undefined;
  let chunkCountValue: number | undefined;
  if (hasChunk) {
    if (!isChunkOrdinal(chunkIndex) || !isChunkOrdinal(chunkCount)
      || chunkCount < 1 || chunkCount > 128
      || chunkIndex < 0 || chunkIndex >= chunkCount) {
      return NextResponse.json({ error: "Invalid discovery chunk sequence" }, { status: 400 });
    }
    chunkIndexValue = chunkIndex;
    chunkCountValue = chunkCount;
  }
  if (chunkIndexValue !== undefined && chunkCountValue !== undefined
    && (chunkIndexValue < chunkCountValue - 1 ? status !== "running" : status === "running")) {
    // A terminal first/middle page would close the row while more pages are
    // still in flight. The last page must always resolve a terminal outcome.
    return NextResponse.json({ error: "Only the final discovery chunk may be terminal" }, { status: 400 });
  }
  const totalCandidates = bodyRecord.totalCandidates;
  if (totalCandidates !== undefined && (!Number.isSafeInteger(totalCandidates)
    || (totalCandidates as number) < 0 || (totalCandidates as number) > 32_000)) {
    return NextResponse.json({ error: "Invalid discovery candidate count" }, { status: 400 });
  }
  const devices: unknown[] = Array.isArray(bodyRecord.devices) ? bodyRecord.devices : [];
  const errorsResult = z.array(z.string().max(2048)).max(64).safeParse(bodyRecord.errors ?? []);
  if (!errorsResult.success) return NextResponse.json({ error: "Invalid discovery source errors" }, { status: 400 });
  const sourceErrors = errorsResult.data;
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
  // A page's content must be the same across retries. A page index alone
  // cannot distinguish a lost HTTP ACK from an Agent restart/re-scan that
  // reordered devices while using the same discovery session id.
  const chunkDigest = chunkIndexValue !== undefined
    ? createHash("sha256").update(JSON.stringify(bodyRecord)).digest("hex")
    : null;
  const result = await db.transaction(async (tx) => {
    // Acquire resources in the same order as discovery-start and Agent
    // lifecycle writers: Agent -> Tenant -> Session -> Device. Otherwise a
    // report could hold the session while waiting for an Agent FK key-share
    // lock, as a manager holds that Agent while expiring this session.
    const lockedAgent = await tx.execute(sql`
      SELECT id, lifecycle FROM agents
      WHERE id = ${agent.id} AND tenant_id = ${agent.tenantId}
      FOR SHARE
    `);
    const agentRow = lockedAgent.rows[0] as { id?: string; lifecycle?: string } | undefined;
    if (!agentRow?.id || agentRow.lifecycle !== "active") {
      return { kind: "agent_inactive" as const };
    }
    await requireActiveTenantInTransaction(tx, agent.tenantId);
    // Serialize reporting against manager cancellation on the discovery session row.
    // Once this lock is held, the running-state check and all device/status writes
    // form one lifecycle decision: either the report lands before cancellation,
    // or cancellation wins and no late device report is accepted.
    const lockedSession = await tx.execute(sql`
      SELECT id, status, stats
      FROM discovery_sessions
      WHERE id = ${discoveryId}
        AND agent_id = ${agent.id}
        AND tenant_id = ${agent.tenantId}
      FOR UPDATE
    `);
    const currentSession = lockedSession.rows[0] as { id?: string; status?: string; stats?: unknown } | undefined;
    if (!currentSession?.id) return { kind: "not_found" as const };
    const previousStats = currentSession.stats && typeof currentSession.stats === "object" && !Array.isArray(currentSession.stats)
      ? currentSession.stats as Record<string, unknown> : {};
    const acceptedChunks = Array.isArray(previousStats.acceptedChunks)
      ? previousStats.acceptedChunks.filter((v): v is number => Number.isInteger(v) && typeof v === "number" && v >= 0 && v < 128)
      : [];
    if (chunkCountValue !== undefined && previousStats.chunkCount !== undefined && previousStats.chunkCount !== chunkCountValue) {
      return { kind: "chunk_conflict" as const };
    }
    // A gateway commit followed by a lost HTTP response must be replay-safe.
    // In-flight sessions from the earlier (index-only) schema may have no
    // digests; accept those for compatibility during their short lifetime.
    const chunkDigests = Array.isArray(previousStats.chunkDigests)
      ? previousStats.chunkDigests.map((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "")
      : [];
    if (chunkIndexValue !== undefined && acceptedChunks.includes(chunkIndexValue)) {
      const originalDigest = chunkDigests[chunkIndexValue];
      if (originalDigest && originalDigest !== chunkDigest) {
        return { kind: "chunk_replay_changed" as const };
      }
      // Also accept an identical replay of the final committed page after
      // the session has become terminal without writing devices or counters.
      return { kind: "ok" as const, insertedCount: 0, updatedCount: 0 };
    }
    if (currentSession.status !== "running") {
      return { kind: "not_running" as const, status: currentSession.status ?? "unknown" };
    }
    if (chunkIndexValue !== undefined && acceptedChunks.length !== chunkIndexValue) {
      return { kind: "chunk_conflict" as const };
    }

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
              // Preserve the provisioned runtime link as history, but invalidate
              // operator approval when the authorized destination/capabilities change.
              candidateStatus: sql`CASE WHEN ${sql`ROW(${discoveredDevices.protocol}, ${discoveredDevices.ipAddress}, ${discoveredDevices.port}, ${discoveredDevices.uri}, ${discoveredDevices.spoolerName}, ${discoveredDevices.transport}, ${discoveredDevices.deviceClass}, ${discoveredDevices.capabilities}, ${discoveredDevices.deviceName}, ${discoveredDevices.model}, ${discoveredDevices.hostname}, ${discoveredDevices.manufacturer}, ${discoveredDevices.serialNumber}) IS DISTINCT FROM ROW(excluded.protocol, excluded.ip_address, excluded.port, excluded.uri, excluded.spooler_name, excluded.transport, excluded.device_class, excluded.capabilities, excluded.device_name, excluded.model, excluded.hostname, excluded.manufacturer, excluded.serial_number)`} THEN 'discovered' ELSE ${discoveredDevices.candidateStatus} END`,
              verification: sql`CASE WHEN ${sql`ROW(${discoveredDevices.protocol}, ${discoveredDevices.ipAddress}, ${discoveredDevices.port}, ${discoveredDevices.uri}, ${discoveredDevices.spoolerName}, ${discoveredDevices.transport}, ${discoveredDevices.deviceClass}, ${discoveredDevices.capabilities}, ${discoveredDevices.deviceName}, ${discoveredDevices.model}, ${discoveredDevices.hostname}, ${discoveredDevices.manufacturer}, ${discoveredDevices.serialNumber}) IS DISTINCT FROM ROW(excluded.protocol, excluded.ip_address, excluded.port, excluded.uri, excluded.spooler_name, excluded.transport, excluded.device_class, excluded.capabilities, excluded.device_name, excluded.model, excluded.hostname, excluded.manufacturer, excluded.serial_number)`} THEN 'candidate' ELSE ${discoveredDevices.verification} END`,
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

    const countStat = (name: string) => typeof previousStats[name] === "number"
      && Number.isSafeInteger(previousStats[name]) && (previousStats[name] as number) >= 0
      ? previousStats[name] as number : 0;
    const totalSkipped = countStat("skipped") + skippedDevices.length;
    const mergedErrors = [...(Array.isArray(previousStats.errors)
      ? previousStats.errors.filter((e): e is string => typeof e === "string") : []), ...sourceErrors].slice(0, 64);
    const effectiveStatus =
      (totalSkipped > 0 || mergedErrors.length > 0) && status === "completed" ? "partial" : status;
    // Each accepted chunk updates the session under its row lock. Counters and
    // completion status survive an Agent restart/retry instead of reflecting
    // only the last chunk of a paginated discovery report.
    // Keep indexes aligned when continuing a pre-digest session from an older
    // Agent/Gateway version. Appending at acceptedChunks.length would store a
    // later page's digest at index zero, falsely rejecting a legacy retry.
    const nextChunkDigests = [...chunkDigests];
    const acceptedChunkIndex = chunkIndexValue;
    if (acceptedChunkIndex !== undefined && chunkDigest !== null) {
      while (nextChunkDigests.length <= acceptedChunkIndex) nextChunkDigests.push("");
      nextChunkDigests[acceptedChunkIndex] = chunkDigest;
    }
    const nextStats = {
      candidates: typeof totalCandidates === "number" ? totalCandidates : countStat("candidates") + devices.length,
      inserted: countStat("inserted") + insertedCount,
      updated: countStat("updated") + updatedCount,
      skipped: totalSkipped,
      errors: mergedErrors,
      ...(acceptedChunkIndex !== undefined && chunkCountValue !== undefined ? { chunkCount: chunkCountValue, acceptedChunks: [...acceptedChunks, acceptedChunkIndex], chunkDigests: nextChunkDigests } : {}),
    };
    const terminal = ["completed", "partial", "failed", "cancelled"].includes(effectiveStatus);
    await tx.update(discoverySessions)
      .set({
        ...(terminal ? { status: effectiveStatus, completedAt: sql`now()` } : {}),
        updatedAt: sql`now()`,
        stats: nextStats,
      })
      .where(and(eq(discoverySessions.id, discoveryId), eq(discoverySessions.agentId, agent.id), eq(discoverySessions.tenantId, agent.tenantId)));
    return { kind: "ok" as const, insertedCount, updatedCount };
  });

  if (result.kind === "not_found") return NextResponse.json({ error: "Discovery not found" }, { status: 404 });
  if (result.kind === "agent_inactive") return NextResponse.json({ error: "Agent is no longer active" }, { status: 409 });
  if (result.kind === "chunk_replay_changed") return NextResponse.json({ error: "Discovery page changed after its acknowledgment; start a new scan", code: "DISCOVERY_CHUNK_REPLAY_CHANGED" }, { status: 409 });
  if (result.kind === "not_running") return NextResponse.json({ error: `Discovery already ${result.status}` }, { status: 409 });
  if (result.kind === "chunk_conflict") return NextResponse.json({ error: "Discovery chunks must arrive in order for the same session", code: "DISCOVERY_CHUNK_CONFLICT" }, { status: 409 });
  return NextResponse.json({ ok: true, inserted: result.insertedCount, updated: result.updatedCount, skipped: skippedDevices, verification: "candidate-only" });
}