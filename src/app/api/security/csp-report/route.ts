import { handleCspReport } from "../../../../lib/csp-report";

export const runtime = "nodejs";

// Unauthenticated, bounded telemetry only. The custom server's ordinary
// cookie-origin guard remains in force; this route grants no authority.
export async function POST(req: Request): Promise<Response> {
  return handleCspReport(req);
}
