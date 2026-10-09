import { requireManagerActorInTransaction, ManagerMutationAuthorityChangedError } from "../../../lib/manager-mutation-authorization";
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { tenants, users } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { validateWorkspaceManager } from "../../../lib/manager-auth";
import { hasManagerPermission } from "../../../lib/authorization";
import { writeAuditEvent } from "../../../lib/audit";

export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  // Repo convention: 401 for missing authentication, 403 only for a
  // permission failure on an authenticated principal.
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasManagerPermission(claims, "tenant.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const [tenant, user] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, claims.tenantId), columns: { id: true, name: true, createdAt: true, updatedAt: true } }),
    db.query.users.findFirst({ where: eq(users.id, claims.userId), columns: { email: true } }),
  ]);
  if (!tenant || !user) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  return NextResponse.json({ tenant, email: user.email, role: claims.role });
}

export async function PATCH(req: Request) {
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
    if (error instanceof ManagerMutationAuthorityChangedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof Error && error.message === "TENANT_NOT_ACTIVE") return NextResponse.json({ error: "Workspace unavailable" }, { status: 403 });
    throw error;
  }
  return NextResponse.json({ ok: true, name });
}
