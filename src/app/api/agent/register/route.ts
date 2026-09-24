import { isTenantBillingError, liveTenantSubscriptionPredicate } from "../../../../lib/entitlements";
import { requireActiveTenantInTransaction } from "../../../../lib/tenant-guard";
import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { sql } from "drizzle-orm";
import { generateSecret, hashPairingCode, hashSecret, isValidPairingCode } from "../../../../lib/agent-auth";
import {
  clientIpFrom,
  reservePairingAttempt,
} from "../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MAX_REGISTRATION_BODY_BYTES = 64 * 1024;

const registrationSchema = z.object({
  pairingCode: z.string().trim().min(6).max(6).refine(isValidPairingCode, "pairingCode must be exactly 6 characters from the approved alphabet").optional(),
  pairing_code: z.string().trim().min(6).max(6).refine(isValidPairingCode, "pairingCode must be exactly 6 characters from the approved alphabet").optional(),
  hostname: z.string().trim().max(255).optional(),
  client_version: z.string().trim().max(100).optional(),
  clientVersion: z.string().trim().max(100).optional(),
  platform: z.string().trim().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().trim().min(1).max(120).optional(),
  agent_id: z.string().trim().min(1).max(120).optional(),
}).strict().refine((data) => Boolean(data.pairingCode || data.pairing_code), {
  message: "pairing_code or pairingCode is required",
}).refine((data) => {
  if (data.pairingCode && data.pairing_code && data.pairingCode.toUpperCase() !== data.pairing_code.toUpperCase()) {
    return false;
  }
  if (data.agentId && data.agent_id && data.agentId !== data.agent_id) {
    return false;
  }
  if (data.clientVersion && data.client_version && data.clientVersion !== data.client_version) {
    return false;
  }
  return true;
}, {
  message: "Conflicting alias fields provided",
});

export async function POST(req: Request) {
  try {
    if (hasBodyOverLimit(req, MAX_REGISTRATION_BODY_BYTES)) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (body && typeof body === "object" && "metadata" in body) {
      const metaObj = (body as { metadata?: unknown }).metadata;
      if (metaObj && JSON.stringify(metaObj).length > 32_768) {
        return NextResponse.json({ error: "metadata exceeds 32KB" }, { status: 400 });
      }
    }

    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({
        error: parsed.error.issues[0]?.message ?? "pairingCode must be exactly 6 characters from the approved alphabet",
      }, { status: 400 });
    }

    const rawCode = (parsed.data.pairing_code || parsed.data.pairingCode)!;
    const normalizedCode = rawCode.trim().toUpperCase();
    const hashedCode = hashPairingCode(normalizedCode);
    const ip = clientIpFrom(req);

    let decision: Awaited<ReturnType<typeof reservePairingAttempt>>;
    try {
      decision = await reservePairingAttempt(ip);
      if (!decision.allowed) {
        const response = NextResponse.json({ error: "Too many pairing attempts. Try again later." }, { status: 429 });
        response.headers.set("Retry-After", String(decision.retryAfterSec));
        return response;
      }
    } catch {
      return NextResponse.json({ error: "Registration temporarily unavailable" }, { status: 503 });
    }

    const targetAgentId = parsed.data.agent_id || parsed.data.agentId;

    const outcome = await db.transaction(async (tx) => {
      const targetAgentPredicate = targetAgentId
        ? sql`AND id = ${targetAgentId}`
        : sql``;
      const agentResult = await tx.execute(sql`
        SELECT id, tenant_id AS "tenantId", metadata
        FROM agents
        WHERE pairing_code_hash = ${hashedCode}
          AND pairing_code_hash IS NOT NULL
          AND pairing_code_expires_at > clock_timestamp()
          AND lifecycle = 'active'
          ${targetAgentPredicate}
        FOR UPDATE
      `);
      const agent = agentResult.rows[0] as {
        id: string;
        tenantId: string;
        metadata?: Record<string, unknown> | null;
      } | undefined;

      if (!agent) {
        return { kind: "not_found" as const };
      }

      // The agent row is already locked. Fence tenant lifecycle before
      // consuming the one-time pairing code or minting a new secret.
      await requireActiveTenantInTransaction(tx, agent.tenantId);

      // Pairing grants a fresh runtime credential, so subscription entitlement
      // must be checked at the same database boundary as consuming the
      // one-time code. Past-due remains usable; active/trialing require a live
      // current period unless Stripe has not recorded an end yet.
      const billingResult = await tx.execute(sql`
        SELECT 1
        FROM tenant_subscriptions ts
        WHERE ${liveTenantSubscriptionPredicate(sql`${agent.tenantId}`)}
        FOR UPDATE
      `);
      if (billingResult.rows.length !== 1) {
        return { kind: "billing_required" as const };
      }

      const meta: Record<string, unknown> = {
        ...(agent.metadata ?? {}),
        ...(parsed.data.metadata ?? {}),
        ...(parsed.data.hostname ? { hostname: parsed.data.hostname } : {}),
        ...(parsed.data.client_version || parsed.data.clientVersion ? { version: parsed.data.client_version || parsed.data.clientVersion } : {}),
        ...(parsed.data.platform ? { os: parsed.data.platform } : {}),
      };

      const secret = generateSecret();
      const updated = await tx.execute(sql`
        UPDATE agents
        SET pairing_code_hash = NULL,
            pairing_code_expires_at = NULL,
            secret = ${hashSecret(secret)},
            status = 'online',
            metadata = ${JSON.stringify(meta)}::jsonb,
            last_seen_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE id = ${agent.id}
          AND tenant_id = ${agent.tenantId}
          AND pairing_code_hash = ${hashedCode}
          AND lifecycle = 'active'
          AND pairing_code_expires_at > clock_timestamp()
        RETURNING id
      `);

      if (updated.rows.length !== 1) {
        return { kind: "consumed" as const };
      }

      return { kind: "paired" as const, agentId: agent.id, secret };
    });

    if (outcome.kind === "billing_required") {
      return NextResponse.json({
        error: "An active subscription is required before pairing agents.",
        code: "SUBSCRIPTION_REQUIRED",
      }, { status: 403 });
    }

    if (outcome.kind === "not_found") {
      if (decision.retryAfterSec) {
        const response = NextResponse.json({ error: "Too many pairing attempts. Try again later." }, { status: 429 });
        response.headers.set("Retry-After", String(decision.retryAfterSec));
        return response;
      }
      return NextResponse.json({ error: "Unknown, disabled, retired, or expired agent registration" }, { status: 400 });
    }

    if (outcome.kind === "consumed") {
      if (decision.retryAfterSec) {
        const response = NextResponse.json({ error: "Too many pairing attempts. Try again later." }, { status: 429 });
        response.headers.set("Retry-After", String(decision.retryAfterSec));
        return response;
      }
      return NextResponse.json({ error: "Pairing code was consumed or expired; retry with a fresh code" }, { status: 409 });
    }

    // Do not clear the IP pairing limiter after success. A valid pairing
    // should not reset the brute-force budget for subsequent codes.
    return NextResponse.json({
      agentId: outcome.agentId,
      agent_id: outcome.agentId,
      secret: outcome.secret,
      agent_secret: outcome.secret,
    }, { status: 200 });
  } catch (error) {
    if (isTenantBillingError(error)) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    logError("[agent/register] registration failed", { error: error });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
