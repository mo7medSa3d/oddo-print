import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantUsers, tenants, authRateLimits } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { validateManager, managerCookieHeader } from "../../../../lib/manager-auth";
import { verifyTenantSelectionToken } from "../../../../lib/customer-auth";
import { writeAuditEvent } from "../../../../lib/audit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { createManagerSessionInTransaction, revokeManagerSessionInTransaction } from "../../../../lib/manager-session-tx";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { tenantId?: unknown; selectionToken?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });

  const selectionToken = typeof body.selectionToken === "string" ? body.selectionToken.trim() : "";
  const claims = await validateManager(req);

  let userId: string | null = null;
  let isSelectionToken = false;
  let tokenJti: string | null = null;

  if (selectionToken) {
    const verified = await verifyTenantSelectionToken(selectionToken);
    if (!verified) return NextResponse.json({ error: "Invalid or expired workspace selection token" }, { status: 401 });
    userId = verified.userId;
    isSelectionToken = true;
    tokenJti = verified.jti;
  } else if (claims?.userId) {
    userId = claims.userId;
  } else {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await db.transaction(async (tx) => {
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

      if (claims?.jti) await revokeManagerSessionInTransaction(tx, claims.jti);

      const session = await createManagerSessionInTransaction(tx, membership.tenantId, {
        userId: userId!,
        role: membership.role as Parameters<typeof createManagerSessionInTransaction>[2]["role"],
      });

      await writeAuditEvent({
        tenantId: membership.tenantId,
        actorType: "user",
        actorId: userId!,
        action: "tenant.selected",
      }, tx);

      return { membership, session };
    });

    const res = NextResponse.json({ ok: true, tenantId: result.membership.tenantId, role: result.membership.role });
    res.headers.set("Set-Cookie", managerCookieHeader(result.session.token, result.session.exp));
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace selection failed";
    if (message === "Selection token already used") return NextResponse.json({ error: "Workspace selection token has already been used" }, { status: 401 });
    if (message === "Workspace not available" || message === "Workspace is suspended or unavailable") return NextResponse.json({ error: message }, { status: 403 });
    logError("tenant_selection_failed", { error: message });
    return NextResponse.json({ error: "Workspace selection failed" }, { status: 500 });
  }
}