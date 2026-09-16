import { logError } from "../../../../lib/log";
import { NextResponse } from "next/server";
import { validateManager, revokeManagerSession, clearManagerCookieHeader } from "../../../../lib/manager-auth";
import { writeAuditEvent } from "../../../../lib/audit";
export async function POST(req: Request) { const claims = await validateManager(req); if (claims) { await revokeManagerSession(claims.jti).catch(() => undefined); await writeAuditEvent({ tenantId: claims.tenantId, actorType: claims.userId ? "user" : "system", actorId: claims.userId ?? "legacy-manager", action: "session.revoked", resourceType: "manager_session", resourceId: claims.jti }).catch((err) => logError('audit_write_failed', { error: err?.message ?? String(err) })); } const res=NextResponse.json({ok:true}); res.headers.set("Set-Cookie", clearManagerCookieHeader()); return res; }
