import { randomBytes, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { validateAgent } from "../../../../lib/agent-auth";
import { captureEnabled, CAPTURE_MAX_ATTEMPTS, CAPTURE_MAX_PREVIEW_BYTES, readBoundedCaptureJSON, CaptureError } from "../../../../lib/e2e-capture";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { logError } from "../../../../lib/log";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const finalSchema = z.object({
  runId: z.string().regex(/^cap_[a-f0-9]{32}$/),
  claimToken: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["rendered_locally", "failed"]),
  pages: z.number().int().min(1).max(10).optional(),
  pdfSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  pdfBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
  previewJpeg: z.string().max(Math.ceil(CAPTURE_MAX_PREVIEW_BYTES * 4 / 3) + 8).optional(),
  errorCode: z.enum(["PDFIUM_FAILED", "INPUT_INVALID", "STORAGE_FAILED", "TIMED_OUT"]).optional(),
}).strict().superRefine((body, ctx) => {
  if (body.status === "rendered_locally") {
    if (!body.pages || !body.pdfSha256 || !body.pdfBytes) {
      ctx.addIssue({ code: "custom", message: "Rendered result requires PDFium evidence" });
    }
    if (body.errorCode) ctx.addIssue({ code: "custom", message: "Success cannot have error code" });
  } else if (body.pages || body.pdfSha256 || body.pdfBytes || body.previewJpeg) {
    ctx.addIssue({ code: "custom", message: "Failed result cannot carry success evidence" });
  }
  if (body.previewJpeg) {
    const bytes = Buffer.from(body.previewJpeg, "base64");
    if (bytes.length > CAPTURE_MAX_PREVIEW_BYTES || bytes.toString("base64") !== body.previewJpeg
      || !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      ctx.addIssue({ code: "custom", message: "Invalid JPEG preview" });
    }
  }
});

export async function GET(req: Request) {
  if (!captureEnabled()) return new Response(null, { status: 204, headers: NO_STORE });
  const agent = await validateAgent(req.headers.get("authorization"));
  if (!agent) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: NO_STORE });
  try {
    const claimToken = randomBytes(32).toString("hex");
    const claimHash = createHash("sha256").update(claimToken).digest("hex");
    const row = await db.transaction(async (tx) => {
      const tenant = await tx.execute(sql`SELECT id FROM tenants
        WHERE id=${agent.tenantId} AND lifecycle='active' FOR SHARE`);
      if (tenant.rows.length !== 1) return null;
      // Serialize per Agent and re-check both lifecycles under the same lock.
      const live = await tx.execute(sql`
        SELECT a.id FROM agents a JOIN tenants t ON t.id=a.tenant_id
        WHERE a.id=${agent.id} AND a.tenant_id=${agent.tenantId}
          AND a.lifecycle='active' AND a.status='online'
          AND t.lifecycle='active'
        FOR UPDATE OF a
      `);
      if (live.rows.length !== 1) return null;
      // Key deletion cascades captures: lock keys before expiring any rows.
      await tx.execute(sql`SELECT k.id FROM api_keys k
        WHERE k.tenant_id=${agent.tenantId} AND EXISTS (
          SELECT 1 FROM e2e_capture_runs c
          WHERE c.api_key_id=k.id AND c.tenant_id=${agent.tenantId}
            AND c.agent_id=${agent.id}
        ) ORDER BY k.id FOR UPDATE`);
      await tx.execute(sql`UPDATE e2e_capture_runs SET
        status='expired', payload_json=NULL, claim_token_hash=NULL,
        error_code='CAPTURE_TIMED_OUT', finished_at=now(), updated_at=now()
        WHERE agent_id=${agent.id} AND tenant_id=${agent.tenantId}
          AND status IN ('queued','claimed') AND
          (expires_at <= now() OR
            (status='claimed' AND attempts >= ${CAPTURE_MAX_ATTEMPTS}
              AND claimed_at < now() - interval '75 seconds'))
      `);
      // Keep only one test renderer per Agent, independent of print queue.
      const existing = await tx.execute(sql`
        SELECT 1 FROM e2e_capture_runs
        WHERE agent_id=${agent.id} AND tenant_id=${agent.tenantId}
          AND status='claimed' AND claimed_at > now() - interval '75 seconds'
        LIMIT 1
      `);
      if (existing.rows.length) return null;
      // A formerly valid installation key can be revoked after enqueue.
      // Never hand its document to the Agent after revocation/deactivation.
      const claimed = await tx.execute(sql`
        UPDATE e2e_capture_runs SET
          status='claimed', claim_token_hash=${claimHash}, claimed_at=now(),
          attempts=attempts+1, updated_at=now()
        WHERE id = (
          SELECT c.id FROM e2e_capture_runs c
          JOIN api_keys k ON k.id = c.api_key_id AND k.tenant_id = c.tenant_id
          WHERE c.tenant_id=${agent.tenantId} AND c.agent_id=${agent.id}
            AND k.revoked_at IS NULL AND k.read_only_until IS NULL
            AND k.odoo_enabled = true
            AND c.expires_at > now() AND c.attempts < ${CAPTURE_MAX_ATTEMPTS}
            AND (c.status='queued' OR
              (c.status='claimed' AND c.claimed_at < now() - interval '75 seconds'))
          ORDER BY c.created_at, c.id
          FOR UPDATE OF k SKIP LOCKED LIMIT 1
        )
        RETURNING id, payload_json, paper_mm
      `);
      return claimed.rows[0] as { id: string; payload_json: { type: "pdf" | "image"; encoding: string; data: string }; paper_mm: number } | undefined;
    });
    if (!row) return new Response(null, { status: 204, headers: NO_STORE });
    return NextResponse.json({
      runId: row.id, claimToken, payload: row.payload_json, paperMm: row.paper_mm,
      simulationOnly: true, physicalPrinterId: null,
    }, { status: 200, headers: NO_STORE });
  } catch (error) {
    logError("e2e.capture.claim_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: NO_STORE });
  }
}

