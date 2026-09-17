import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../../../lib/platform-auth";
import { hasBodyOverLimit } from "../../../../../../lib/request-limits";
import { transitionTenantLifecycle, TenantLifecycleError } from "../../../../../../lib/tenant-lifecycle";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  let claims;
  try {
    claims = await requirePlatformOwner(req);
  } catch {
    return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Tenant ID is required" }, { status: 400 });
  }
  const platformTenantId = process.env.PLATFORM_TENANT_ID?.trim();
  if (platformTenantId && id === platformTenantId) {
    return NextResponse.json({ error: "The platform tenant cannot be suspended.", code: "PLATFORM_TENANT_PROTECTED" }, { status: 409 });
  }

  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: { reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 500) {
    return NextResponse.json({ error: "A valid suspension reason (1-500 characters) is required" }, { status: 400 });
  }

  try {
    await transitionTenantLifecycle(id, "suspended", reason, {
      type: "platform",
      id: claims.userId,
    });
    return NextResponse.json({ ok: true, tenantId: id, lifecycle: "suspended", reason });
  } catch (err) {
    if (err instanceof TenantLifecycleError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to suspend tenant" }, { status: 500 });
  }
}
