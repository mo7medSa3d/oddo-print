import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantUsers, tenants, authRateLimits } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { validateWorkspaceManager, revokeLegacyManagerSessionInTransaction } from "../../../../lib/manager-auth";
import { verifyTenantSelectionToken, customerSessionCookie, customerRefreshCookie } from "../../../../lib/customer-auth";
import { issueSessionPairInTransaction, revokeSessionFamilyInTransaction, AuthenticationChangedError } from "../../../../lib/session-tokens";
import { writeAuditEvent } from "../../../../lib/audit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { clientIpFrom } from "../../../../lib/auth-rate-limit";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { tenantId?: unknown; selectionToken?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });

  const selectionToken = typeof body.selectionToken === "string" ? body.selectionToken.trim() : "";
  const claims = await validateWorkspaceManager(req);

  let userId: string | null = null;
  let isSelectionToken = false;
  let tokenJti: string | null = null;
  let credentialVersion: string | undefined;

  if (selectionToken) {
    const verified = await verifyTenantSelectionToken(selectionToken);
    if (!verified) return NextResponse.json({ error: "Invalid or expired workspace selection token" }, { status: 401 });
    userId = verified.userId;
    isSelectionToken = true;
    tokenJti = verified.jti;
    credentialVersion = verified.credentialVersion;
  } else if (claims?.userId) {
    userId = claims.userId;
  } else {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
      if (!isSelectionToken && claims) {
        // User lock serializes reset; family lock serializes logout/rotation.
        // Do not mint a replacement from a session revoked after preflight.
        if (claims.familyId) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claims.familyId}, 0))`);
          const source = await tx.execute(sql`
            SELECT id FROM refresh_tokens
            WHERE family_id = ${claims.familyId} AND user_id = ${userId}
              AND tenant_id = ${claims.tenantId} AND kind = ${claims.kind ?? "manager"}
              AND revoked_at IS NULL AND expires_at > clock_timestamp()
            FOR UPDATE
          `);
          if (source.rows.length === 0) throw new AuthenticationChangedError();
        } else {
          const source = await tx.execute(sql`
            SELECT jti FROM manager_sessions
            WHERE jti = ${claims.jti} AND user_id = ${userId}
              AND tenant_id = ${claims.tenantId} AND revoked_at IS NULL
              AND expires_at > clock_timestamp() FOR UPDATE
          `);
          if (source.rows.length === 0) throw new AuthenticationChangedError();
        }
      }
      if (isSelectionToken && tokenJti) {
        const consumed = await tx.insert(authRateLimits).values({
          key: `tsel_used_${tokenJti}`,
          windowStartedAt: sql`now()`,
          updatedAt: sql`now()`,
        }).onConflictDoNothing({ target: authRateLimits.key }).returning({ key: authRateLimits.key });
        if (consumed.length !== 1) {
          throw new Error("Selection token already used");
        }
      }

      const membership = await tx.query.tenantUsers.findFirst({
        where: and(eq(tenantUsers.userId, userId!), eq(tenantUsers.tenantId, tenantId)),
        columns: { tenantId: true, role: true },
      });
      if (!membership) throw new Error("Workspace not available");

      const tenant = await tx.query.tenants.findFirst({
        where: eq(tenants.id, tenantId),
        columns: { id: true, lifecycle: true },
      });
      if (!tenant || tenant.lifecycle !== "active") throw new Error("Workspace is suspended or unavailable");

      if (claims?.familyId) {
        await revokeSessionFamilyInTransaction(tx, claims.familyId, "tenant_selection");
      } else if (claims?.jti) {
        await revokeLegacyManagerSessionInTransaction(tx, claims.jti);
      }

      const session = await issueSessionPairInTransaction(
        tx,
        {
          kind: "customer",
          tenantId: membership.tenantId,
          userId: userId!,
          credentialVersion,
          role: membership.role as "owner" | "admin" | "operator" | "viewer" | "integration_admin" | "billing_admin",
        },
        {
          ipAddress: clientIpFrom(req),
          userAgent: req.headers.get("user-agent"),
        },
      );

      await writeAuditEvent({
        tenantId: membership.tenantId,
        actorType: "user",
        actorId: userId!,
        action: "tenant.selected",
      }, tx);

      return { membership, session };
    });

    const res = NextResponse.json({ ok: true, tenantId: result.membership.tenantId, role: result.membership.role });
    res.headers.set("Set-Cookie", customerSessionCookie(result.session));
    res.headers.append("Set-Cookie", customerRefreshCookie(result.session));
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    if (error instanceof AuthenticationChangedError) return NextResponse.json({ error: "Invalid or expired workspace selection token" }, { status: 401 });
    const message = error instanceof Error ? error.message : "Workspace selection failed";
    // Single-use-token replay is a client-state conflict, not an
    // authentication failure: 409 (mirrors agent/register's consumed-code
    // response) tells the client to restart selection.
    if (message === "Selection token already used") return NextResponse.json({ error: "Workspace selection token has already been used" }, { status: 409 });
    if (message === "Workspace not available" || message === "Workspace is suspended or unavailable") return NextResponse.json({ error: message }, { status: 403 });
    logError("tenant_selection_failed", { error: message });
    return NextResponse.json({ error: "Workspace selection failed" }, { status: 500 });
  }
}