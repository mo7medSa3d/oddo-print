import { NextResponse } from "next/server";
import { TenantDeletedError, TenantSuspendedError, requireActiveTenant } from "../../../../lib/tenant-guard";
import { validateOdooKey } from "../../../../lib/odoo-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const key = await validateOdooKey(req, {
    requireIntegrationEnabled: false,
    requireActiveTenant: false,
  });
  if (!key) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  try {
    await requireActiveTenant(key.tenantId);
  } catch (error) {
    if (error instanceof TenantSuspendedError || error instanceof TenantDeletedError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }

  return NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
