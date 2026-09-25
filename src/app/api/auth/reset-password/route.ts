import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { db } from "../../../../db";
import { passwordResetTokens, tenantUsers, users } from "../../../../db/schema";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { hashPassword, hashToken } from "../../../../lib/password";
import { writeAuditEvent } from "../../../../lib/audit";
import { revokeLegacyManagerSessionsForUserInTransaction } from "../../../../lib/manager-auth";
import { revokeLegacyPlatformSessionsForUserInTransaction } from "../../../../lib/platform-auth";
import { revokeUserRefreshFamiliesInTransaction } from "../../../../lib/session-tokens";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { token?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!token || password.length < 12 || password.length > 4096) {
    return NextResponse.json({ error: "Invalid or incomplete reset request" }, { status: 400 });
  }

  const row = await db.query.passwordResetTokens.findFirst({
    where: and(
      eq(passwordResetTokens.tokenHash, await hashToken(token)),
      isNull(passwordResetTokens.consumedAt),
      gt(passwordResetTokens.expiresAt, sql`clock_timestamp()`)
    ),
  });
  if (!row) return NextResponse.json({ error: "Reset link expired or invalid" }, { status: 400 });

  const nextHash = await hashPassword(password);

  try {
    await db.transaction(async (tx) => {
      const consumed = await tx
        .update(passwordResetTokens)
        .set({ consumedAt: sql`now()` })
        .where(and(
          eq(passwordResetTokens.id, row.id),
          isNull(passwordResetTokens.consumedAt),
          gt(passwordResetTokens.expiresAt, sql`clock_timestamp()`),
        ))
        .returning({ id: passwordResetTokens.id });

      if (consumed.length !== 1) throw new Error("Reset token already consumed");

      const updatedUser = await tx.update(users)
        .set({ passwordHash: nextHash, updatedAt: sql`now()` })
        .where(eq(users.id, row.userId))
        .returning({ id: users.id });
      if (updatedUser.length !== 1) throw new Error("Reset user missing");

      // Revoke pre-cutover legacy sessions as part of the bounded compatibility window.
      await revokeLegacyManagerSessionsForUserInTransaction(tx, row.userId);
      await revokeLegacyPlatformSessionsForUserInTransaction(tx, row.userId);

      // Password reset is a session-boundary event: every v2 refresh family for
      // the account must be revoked so an attacker holding an old refresh token
      // cannot mint a new access token after the password changes.
      await revokeUserRefreshFamiliesInTransaction(tx, row.userId, "password_reset");

      const membership = await tx.query.tenantUsers.findFirst({
        where: eq(tenantUsers.userId, row.userId),
        columns: { tenantId: true },
      });

      await writeAuditEvent(
        {
          tenantId: membership?.tenantId ?? null,
          actorType: membership ? "user" : "platform",
          actorId: row.userId,
          action: "user.password_reset_completed",
        },
        tx
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Reset token already consumed") {
      return NextResponse.json({ error: "Reset link expired or invalid" }, { status: 400 });
    }
    logError("password_reset_transaction_failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Password reset failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