export async function PATCH(req: Request) {
  if (!captureEnabled()) return NextResponse.json({ code: "CAPTURE_NOT_ENABLED" }, { status: 404, headers: NO_STORE });
  const agent = await validateAgent(req.headers.get("authorization"));
  if (!agent) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: NO_STORE });
  if (hasBodyOverLimit(req, 425 * 1024)) return NextResponse.json({ code: "RESULT_TOO_LARGE" }, { status: 413, headers: NO_STORE });
  let json: unknown;
  try { json = await readBoundedCaptureJSON(req, 425 * 1024); }
  catch (e) { return NextResponse.json({ code: e instanceof CaptureError ? e.code : "INVALID_JSON" }, { status: e instanceof CaptureError ? e.status : 400, headers: NO_STORE }); }
  const parsed = finalSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ code: "INVALID_RESULT" }, { status: 400, headers: NO_STORE });
  const body = parsed.data;
  const hash = createHash("sha256").update(body.claimToken).digest("hex");
  try {
    const accepted = await db.transaction(async (tx) => {
      const tenant = await tx.execute(sql`SELECT id FROM tenants
        WHERE id=${agent.tenantId} AND lifecycle='active' FOR SHARE`);
      if (tenant.rows.length !== 1) return { rows: [] };
      const runtime = await tx.execute(sql`SELECT id FROM agents
        WHERE id=${agent.id} AND tenant_id=${agent.tenantId}
          AND lifecycle='active' FOR SHARE`);
      if (runtime.rows.length !== 1) return { rows: [] };
      return tx.execute(sql`
      UPDATE e2e_capture_runs c SET
        status=${body.status}, payload_json=NULL, claim_token_hash=NULL,
        pages=${body.status === "rendered_locally" ? body.pages ?? null : null},
        pdf_sha256=${body.status === "rendered_locally" ? body.pdfSha256 ?? null : null},
        pdf_bytes=${body.status === "rendered_locally" ? body.pdfBytes ?? null : null},
        preview_jpeg=${body.status === "rendered_locally" ? body.previewJpeg ?? null : null},
        error_code=${body.status === "failed" ? body.errorCode ?? "PDFIUM_FAILED" : null},
        finished_at=now(), updated_at=now()
      WHERE id=${body.runId} AND tenant_id=${agent.tenantId}
        AND agent_id=${agent.id} AND status='claimed'
        AND claim_token_hash=${hash} AND expires_at > now()
        AND EXISTS (SELECT 1 FROM agents a
          JOIN tenants t ON t.id=a.tenant_id
          WHERE a.id=c.agent_id AND a.tenant_id=c.tenant_id
            AND a.lifecycle='active' AND t.lifecycle='active')
      RETURNING id
      `);
    });
    if (accepted.rows.length !== 1) {
      return NextResponse.json({ code: "STALE_CLAIM" }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json({
      ok: true, runId: body.runId, status: body.status, physicalPrinted: false,
    }, { headers: NO_STORE });
  } catch (error) {
    logError("e2e.capture.result_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: NO_STORE });
  }
}
