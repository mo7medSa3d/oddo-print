import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { e2eCaptureRuns } from "../db/schema";
import { validatePrintJobPayload } from "./payload";

/**
 * A separate, opt-in, tenant-scoped Odoo -> Gateway -> Agent simulation.
 * These records never reference a printer and never enter print_jobs, print
 * usage accounting, physical status reconciliation, WS jobs, or the spooler.
 */
export const captureEnabled = () => process.env.YASEIR_E2E_CAPTURE_ENABLED === "1";
export const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
export const CAPTURE_MAX_ACTIVE = 4;
export const CAPTURE_MAX_ATTEMPTS = 3;
export const CAPTURE_MAX_PREVIEW_BYTES = 256 * 1024;

/** Bound actual streamed bytes; Content-Length alone is attacker-controlled. */
export async function readBoundedCaptureJSON(req: Request, limit: number): Promise<unknown> {
  if (!req.body) throw new CaptureError("INVALID_JSON", 400);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new CaptureError("DOCUMENT_TOO_LARGE", 413);
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")); }
    catch { throw new CaptureError("INVALID_JSON", 400); }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
}

const bodySchema = z.object({
  agentId: z.string().regex(/^agt_[A-Za-z0-9_-]{8}$/),
  idempotencyKey: z.string().trim().min(16).max(150).regex(/^[a-zA-Z0-9._:-]+$/),
  paperMm: z.union([z.literal(0), z.literal(58), z.literal(80)]),
  payload: z.unknown(),
}).strict();

export type CaptureRequest = {
  agentId: string;
  idempotencyKey: string;
  paperMm: 0 | 58 | 80;
  payload: { type: "pdf" | "image"; encoding: "base64"; data: string };
  fingerprint: string;
};

export class CaptureError extends Error {
  constructor(readonly code: string, readonly status: number, message = code) {
    super(message);
  }
}

export function parseCaptureRequest(input: unknown): CaptureRequest {
  const parsed = bodySchema.safeParse(input);
  if (!parsed.success) throw new CaptureError("INVALID_REQUEST", 400);
  let payload: ReturnType<typeof validatePrintJobPayload>;
  try { payload = validatePrintJobPayload(parsed.data.payload); }
  catch { throw new CaptureError("INVALID_DOCUMENT", 400); }
  if ((payload.type !== "pdf" && payload.type !== "image") || payload.protocol || payload.peripherals) {
    throw new CaptureError("PDF_OR_JPEG_ONLY", 422);
  }
  const bytes = Buffer.from(payload.data, "base64");
  if (bytes.length < 1 || bytes.length > CAPTURE_MAX_BYTES) throw new CaptureError("DOCUMENT_TOO_LARGE", 413);
  if (payload.type === "pdf" && parsed.data.paperMm !== 0) {
    throw new CaptureError("PDF_SIZE_IS_EMBEDDED", 422);
  }
  const document = { type: payload.type, encoding: "base64" as const, data: payload.data };
  const fingerprint = createHash("sha256").update(JSON.stringify([
    parsed.data.agentId, parsed.data.paperMm, document,
  ])).digest("hex");
  return { agentId: parsed.data.agentId, paperMm: parsed.data.paperMm,
    idempotencyKey: parsed.data.idempotencyKey, payload: document, fingerprint };
}

type AuthenticatedIntegration = { id: string; tenantId: string; readOnly?: boolean };

