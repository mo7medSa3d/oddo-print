import { NextResponse } from "next/server";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { getPrinterCapabilityPage, getPrinterCapabilityMatrix } from "../../../../lib/printer-health";
import { clampListLimit } from "../../../../lib/request-limits";
import { requestIdFrom } from "../../../../lib/log";
import { runWithCorrelation, generateRequestId } from "../../../../server/correlation";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { requireManagerPermission(claims, "printers.read"); } catch { return NextResponse.json({ error: "Forbidden" }, { status: 403 }); }

  const requestId = requestIdFrom(req) || generateRequestId();
  const url = new URL(req.url);
  const printerId = url.searchParams.get("printerId");
  const headers: Record<string, string> = { "x-request-id": requestId, "Cache-Control": "no-store" };
  const cursor = url.searchParams.get("after");
  let afterId: string | undefined;
  if (!printerId && cursor !== null) {
    if (!/^[A-Za-z0-9_-]{1,640}$/.test(cursor)) {
      return NextResponse.json({ error: "Invalid capability page cursor" }, { status: 400, headers });
    }
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (decoded.length < 1 || decoded.length > 120 || Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
      return NextResponse.json({ error: "Invalid capability page cursor" }, { status: 400, headers });
    }
    afterId = decoded;
  }
  const limit = clampListLimit(url.searchParams.get("limit"), 100, 1000);

  return runWithCorrelation({ requestId, tenantId: claims.tenantId, printerId: printerId ?? undefined }, async () => {
    if (printerId) {
      const cap = await getPrinterCapabilityMatrix(claims.tenantId, printerId);
      if (!cap) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
      return NextResponse.json(cap, { headers });
    }
    const page = await getPrinterCapabilityPage(claims.tenantId, { limit, afterId });
    headers["X-Has-More"] = String(page.hasMore);
    if (page.nextCursor) headers["X-Next-Cursor"] = page.nextCursor;
    return NextResponse.json(page.items, { headers });
  });
}
