import { NextResponse } from "next/server";
import { requirePlatformOwner } from "../../../../../../lib/platform-auth";
import { transitionTenantLifecycle, TenantLifecycleError } from "../../../../../../lib/tenant-lifecycle";
import { runtimeSecret } from "../../../../../../lib/runtime-secret";

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

  const platformTenantId = runtimeSecret("PLATFORM_TENANT_ID")?.trim() ?? "";
  if (platformTenantId && id === platformTenantId) {
    return NextResponse.json({ error: "The platform tenant lifecycle cannot be changed.", code: "PLATFORM_TENANT_PROTECTED" }, { status: 409 });
  }

  try {
    await transitionTenantLifecycle(id, "active", "Reactivated by platform owner", {
      type: "platform",
      id: claims.userId,
    });
    return NextResponse.json({ ok: true, tenantId: id, lifecycle: "active" });
  } catch (err) {
    if (err instanceof TenantLifecycleError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to reactivate tenant" }, { status: 500 });
  }
}
