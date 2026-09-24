import { NextResponse } from "next/server";
import { db, queryWithTimeout } from "../../../../db/client";
import { plans } from "../../../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { PUBLIC_VARY_CACHE_CONTROL } from "../../../../lib/cache";

export async function GET() {
  const rows = await queryWithTimeout(
    db.select({
      id: plans.id, name: plans.name, entitlements: plans.entitlements, currency: plans.currency, interval: plans.interval,
    }).from(plans).where(and(isNotNull(plans.stripePriceId), eq(plans.isActive, true), eq(plans.isPublic, true))).orderBy(asc(plans.displayOrder), asc(plans.name)),
    5_000,
    "billingPlansCatalog",
  );
  return NextResponse.json(
    { plans: rows },
    { headers: { "Cache-Control": PUBLIC_VARY_CACHE_CONTROL } },
  );
}
