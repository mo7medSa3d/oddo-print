import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { db } from "../../../../db";
import { managerSessions, passwordResetTokens, tenantUsers, users } from "../../../../db/schema";
import { and, eq, isNull, gt } from "drizzle-orm";
import { hashPassword, hashToken } from "../../../../lib/password";
export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({error:"Request body too large"},{status:413});
  let body: { token?: unknown; password?: unknown }; try { body=await req.json(); } catch { return NextResponse.json({error:"Invalid JSON"},{status:400}); }
  const token=typeof body.token==="string"?body.token:""; const password=typeof body.password==="string"?body.password:"";
  if(!token || password.length<12 || password.length>4096) return NextResponse.json({error:"Invalid or incomplete reset request"},{status:400});
  const row=await db.query.passwordResetTokens.findFirst({where:and(eq(passwordResetTokens.tokenHash,await hashToken(token)),isNull(passwordResetTokens.consumedAt),gt(passwordResetTokens.expiresAt,new Date()))});
  if(!row) return NextResponse.json({error:"Reset link expired or invalid"},{status:400});
  const nextHash=await hashPassword(password); const now=new Date();
  try {
    await db.transaction(async tx=>{
      const consumed = await tx.update(passwordResetTokens).set({consumedAt:now}).where(and(eq(passwordResetTokens.id,row.id),isNull(passwordResetTokens.consumedAt))).returning({ id: passwordResetTokens.id });
      if (consumed.length !== 1) throw new Error("Reset token already consumed");
      await tx.update(users).set({passwordHash:nextHash,updatedAt:now}).where(eq(users.id,row.userId));
      await tx.update(managerSessions).set({revokedAt:now}).where(and(eq(managerSessions.userId,row.userId),isNull(managerSessions.revokedAt)));
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Reset token already consumed") return NextResponse.json({error:"Reset link expired or invalid"},{status:400});
    throw error;
  }
  void db.query.tenantUsers.findFirst({ where: (tu, { eq }) => eq(tu.userId, row.userId), columns: { tenantId: true } }).then((membership) => membership ? import("../../../../lib/audit").then(({ writeAuditEvent }) => writeAuditEvent({ tenantId: membership.tenantId, actorType: "user", actorId: row.userId, action: "user.password_reset_completed" })) : undefined).catch(() => undefined);
  return NextResponse.json({ok:true});
}
