import { NextResponse } from "next/server";
import { db } from "../../../../../db";
import { plans } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { requirePlatformOwner } from "../../../../../lib/platform-auth";
import { normalizePlanEntitlements } from "../../../../../lib/entitlements";
import { validateStripePriceBinding, StripePriceBindingError } from "../../../../../lib/stripe";
import { hasBodyOverLimit } from "../../../../../lib/request-limits";
import { writeAuditEvent } from "../../../../../lib/audit";

function validateId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) throw new Error("Invalid plan ID.");
  return id;
}

function parsePatch(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid JSON body.");
  const body = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) throw new Error("Plan name is required and must be at most 120 characters.");
    result.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.trim().length > 500) throw new Error("Plan description must be at most 500 characters.");
    result.description = body.description.trim();
  }
  if (body.entitlements !== undefined) {
    try { result.entitlements = normalizePlanEntitlements(body.entitlements); }
    catch (error) { throw new Error(error instanceof Error ? error.message : "Invalid plan entitlements."); }
  }
  if (body.stripePriceId !== undefined) {
    if (typeof body.stripePriceId !== "string" || !/^price_[A-Za-z0-9_]+$/.test(body.stripePriceId.trim())) throw new Error("A valid Stripe Price ID is required.");
    result.stripePriceId = body.stripePriceId.trim();
  }
  if (body.stripeProductId !== undefined) {
    if (body.stripeProductId !== null && (typeof body.stripeProductId !== "string" || !/^prod_[A-Za-z0-9_]+$/.test(body.stripeProductId.trim()))) throw new Error("Stripe Product ID must look like prod_...");
    result.stripeProductId = typeof body.stripeProductId === "string" ? body.stripeProductId.trim() : null;
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || !/^[a-z]{3}$/.test(body.currency.trim().toLowerCase())) throw new Error("Currency must be a 3-letter ISO code.");
    result.currency = body.currency.trim().toLowerCase();
  }
  if (body.interval !== undefined) {
    const interval = typeof body.interval === "string" ? body.interval.trim().toLowerCase() : "";
    if (!["day", "week", "month", "year"].includes(interval)) throw new Error("Interval must be day, week, month, or year.");
    result.interval = interval;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw new Error("isActive must be boolean.");
    result.isActive = body.isActive;
  }
  if (body.isPublic !== undefined) {
    if (typeof body.isPublic !== "boolean") throw new Error("isPublic must be boolean.");
    result.isPublic = body.isPublic;
  }
  if (body.displayOrder !== undefined) {
    const order = Number(body.displayOrder);
    if (!Number.isSafeInteger(order) || order < 0 || order > 1_000_000) throw new Error("Display order must be a non-negative integer.");
    result.displayOrder = order;
  }

  if (Object.keys(result).length === 0) throw new Error("No plan changes supplied.");
  return result;
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  if (hasBodyOverLimit(req, 32 * 1024)) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let claims;
  try { claims = await requirePlatformOwner(req); }
  catch { return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 }); }

  const { id: rawId } = await context.params;
  let id: string;
  let patch: Record<string, unknown>;
  try {
    id = validateId(rawId);
    patch = parsePatch(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid plan update." }, { status: 400 });
  }

  // Validate any billing identity change against Stripe before taking the
  // database row lock. This keeps external network I/O out of the transaction.
  let currentForValidation: Record<string, unknown> | undefined;
  try {
    const currentRows = await db.query.plans.findFirst({
      where: eq(plans.id, id),
      columns: {
        id: true,
        stripePriceId: true,
        stripeProductId: true,
        currency: true,
        interval: true,
        isActive: true,
      },
    });
    currentForValidation = currentRows as Record<string, unknown> | undefined;
    if (!currentForValidation) throw new Error("PLAN_NOT_FOUND");

    const touchesStripeBinding =
      patch.stripePriceId !== undefined ||
      patch.stripeProductId !== undefined ||
      patch.currency !== undefined ||
      patch.interval !== undefined ||
      patch.isActive !== undefined;

    if (touchesStripeBinding) {
      const effectivePriceId = typeof patch.stripePriceId === "string"
        ? patch.stripePriceId
        : typeof currentForValidation.stripePriceId === "string"
          ? currentForValidation.stripePriceId
          : "";
      if (!effectivePriceId) throw new Error("A Stripe Price is required for a billable plan.");

      const stripePrice = await validateStripePriceBinding({
        priceId: effectivePriceId,
        currency: typeof patch.currency === "string"
          ? patch.currency
          : typeof currentForValidation.currency === "string"
            ? currentForValidation.currency
            : "usd",
        interval: typeof patch.interval === "string"
          ? patch.interval
          : typeof currentForValidation.interval === "string"
            ? currentForValidation.interval
            : "month",
        productId: patch.stripeProductId !== undefined
          ? (typeof patch.stripeProductId === "string" ? patch.stripeProductId : null)
          : (typeof currentForValidation.stripeProductId === "string" ? currentForValidation.stripeProductId : null),
        requireActive: patch.isActive !== undefined
          ? patch.isActive === true
          : currentForValidation.isActive === true,
      });
      if (patch.stripeProductId === undefined && !currentForValidation.stripeProductId && stripePrice.productId) {
        patch.stripeProductId = stripePrice.productId;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PLAN_NOT_FOUND") {
      return NextResponse.json({ error: "Plan not found.", code: "PLAN_NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "PLAN_CHANGED_RETRY") {
      return NextResponse.json({ error: "The plan billing configuration changed while you were editing it. Reload and retry.", code: "PLAN_CHANGED_RETRY" }, { status: 409 });
    }
    if (error instanceof StripePriceBindingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Stripe Price could not be verified.", code: "STRIPE_PRICE_INVALID" }, { status: 400 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const currentRows = await tx.execute(sql`
        SELECT id, name, description, entitlements, stripe_price_id AS "stripePriceId",
               stripe_product_id AS "stripeProductId", currency, interval,
               is_active AS "isActive", is_public AS "isPublic", display_order AS "displayOrder"
        FROM plans
        WHERE id = ${id}
        FOR UPDATE
      `);
      const current = currentRows.rows[0] as Record<string, unknown> | undefined;
      if (!current) throw new Error("PLAN_NOT_FOUND");

      const touchesStripeBinding =
        patch.stripePriceId !== undefined ||
        patch.stripeProductId !== undefined ||
        patch.currency !== undefined ||
        patch.interval !== undefined ||
        patch.isActive !== undefined;
      if (touchesStripeBinding && currentForValidation) {
        const guardedFields = ["stripePriceId", "stripeProductId", "currency", "interval", "isActive"];
        for (const field of guardedFields) {
          if (String(current[field] ?? null) !== String(currentForValidation[field] ?? null)) {
            throw new Error("PLAN_CHANGED_RETRY");
          }
        }
      }

      // Existing subscriptions remain attached to this plan. Changing the
      // current Stripe price only changes the price used by future checkout.
      // Existing Stripe subscriptions keep their current Stripe price item.
      const updated = await tx.update(plans)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(plans.id, id))
        .returning({ id: plans.id, name: plans.name });

      await writeAuditEvent({
        tenantId: null,
        actorType: "platform",
        actorId: claims.userId,
        action: "plan.updated",
        resourceType: "plan",
        resourceId: id,
        metadata: { changes: patch },
      }, tx);

      return updated[0];
    });

    return NextResponse.json({ ok: true, plan: result });
  } catch (error) {
    if (error instanceof Error && error.message === "PLAN_NOT_FOUND") {
      return NextResponse.json({ error: "Plan not found.", code: "PLAN_NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "PLAN_CHANGED_RETRY") {
      return NextResponse.json({ error: "The plan billing configuration changed while you were editing it. Reload and retry.", code: "PLAN_CHANGED_RETRY" }, { status: 409 });
    }
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) {
      return NextResponse.json({ error: "A plan with this name or Stripe identifier already exists.", code: "PLAN_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update plan." }, { status: 500 });
  }
}
