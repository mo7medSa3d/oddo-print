import { NextResponse } from "next/server";
import { validateOdooKey } from "../../../../lib/odoo-auth";
import { requireTenantBillingAccess, isTenantBillingError } from "../../../../lib/entitlements";
import { db } from "../../../../db";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import {
  captureEnabled, parseCaptureRequest, queueOdooCapture, readBoundedCaptureJSON,
  readOdooCapture, CaptureError,
} from "../../../../lib/e2e-capture";
import { logError } from "../../../../lib/log";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function errorResponse(e: unknown) {
  if (isTenantBillingError(e)) return NextResponse.json({
    error: "CAPTURE_NOT_AUTHORIZED", code: "CAPTURE_NOT_AUTHORIZED", retryable: false,
  }, { status: 403, headers: NO_STORE });
  if (e instanceof CaptureError) return NextResponse.json({
    error: e.code, code: e.code, retryable: e.code === "CAPTURE_QUEUE_BUSY",
  }, { status: e.status, headers: NO_STORE });
  logError("e2e.capture.odoo_error", { error: e instanceof Error ? e.message : "unknown" });
  return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" },
    { status: 500, headers: NO_STORE });
}

/** One tenant-authenticated Odoo test is one operation, not a printer job. */
export async function POST(req: Request) {
  if (!captureEnabled()) return errorResponse(new CaptureError("CAPTURE_NOT_ENABLED", 404));
  if (hasBodyOverLimit(req, 6 * 1024 * 1024)) {
    return NextResponse.json({ code: "DOCUMENT_TOO_LARGE" }, { status: 413, headers: NO_STORE });
  }
  const auth = await validateOdooKey(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  if (auth.readOnly) return errorResponse(new CaptureError("API_KEY_READ_ONLY", 409));
  let json: unknown;
  try { json = await readBoundedCaptureJSON(req, 6 * 1024 * 1024); }
  catch (e) { return errorResponse(e); }
  try {
    const parsed = parseCaptureRequest(json);
    // An E2E diagnostic must not bypass suspended subscription policy.
    await requireTenantBillingAccess(db, auth.tenantId);
    const run = await queueOdooCapture(auth, parsed);
    return NextResponse.json({ ...run, outcome: "pending_simulation", physicalPrinted: false },
      { status: run.reused ? 200 : 202, headers: NO_STORE });
  } catch (e) { return errorResponse(e); }
}

export async function GET(req: Request) {
  if (!captureEnabled()) return errorResponse(new CaptureError("CAPTURE_NOT_ENABLED", 404));
  const auth = await validateOdooKey(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^cap_[a-f0-9]{32}$/.test(id)) {
    return errorResponse(new CaptureError("INVALID_CAPTURE_ID", 400));
  }
  try {
    await requireTenantBillingAccess(db, auth.tenantId);
    return NextResponse.json(await readOdooCapture(auth.tenantId, auth.id, id),
      { status: 200, headers: NO_STORE });
  } catch (e) { return errorResponse(e); }
}
