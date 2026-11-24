import { NextResponse } from "next/server";
import { db, queryWithTimeout } from "../../../../db/client";
import { plans } from "../../../../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { PUBLIC_VARY_CACHE_CONTROL } from "../../../../lib/cache";
import { logError } from "../../../../lib/log";

export async function GET() {
  try {
    const rows = await queryWithTimeout(
      () => db.select({
        id: plans.id, name: plans.name, description: plans.description, priceMinorUnits: plans.priceMinorUnits, priceCurrency: plans.priceCurrency, entitlements: plans.entitlements
      }).from(plans).where(and(eq(plans.isActive, true), eq(plans.isPublic, true))).orderBy(asc(plans.displayOrder), asc(plans.name)),
      5_000,
      "billingPlansCatalog",
    );
    return NextResponse.json(
      { plans: rows },
      { headers: { "Cache-Control": PUBLIC_VARY_CACHE_CONTROL } },
    );
  } catch (error) {
    logError("billing.plans_read_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json(
      { error: "Plans catalog temporarily unavailable", code: "PLANS_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
