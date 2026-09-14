import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantUsers, managerSessions } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { clearManagerCookieHeader, validateManager } from "../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../lib/authorization";

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId || claims.role !== "owner" || !hasManagerPermission(claims, "users.manage")) return NextResponse.json({ error: "Only the workspace owner can transfer ownership" }, { status: 403 });
  const currentUserId = claims.userId;
  let body: { userId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const newOwnerId = typeof body.userId === "string" ? body.userId : "";
  if (!newOwnerId || newOwnerId === currentUserId) return NextResponse.json({ error: "A different member is required" }, { status: 400 });
  const target = await db.query.tenantUsers.findFirst({ where: and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, newOwnerId)), columns: { role: true } });
  if (!target) return NextResponse.json({ error: "Target member is not in this workspace" }, { status: 404 });
  try {
    await db.transaction(async (tx) => {
      const demoted = await tx.update(tenantUsers).set({ role: "admin", updatedAt: new Date() }).where(and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, currentUserId), eq(tenantUsers.role, "owner"))).returning({ userId: tenantUsers.userId });
      if (demoted.length !== 1) throw new Error("Ownership has already changed");
      await tx.update(tenantUsers).set({ role: "owner", updatedAt: new Date() }).where(and(eq(tenantUsers.tenantId, claims.tenantId), eq(tenantUsers.userId, newOwnerId)));
      await tx.update(managerSessions).set({ revokedAt: new Date() }).where(and(eq(managerSessions.userId, currentUserId), eq(managerSessions.tenantId, claims.tenantId)));
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Ownership has already changed") return NextResponse.json({ error: "Ownership has already changed. Refresh and try again." }, { status: 409 });
    throw error;
  }
  await import("../../../../lib/audit").then(({ writeAuditEvent }) => writeAuditEvent({ tenantId: claims.tenantId, actorType: "user", actorId: currentUserId, action: "team.ownership.transferred", resourceType: "user", resourceId: newOwnerId })).catch(() => undefined);
  const res = NextResponse.json({ ok: true, next: "/login" });
  res.headers.set("Set-Cookie", clearManagerCookieHeader());
  return res;
}
