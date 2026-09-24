import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { queryWithTimeout } from "../../../../db/client";
import { plans, tenantSubscriptions } from "../../../../db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { requirePlatformOwner, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { normalizePlanEntitlements } from "../../../../lib/entitlements";
import { validateStripePriceBinding, StripePriceBindingError } from "../../../../lib/stripe";
import { hasBodyOverLimit } from "../../../../lib/request-limits";
import { writeAuditEvent } from "../../../../lib/audit";

function parsePlanPayload(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid JSON body");
  const body = input as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const stripePriceId = typeof body.stripePriceId === "string" ? body.stripePriceId.trim() : "";
  const stripeProductId = typeof body.stripeProductId === "string" ? body.stripeProductId.trim() : "";
  const currency = typeof body.currency === "string" ? body.currency.trim().toLowerCase() : "usd";
  const interval = typeof body.interval === "string" ? body.interval.trim().toLowerCase() : "month";
  const displayOrder = body.displayOrder === undefined ? 0 : Number(body.displayOrder);
  const isActive = body.isActive === undefined ? true : body.isActive === true;
  const isPublic = body.isPublic === undefined ? true : body.isPublic === true;

  if (!id || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) throw new Error("Plan ID must be 2-64 characters using lowercase letters, numbers, _ or -.");
  if (!name || name.length > 120) throw new Error("Plan name is required and must be at most 120 characters.");
  if (description.length > 500) throw new Error("Plan description must be at most 500 characters.");
  if (!/^price_[A-Za-z0-9_]+$/.test(stripePriceId)) throw new Error("A valid Stripe Price ID is required.");
  if (stripeProductId && !/^prod_[A-Za-z0-9_]+$/.test(stripeProductId)) throw new Error("Stripe Product ID must look like prod_...");
  if (!/^[a-z]{3}$/.test(currency)) throw new Error("Currency must be a 3-letter ISO code.");
  if (!["day", "week", "month", "year"].includes(interval)) throw new Error("Interval must be day, week, month, or year.");
  if (!Number.isSafeInteger(displayOrder) || displayOrder < 0 || displayOrder > 1_000_000) throw new Error("Display order must be a non-negative integer.");

  let entitlements;
  try {
    entitlements = normalizePlanEntitlements(body.entitlements);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid plan entitlements.");
  }

  return { id, name, description, stripePriceId, stripeProductId: stripeProductId || null, currency, interval, isActive, isPublic, displayOrder, entitlements };
}

export async function GET(req: Request) {
  try {
    await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const limitParam = parseInt(searchParams.get("limit") ?? "200", 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 200 : limitParam), 1000);

  const rows = await queryWithTimeout(
    db
      .select({
        id: plans.id,
        name: plans.name,
        description: plans.description,
        entitlements: plans.entitlements,
        stripePriceId: plans.stripePriceId,
        stripeProductId: plans.stripeProductId,
        currency: plans.currency,
        interval: plans.interval,
        isActive: plans.isActive,
        isPublic: plans.isPublic,
        displayOrder: plans.displayOrder,
        createdAt: plans.createdAt,
        updatedAt: plans.updatedAt,
        subscriberCount: sql<number>`(SELECT count(*)::int FROM ${tenantSubscriptions} WHERE ${tenantSubscriptions.planId} = ${plans.id})`,
        activeSubscriberCount: sql<number>`(SELECT count(*)::int FROM ${tenantSubscriptions} WHERE ${tenantSubscriptions.planId} = ${plans.id} AND ${tenantSubscriptions.status} IN ('trialing','active','past_due'))`,
      })
      .from(plans)
      .orderBy(asc(plans.displayOrder), asc(plans.name))
      .limit(limit),
    5_000,
    "platformPlansList",
  );

  return NextResponse.json({ plans: rows });
}

export async function POST(req: Request) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let claims;
  try {
    claims = await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503 });
  }

  let parsed;
  try {
    parsed = parsePlanPayload(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid plan payload." }, { status: 400 });
  }

  try {
    const stripePrice = await validateStripePriceBinding({
      priceId: parsed.stripePriceId,
      currency: parsed.currency,
      interval: parsed.interval,
      productId: parsed.stripeProductId,
      requireActive: parsed.isActive,
    });
    // The Stripe Price is the source of truth for the linked Product. Keep
    // the optional catalog field synchronized without accepting mismatches.
    if (!parsed.stripeProductId && stripePrice.productId) parsed.stripeProductId = stripePrice.productId;
  } catch (error) {
    if (error instanceof StripePriceBindingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Stripe Price could not be verified.", code: "STRIPE_PRICE_INVALID" }, { status: 400 });
  }

  try {
    await db.transaction(async (tx) => {
      const existing = await tx.query.plans.findFirst({ where: eq(plans.id, parsed.id), columns: { id: true } });
      if (existing) throw new Error("PLAN_EXISTS");

      const inserted = await tx.insert(plans).values({
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        entitlements: parsed.entitlements,
        stripePriceId: parsed.stripePriceId,
        stripeProductId: parsed.stripeProductId,
        currency: parsed.currency,
        interval: parsed.interval,
        isActive: parsed.isActive,
        isPublic: parsed.isPublic,
        displayOrder: parsed.displayOrder,
      }).returning({ id: plans.id });

      await writeAuditEvent({
        tenantId: null,
        actorType: "platform",
        actorId: claims.userId,
        action: "plan.created",
        resourceType: "plan",
        resourceId: inserted[0].id,
        metadata: { name: parsed.name, isActive: parsed.isActive, isPublic: parsed.isPublic, entitlements: parsed.entitlements },
      }, tx);
    });

    return NextResponse.json({ ok: true, planId: parsed.id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "PLAN_EXISTS") {
      return NextResponse.json({ error: "A plan with this ID already exists.", code: "PLAN_EXISTS" }, { status: 409 });
    }
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) {
      return NextResponse.json({ error: "A plan with this name or Stripe identifier already exists.", code: "PLAN_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create plan." }, { status: 500 });
  }
}
