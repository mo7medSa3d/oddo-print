import { NextResponse } from "next/server";
import { validateCustomer } from "../../../../lib/customer-auth";
export async function GET(req: Request) {
  const claims = await validateCustomer(req);
  // Deliberate probe shape: clients check `res.ok` (AppShell, dashboard,
  // login). The 401 body uses the standard `{error}` shape so shared client
  // error handling treats it like every other route; the 2xx body keeps the
  // `authenticated` flag the probe contract documents.
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ authenticated: true, tenantId: claims.tenantId, userId: claims.userId ?? null, role: claims.role, exp: claims.exp });
}
