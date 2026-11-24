import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { tenants } from "../../../../../db/schema";
import { eq } from "drizzle-orm";
import { findActiveInvitation } from "../../../../../lib/invitation-join";
import { clientIpFrom, reserveAuthAttempt, setRateLimitHeaders } from "../../../../../lib/auth-rate-limit";
import { hashToken } from "../../../../../lib/password";
import { logError } from "../../../../../lib/log";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
/** Bearer link reveals ONLY its invited mailbox and destination, never users,
 * password state, tokens, sessions or any other tenant's records. */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token || token.length > 256) {
    return NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 404, headers });
  }
  const ip = clientIpFrom(req);
  const rateIdentity = `invitation-preview:${ip === "unknown" ? await hashToken(token) : ip}`;
  let rate: Awaited<ReturnType<typeof reserveAuthAttempt>>;
  try {
    rate = await reserveAuthAttempt(ip, rateIdentity, "invitation-preview");
  } catch (error) {
    logError("auth.rate_limit.store_unavailable", { endpoint: "invitation_preview", error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Invitation preview temporarily unavailable", code: "INVITATION_PREVIEW_UNAVAILABLE" }, { status: 503, headers });
  }
  if (!rate.allowed) {
    const res = setRateLimitHeaders(
      NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers }),
      rate,
    );
    if (rate.retryAfterSec) res.headers.set("Retry-After", String(rate.retryAfterSec));
    return res;
  }
  try {
    const invitation = await findActiveInvitation(token);
    if (!invitation) return setRateLimitHeaders(NextResponse.json({ error: "Invitation is invalid or expired" }, { status: 404, headers }), rate);
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, invitation.tenantId),
      columns: { name: true, lifecycle: true },
    });
    if (!tenant || tenant.lifecycle !== "active")
      return NextResponse.json({ error: "Workspace unavailable", code: "WORKSPACE_UNAVAILABLE" }, { status: 409, headers });
    return NextResponse.json({
      workspaceName: tenant.name,
      email: invitation.email,
      role: invitation.role,
    }, { headers });
  } catch (error) {
    logError("team.invitation_preview_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(
      { error: "Invitation preview temporarily unavailable", code: "INVITATION_PREVIEW_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