export async function queueOdooCapture(auth: AuthenticatedIntegration, input: CaptureRequest) {
  if (!captureEnabled()) throw new CaptureError("CAPTURE_NOT_ENABLED", 404);
  if (auth.readOnly) throw new CaptureError("API_KEY_READ_ONLY", 409);
  return db.transaction(async (tx) => {
    // Fence tenant before credential/advisory/runtime locks, matching rotation.
    const tenant = await tx.execute(sql`
      SELECT id FROM tenants WHERE id = ${auth.tenantId} AND lifecycle = 'active' FOR SHARE
    `);
    if (tenant.rows.length !== 1) throw new CaptureError("TENANT_UNAVAILABLE", 403);
    // Global per-tenant budget is serialized to avoid a test-only data flood.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"e2e_capture:tenant:" + auth.tenantId}))`);
    const agent = await tx.execute(sql`
      SELECT id FROM agents WHERE id = ${input.agentId}
        AND tenant_id = ${auth.tenantId} AND lifecycle = 'active' FOR UPDATE
    `);
    if (agent.rows.length !== 1) throw new CaptureError("AGENT_NOT_FOUND", 404);
    const key = await tx.execute(sql`
      SELECT id FROM api_keys
      WHERE id = ${auth.id} AND tenant_id = ${auth.tenantId}
        AND revoked_at IS NULL AND read_only_until IS NULL AND odoo_enabled = true
      FOR UPDATE
    `);
    if (key.rows.length !== 1) throw new CaptureError("UNAUTHORIZED", 401);
    // Retention is per tenant, not a global deletion during a customer request.
    await tx.execute(sql`DELETE FROM e2e_capture_runs
      WHERE tenant_id = ${auth.tenantId} AND created_at < now() - interval '48 hours'`);
    const existing = await tx.query.e2eCaptureRuns.findFirst({
      where: and(eq(e2eCaptureRuns.tenantId, auth.tenantId),
        eq(e2eCaptureRuns.apiKeyId, auth.id),
        eq(e2eCaptureRuns.idempotencyKey, input.idempotencyKey)),
    });
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new CaptureError("IDEMPOTENCY_CONFLICT", 409);
      return { runId: existing.id, status: existing.status, reused: true };
    }
    const active = await tx.execute(sql`
      SELECT count(*)::integer AS total FROM e2e_capture_runs
      WHERE tenant_id = ${auth.tenantId} AND agent_id = ${input.agentId}
        AND status IN ('queued', 'claimed') AND expires_at > now()
    `);
    if (Number((active.rows[0] as { total?: number }).total ?? 0) >= CAPTURE_MAX_ACTIVE) {
      throw new CaptureError("CAPTURE_QUEUE_BUSY", 429);
    }
    // Simulation does not debit physical print quota, but has its own
    // bounded tenant rate limit to avoid unbounded result/thumb storage.
    const recent = await tx.execute(sql`
      SELECT COUNT(*)::integer AS total FROM e2e_capture_runs
      WHERE tenant_id = ${auth.tenantId}
        AND created_at > now() - interval '24 hours'
    `);
    if (Number((recent.rows[0] as { total?: number }).total ?? 0) >= 100) {
      throw new CaptureError("CAPTURE_DAILY_LIMIT", 429);
    }
    const id = "cap_" + randomBytes(16).toString("hex");
    const inserted = await tx.insert(e2eCaptureRuns).values({
      id, tenantId: auth.tenantId, agentId: input.agentId, apiKeyId: auth.id,
      idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint,
      paperMm: input.paperMm, status: "queued", payloadJson: input.payload,
    }).returning({ id: e2eCaptureRuns.id, status: e2eCaptureRuns.status });
    if (inserted.length !== 1) throw new CaptureError("CAPTURE_NOT_QUEUED", 500);
    return { runId: id, status: "queued", reused: false };
  });
}

export async function readOdooCapture(tenantId: string, apiKeyId: string, id: string) {
  // A report cannot leave its authenticated integration/tenant boundary.
  // Explicit expiration avoids calling an offline Agent forever.
  await db.update(e2eCaptureRuns).set({
    status: "expired", payloadJson: null, claimTokenHash: null,
    errorCode: "CAPTURE_TIMED_OUT", finishedAt: sql`now()`,
    updatedAt: sql`now()`,
  }).where(and(eq(e2eCaptureRuns.id, id),
    eq(e2eCaptureRuns.tenantId, tenantId), eq(e2eCaptureRuns.apiKeyId, apiKeyId),
    sql`${e2eCaptureRuns.status} IN ('queued', 'claimed')`,
    sql`${e2eCaptureRuns.expiresAt} <= now()`));
  const run = await db.query.e2eCaptureRuns.findFirst({
    where: and(eq(e2eCaptureRuns.id, id), eq(e2eCaptureRuns.tenantId, tenantId),
      eq(e2eCaptureRuns.apiKeyId, apiKeyId)),
  });
  if (!run) throw new CaptureError("NOT_FOUND", 404);
  return {
    runId: run.id, agentId: run.agentId, status: run.status,
    // Never call this a physical print or put it in print_jobs.
    outcome: run.status === "rendered_locally" ? "simulation_only" : null,
    physicalPrinted: false, pageCount: run.pages ?? null,
    pdfSha256: run.pdfSha256 ?? null, pdfBytes: run.pdfBytes ?? null,
    errorCode: run.errorCode ?? null,
    previewDataUri: run.status === "rendered_locally" && run.previewJpeg
      ? `data:image/jpeg;base64,${run.previewJpeg}` : null,
  };
}
