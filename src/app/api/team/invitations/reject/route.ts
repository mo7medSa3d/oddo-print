import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { tenantInvitations } from "../../../../../db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken, normalizeEmail } from "../../../../../lib/password";

export async function POST(req: Request) {
  let body: { token?: unknown; email?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const token = typeof body.token === "string" ? body.token : "";
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!token || token.length > 256 || !email) return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 400 });
  const row = await db.query.tenantInvitations.findFirst({ where: and(eq(tenantInvitations.tokenHash, await hashToken(token)), eq(tenantInvitations.email, email), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt), gt(tenantInvitations.expiresAt, new Date())), columns: { id: true } });
  if (!row) return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 400 });
  const updated = await db.update(tenantInvitations).set({ revokedAt: new Date() }).where(and(eq(tenantInvitations.id, row.id), isNull(tenantInvitations.acceptedAt), isNull(tenantInvitations.revokedAt))).returning({ id: tenantInvitations.id });
  return updated.length === 1 ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Invitation is already used" }, { status: 409 });
}
