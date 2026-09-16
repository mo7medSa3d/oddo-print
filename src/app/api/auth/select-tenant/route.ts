import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { tenantUsers } from "../../../../db/schema";
import { and, eq } from "drizzle-orm";
import { validateManager, revokeManagerSession, managerCookieHeader } from "../../../../lib/manager-auth";
import { issueCustomerSession } from "../../../../lib/customer-auth";
import { writeAuditEvent } from "../../../../lib/audit";

export async function POST(req: Request) {
  const claims = await validateManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { tenantId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const membership = await db.query.tenantUsers.findFirst({ where: and(eq(tenantUsers.userId, claims.userId), eq(tenantUsers.tenantId, tenantId)), columns: { tenantId: true, role: true } });
  if (!membership) return NextResponse.json({ error: "Workspace not available" }, { status: 403 });
  const session = await issueCustomerSession(claims.userId, membership.tenantId, membership.role as Parameters<typeof issueCustomerSession>[2]);
  await revokeManagerSession(claims.jti);
  await writeAuditEvent({ tenantId: membership.tenantId, actorType: "user", actorId: claims.userId, action: "tenant.selected" }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) }));
  const res = NextResponse.json({ ok: true, tenantId: membership.tenantId, role: membership.role });
  res.headers.set("Set-Cookie", managerCookieHeader(session.token, session.exp));
  return res;
}
