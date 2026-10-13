import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { e2eCaptureRuns } from "../../../../db/schema";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";
import { requireManagerPermission } from "../../../../lib/authorization";
import { CAPTURE_MAX_PREVIEW_BYTES } from "../../../../lib/e2e-capture";
import { logError } from "../../../../lib/log";

export const dynamic = "force-dynamic";
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

/**
 * Only a Workspace manager permitted to read document payloads can see
 * their own tenant's stored first-page JPEG. Never serve Windows file://
 * paths, source PDF bytes, Odoo credentials, or another tenant's preview.
 * Still available when capture creation is disabled.
 */
export async function GET(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: PRIVATE });
  }
  try { requireManagerPermission(claims, "jobs.payload.read"); }
  catch { return NextResponse.json({ code: "FORBIDDEN" }, { status: 403, headers: PRIVATE }); }

  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^cap_[a-f0-9]{32}$/.test(id)) {
    return NextResponse.json({ code: "INVALID_CAPTURE_ID" }, { status: 400, headers: PRIVATE });
  }
  try {
    const [row] = await db.select({
      previewJpeg: e2eCaptureRuns.previewJpeg,
    }).from(e2eCaptureRuns).where(and(
      eq(e2eCaptureRuns.id, id),
      eq(e2eCaptureRuns.tenantId, claims.tenantId),
      eq(e2eCaptureRuns.status, "rendered_locally"),
    )).limit(1);
    if (!row?.previewJpeg) {
      return NextResponse.json({ code: "PREVIEW_UNAVAILABLE" }, { status: 404, headers: PRIVATE });
    }
    const encoded = row.previewJpeg;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > Math.ceil(CAPTURE_MAX_PREVIEW_BYTES * 4 / 3) + 4) {
      throw new Error("invalid stored capture preview");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 4 || bytes.length > CAPTURE_MAX_PREVIEW_BYTES
      || bytes.toString("base64") !== encoded
      || !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      throw new Error("invalid stored capture preview");
    }
    return NextResponse.json({
      runId: id,
      previewDataUri: "data:image/jpeg;base64," + encoded,
      firstPageOnly: true,
      physicalPrinted: false,
    }, { headers: PRIVATE });
  } catch (error) {
    logError("e2e.capture.console_preview_failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: PRIVATE });
  }
}
