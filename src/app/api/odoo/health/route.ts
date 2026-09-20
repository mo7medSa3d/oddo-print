import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { TenantDeletedError, TenantSuspendedError, requireActiveTenant } from "../../../../lib/tenant-guard";
import { db } from "../../../../db";
import { tenants } from "../../../../db/schema";
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

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, key.tenantId),
    columns: { odooEnabled: true },
  });
  return NextResponse.json(
    { ok: true, enabled: tenant?.odooEnabled === true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
