import { NextResponse } from "next/server";
import { requirePlatformOwner, PlatformUnauthorizedError } from "../../../lib/platform-auth";
import { renderPrometheusMetrics } from "../../../lib/metrics";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Global telemetry is control-plane data: only the platform owner identity
  // may read it. Platform-tenant membership alone (any role, including
  // viewer) must never suffice, and the legacy tenant-role gate is retired.
  try {
    await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503 });
  }
  return new Response(await renderPrometheusMetrics(), {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
  });
}
