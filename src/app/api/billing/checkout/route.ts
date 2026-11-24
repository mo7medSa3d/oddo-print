import { NextResponse } from "next/server";
import { computePlanTermPricing, type BillingTerm } from "../../../../lib/plan-price";

/**
 * V4: provider callbacks and customer billing mutations cannot grant access.
 * Historical provider records remain available for audit only.
 * If a caller passes term/price preview parameters, compute the consistent
 * monthly/yearly quote via `plan-price.ts` while preserving the 410 manual-billing gate.
 */
export async function POST(req: Request) {
  let pricing: ReturnType<typeof computePlanTermPricing> = null;
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (body && (body.term === "monthly" || body.term === "yearly")) {
      const term: BillingTerm = body.term;
      const minorUnits = typeof body.monthlyMinorUnits === "number" ? body.monthlyMinorUnits : null;
      const currency = typeof body.priceCurrency === "string" ? body.priceCurrency : null;
      pricing = computePlanTermPricing(minorUnits, currency, term);
    }
  } catch {
    pricing = null;
  }
  return NextResponse.json(
    {
      error: "Manual subscription management required",
      code: "MANUAL_BILLING_REQUIRED",
      ...(pricing ? { pricing } : {}),
    },
    { status: 410 },
  );
}
