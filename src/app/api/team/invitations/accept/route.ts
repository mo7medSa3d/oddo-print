import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { tenantInvitations, tenantUsers, users } from "../../../../../db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken, normalizeEmail } from "../../../../../lib/password";
import { writeAuditEvent } from "../../../../../lib/audit";

export async function POST(req: Request) {
  let body: { token?: unknown; email?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!token || token.length > 256 || !email) return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 400 });

  const row = await db.query.tenantInvitations.findFirst({
    where: and(eq(tenantInvitations.tokenHash, await hashToken(token)), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt), gt(tenantInvitations.expiresAt, new Date())),
  });
  if (!row || row.email !== email) return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 400 });
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
  if (!user) return NextResponse.json({ error: "Create an account with the invited email before accepting the invitation" }, { status: 409 });

  try {
    await db.transaction(async (tx) => {
      const consumed = await tx.update(tenantInvitations).set({ acceptedAt: new Date() })
        .where(and(eq(tenantInvitations.id, row.id), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt)))
        .returning({ id: tenantInvitations.id });
      if (consumed.length !== 1) throw new Error("Invitation already consumed");
      await tx.insert(tenantUsers).values({ userId: user.id, tenantId: row.tenantId, role: row.role }).onConflictDoNothing();
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message === "Invitation already consumed" ? "Invitation is already used" : "Invitation could not be accepted" }, { status: 409 });
  }
  await writeAuditEvent({ tenantId: row.tenantId, actorType: "user", actorId: user.id, action: "team.invitation.accepted", resourceType: "tenant_invitation", resourceId: row.id }).catch(() => undefined);
  return NextResponse.json({ ok: true, tenantId: row.tenantId });
}
