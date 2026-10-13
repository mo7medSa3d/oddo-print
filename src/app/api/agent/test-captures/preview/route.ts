import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { e2eCaptureRuns } from "../../../../../db/schema";
import { validateAgent } from "../../../../../lib/agent-auth";
import { captureEnabled, CAPTURE_MAX_PREVIEW_BYTES } from "../../../../../lib/e2e-capture";
import { logError } from "../../../../../lib/log";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** A single bounded JPEG preview for the paired desktop; NEVER the private PDF. */
export async function GET(req: Request) {
  if (!captureEnabled()) {
    return NextResponse.json({ code: "CAPTURE_NOT_ENABLED" }, { status: 404, headers: NO_STORE });
  }
  const agent = await validateAgent(req.headers.get("authorization"));
  if (!agent) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: NO_STORE });
  }
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^cap_[a-f0-9]{32}$/.test(id)) {
    return NextResponse.json({ code: "INVALID_CAPTURE_ID" }, { status: 400, headers: NO_STORE });
  }
  try {
    const [row] = await db.select({
      previewJpeg: e2eCaptureRuns.previewJpeg,
    }).from(e2eCaptureRuns).where(and(
      eq(e2eCaptureRuns.tenantId, agent.tenantId),
      eq(e2eCaptureRuns.agentId, agent.id),
      eq(e2eCaptureRuns.id, id),
      eq(e2eCaptureRuns.status, "rendered_locally"),
    )).limit(1);
    if (!row?.previewJpeg) {
      return NextResponse.json({ code: "PREVIEW_UNAVAILABLE" }, { status: 404, headers: NO_STORE });
    }
    // Defence in depth: do not return corrupt/unbounded database content.
    const encoded = row.previewJpeg;
    const jpeg = Buffer.from(encoded, "base64");
    if (jpeg.length < 3 || jpeg.length > CAPTURE_MAX_PREVIEW_BYTES
      || jpeg.toString("base64") !== encoded
      || !jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      throw new Error("invalid stored capture preview");
    }
    return NextResponse.json({
      runId: id, previewDataUri: "data:image/jpeg;base64," + encoded, physicalPrinted: false,
    }, { headers: NO_STORE });
  } catch (error) {
    logError("e2e.capture.preview_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: NO_STORE });
  }
}
