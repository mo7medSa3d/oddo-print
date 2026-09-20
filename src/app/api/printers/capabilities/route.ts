import { NextResponse } from "next/server";
import { validateManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { getAllPrintersCapabilityMatrix, getPrinterCapabilityMatrix } from "../../../../lib/printer-health";
import { requestIdFrom } from "../../../../lib/log";
import { runWithCorrelation, generateRequestId } from "../../../../server/correlation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const requestId = requestIdFrom(req as any) || generateRequestId();
  const url = new URL(req.url);
  const printerId = url.searchParams.get("printerId");

  return runWithCorrelation({ requestId, tenantId: claims.tenantId, printerId: printerId ?? undefined } as any, async () => {
    if (printerId) {
      const cap = await getPrinterCapabilityMatrix(claims.tenantId, printerId);
      if (!cap) return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "x-request-id": requestId } });
      return NextResponse.json(cap, { headers: { "x-request-id": requestId } });
    }
    const all = await getAllPrintersCapabilityMatrix(claims.tenantId);
    return NextResponse.json(all, { headers: { "x-request-id": requestId } });
  });
}
