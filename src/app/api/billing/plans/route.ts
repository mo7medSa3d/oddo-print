import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { plans } from "../../../../db/schema";
import { and, asc, eq, isNotNull } from "drizzle-orm";

export async function GET() {
  const rows = await db.select({
    id: plans.id, name: plans.name, entitlements: plans.entitlements, currency: plans.currency, interval: plans.interval,
  }).from(plans).where(and(isNotNull(plans.stripePriceId), eq(plans.isActive, true), eq(plans.isPublic, true))).orderBy(asc(plans.displayOrder), asc(plans.name));
  return NextResponse.json({ plans: rows });
}
