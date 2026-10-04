import { NextResponse } from "next/server";
import { validateManager } from "../../../../../../lib/manager-auth";
import { hasManagerPermission } from "../../../../../../lib/authorization";
import { transitionTenantLifecycle, TenantLifecycleError } from "../../../../../../lib/tenant-lifecycle";
import { hasBodyOverLimit } from "../../../../../../lib/request-limits";
import { runtimeSecret } from "../../../../../../lib/runtime-secret";

/**
 * Platform-admin endpoint for managing tenant lifecycle transitions.
 *
 * Authorization: the caller must be an authenticated manager whose tenant
 * is the platform tenant (PLATFORM_TENANT_ID). This prevents non-platform
 * tenants from suspending or deleting other tenants.
 *
 * PATCH /api/admin/tenants/[id]/lifecycle
 * Body: { lifecycle: "suspended" | "active" | "deleted", reason: string }
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Bypass the normal tenant lifecycle gate for platform admin operations:
  // the platform tenant is never suspended. We validate session integrity
  // but the lifecycle guard in validateManagerClaims only blocks non-active
  // tenants, and the platform tenant is always active.
  const claims = await validateManager(req);
  if (!claims || !claims.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platformTenantId = runtimeSecret("PLATFORM_TENANT_ID")?.trim() ?? "";
  if (!platformTenantId || claims.tenantId !== platformTenantId) {
    return NextResponse.json({ error: "Forbidden: platform admin access required" }, { status: 403 });
  }
  if (!hasManagerPermission(claims, "tenant.update")) {
    return NextResponse.json({ error: "Forbidden: insufficient role" }, { status: 403 });
  }

  const { id: tenantId } = await params;
  if (!tenantId || typeof tenantId !== "string") {
    return NextResponse.json({ error: "Tenant ID is required" }, { status: 400 });
  }
  if (platformTenantId === tenantId) {
    return NextResponse.json({ error: "The platform tenant cannot be suspended or deleted.", code: "PLATFORM_TENANT_PROTECTED" }, { status: 409 });
  }

  // Same per-route body ceiling + reason bound as the platform suspend route:
  // the global request guard alone would still allow an ~8MB `reason` to be
  // persisted into the tenant row and its audit metadata.
  if (hasBodyOverLimit(req, 16 * 1024)) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: { lifecycle?: string; reason?: string };
  try {
    const parsedBody = await req.json(); if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("JSON object required"); body = parsedBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { lifecycle, reason } = body;
  if (!lifecycle || typeof lifecycle !== "string") {
    return NextResponse.json({ error: "lifecycle field is required" }, { status: 400 });
  }
  if (!reason || typeof reason !== "string" || reason.trim().length === 0 || reason.trim().length > 500) {
    return NextResponse.json({ error: "A valid lifecycle reason (1-500 characters) is required" }, { status: 400 });
  }

  try {
    const result = await transitionTenantLifecycle(
      tenantId,
      lifecycle as "active" | "suspended" | "deleted",
      reason,
      { type: "platform", id: claims.userId },
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof TenantLifecycleError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    throw e;
  }
}
