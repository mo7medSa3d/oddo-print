import { hasBodyOverLimit } from "../../../lib/request-limits";
import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../lib/manager-mutation-authorization";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { tenants, users } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../lib/manager-auth";
import { hasManagerPermission } from "../../../lib/authorization";
import { writeAuditEvent } from "../../../lib/audit";
import { requireActiveTenantInTransaction, TenantSuspendedError, TenantDeletedError } from "../../../lib/tenant-guard";
import { logError } from "../../../lib/log";

export const dynamic = "force-dynamic";
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401, headers: PRIVATE_HEADERS });
  if (!hasManagerPermission(claims, "tenant.read")) {
    return NextResponse.json({ error: "Forbidden", code: "FORBIDDEN" }, { status: 403, headers: PRIVATE_HEADERS });
  }
  try {
    // The initial session validation is only a preflight. Lock tenant before
    // live actor/session authorization and keep the locks until both
    // metadata projections finish; a concurrent revocation must not leak PII.
    const [tenant, user] = await db.transaction(async tx => {
      await requireActiveTenantInTransaction(tx, claims.tenantId);
      await requireManagerActorInTransaction(tx, claims, "tenant.read");
      return Promise.all([
        tx.query.tenants.findFirst({
          where: eq(tenants.id, claims.tenantId),
          columns: { id: true, name: true, createdAt: true, updatedAt: true },
        }),
        tx.query.users.findFirst({
          where: eq(users.id, claims.userId!),
          columns: { email: true, isPlatformOwner: true, emailVerifiedAt: true },
        }),
      ]);
    });
    if (!tenant || !user) {
      return NextResponse.json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" }, { status: 404, headers: PRIVATE_HEADERS });
    }
    return NextResponse.json({
      tenant, userId: claims.userId, email: user.email, role: claims.role,
      platformOwner: user.isPlatformOwner === true && !!user.emailVerifiedAt,
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: PRIVATE_HEADERS });
    }
    if (error instanceof ManagerMutationAuthorityChangedError) return error.response();
    logError("settings.account_read_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Workspace settings unavailable", code: "SETTINGS_UNAVAILABLE" }, { status: 503, headers: PRIVATE_HEADERS });
  }
}

export async function PATCH(req: Request) {
  if (hasBodyOverLimit(req, 16 * 1024)) return NextResponse.json({ error: "Request body too large", code: "INVALID_REQUEST" }, { status: 413 });
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasManagerPermission(claims, "tenant.update")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { name?: unknown };
  try { const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 120) return NextResponse.json({ error: "Workspace name must be 2-120 characters" }, { status: 400 });
  try {
  await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id = ${claims.tenantId} FOR UPDATE`);
    if (locked.rows[0]?.lifecycle !== "active") throw new Error("TENANT_NOT_ACTIVE");
    await requireManagerActorInTransaction(tx, claims, "tenant.update");
    await tx.update(tenants).set({ name, updatedAt: sql`now()` }).where(eq(tenants.id, claims.tenantId));
    await writeAuditEvent({ tenantId: claims.tenantId, actorType: "user", actorId: claims.userId, action: "tenant.updated", resourceType: "tenant", resourceId: claims.tenantId }, tx);
  });
  } catch (error) {
    if (error instanceof ManagerMutationAuthorityChangedError) return error.response();
    if (error instanceof Error && error.message === "TENANT_NOT_ACTIVE") return NextResponse.json({ error: "Workspace unavailable" }, { status: 403 });
    throw error;
  }
  return NextResponse.json({ ok: true, name });
}
