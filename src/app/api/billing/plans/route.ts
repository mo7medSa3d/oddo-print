import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans } from "../../../../db/schema";
import { isNotNull } from "drizzle-orm";

export async function GET() {
  const rows = await db.select({
    id: plans.id, name: plans.name, entitlements: plans.entitlements, currency: plans.currency, interval: plans.interval,
  }).from(plans).where(isNotNull(plans.stripePriceId));
  return NextResponse.json({ plans: rows });
}
