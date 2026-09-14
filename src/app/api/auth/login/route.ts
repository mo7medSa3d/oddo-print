import { NextResponse } from "next/server";
import { authenticateForTenant, customerSessionCookie } from "../../../../lib/customer-auth";
import { inspectAuthRateLimit, clientIpFrom, recordAuthFailure, recordAuthSuccess } from "../../../../lib/auth-rate-limit";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { writeAuditEvent } from "../../../../lib/audit";

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 64 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let body: { email?: unknown; password?: unknown; tenantId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const tenantId = typeof body.tenantId === "string" && body.tenantId.length <= 128 ? body.tenantId : undefined;
  if (!email || !password || password.length > 4096) return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  const ip = clientIpFrom(req);
  const pre = await inspectAuthRateLimit(ip, email);
  if (!pre.allowed) { const res = NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 }); res.headers.set("Retry-After", String(pre.retryAfterSec)); return res; }
  let identity: Awaited<ReturnType<typeof authenticateForTenant>>;
  try { identity = await authenticateForTenant(email, password, tenantId); } catch { identity = null; }
  if (!identity) {
    const after = await recordAuthFailure(ip, email); const res = NextResponse.json({ error: "Invalid email or password" }, { status: after.allowed ? 401 : 429 }); if (!after.allowed) res.headers.set("Retry-After", String(after.retryAfterSec)); return res;
  }
  if ("multipleTenants" in identity && identity.multipleTenants) {
    return NextResponse.json({ error: "Choose a workspace", workspaces: identity.memberships.map((m) => m.tenantId) }, { status: 409 });
  }
  if (!("tenantId" in identity) || !identity.tenantId || !identity.role) return NextResponse.json({ error: "Workspace setup is incomplete" }, { status: 409 });
  await recordAuthSuccess(email).catch(() => undefined);
  const session = await (await import("../../../../lib/customer-auth")).issueCustomerSession(identity.userId, identity.tenantId, identity.role);
  const res = NextResponse.json({ ok: true, expiresAt: session.exp.toISOString(), tenantId: identity.tenantId, role: identity.role });
  res.headers.set("Set-Cookie", customerSessionCookie(session));
  await writeAuditEvent({ tenantId: identity.tenantId, actorType: "user", actorId: identity.userId, action: "user.login.success" }).catch(() => undefined);
  return res;
}
