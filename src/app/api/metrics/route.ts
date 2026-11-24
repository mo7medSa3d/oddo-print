import { NextResponse } from "next/server";
import { requirePlatformOwner, PlatformUnauthorizedError } from "../../../lib/platform-auth";
import { renderPrometheusMetrics } from "../../../lib/metrics";
import { isMetricsMachineRequest, MetricsMachineConfigurationError } from "../../../lib/metrics-machine-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Global telemetry accepts the verified owner or an explicitly configured
  // read-only collector credential. Tenant membership never grants access.
  try {
    if (!isMetricsMachineRequest(req)) {
      let ownerRequest = req;
      if (req.headers.has("authorization")) {
        // Explicit credentials must not downgrade to ambient browser authority
        // when malformed or empty. Preserve legitimate owner Bearer tokens.
        const headers = new Headers(req.headers);
        headers.delete("cookie");
        ownerRequest = new Request(req, { headers });
      }
      await requirePlatformOwner(ownerRequest);
    }
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Metrics authentication required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof MetricsMachineConfigurationError) {
      return NextResponse.json({ error: "Metrics authentication temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return new Response(await renderPrometheusMetrics(), {
      status: 200,
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch {
    // Authentication already succeeded, but an incomplete scrape must not
    // appear healthy. Return no collector/SQL details to the caller.
    return new Response("Metrics temporarily unavailable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}
