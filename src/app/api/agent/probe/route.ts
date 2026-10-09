export const dynamic = "force-dynamic";

/**
 * Public, side-effect-free identity/liveness probe for the desktop Manager.
 *
 * This deliberately does not query PostgreSQL or require a Manager session:
 * Settings uses it to validate that a candidate URL points at a Yaseir
 * Gateway before saving the origin. Deeper database/service readiness remains
 * the responsibility of /api/health and the authenticated System page.
 */
export function GET() {
  return Response.json(
    {
      ok: true,
      service: "yaseir-print-gateway",
      // An additive contract: old Gateways omit this feature so a new Desktop
      // can tell the operator to upgrade instead of requesting Manager sign-in.
      features: { agentVirtualSpoolerTest: true, pairedAgentDiagnosticCapture: true },
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
