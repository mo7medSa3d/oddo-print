import { createHmac, timingSafeEqual } from "node:crypto";
import { runtimeSecret } from "./runtime-secret";
export function stripeSecret(): string { const s=runtimeSecret("STRIPE_SECRET_KEY"); if(!s) throw new Error("Stripe is not configured"); return s; }
export function stripeHeaders(extra:Record<string,string>={}) { return { Authorization:`Bearer ${stripeSecret()}`, "Content-Type":"application/x-www-form-urlencoded", ...(runtimeSecret("STRIPE_API_VERSION")?{"Stripe-Version":runtimeSecret("STRIPE_API_VERSION")!}:{}), ...extra }; }
export type StripeApiResponse = { id: string; url?: string | null; expires_at?: number };

function requireStripeObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Stripe returned an invalid response object");
  return data as Record<string, unknown>;
}

function parseStripeResponse(path: string, data: unknown): StripeApiResponse {
  const object = requireStripeObject(data);
  if (typeof object.id !== "string" || object.id.length === 0) throw new Error(`Stripe response missing id for ${path}`);
  if (path === "checkout/sessions") {
    if (object.url !== null && object.url !== undefined && typeof object.url !== "string") {
      throw new Error("Stripe checkout session returned an invalid url");
    }
    if (object.expires_at !== undefined && (!Number.isSafeInteger(object.expires_at) || Number(object.expires_at) <= 0)) {
      throw new Error("Stripe checkout session returned an invalid expires_at");
    }
  }
  return {
    id: object.id,
    ...(Object.prototype.hasOwnProperty.call(object, "url") ? { url: object.url as string | null } : {}),
    ...(Object.prototype.hasOwnProperty.call(object, "expires_at") ? { expires_at: Number(object.expires_at) } : {}),
  };
}

export async function stripeRequest(path:string, form:URLSearchParams, idempotencyKey?:string): Promise<StripeApiResponse> {
  const headers=stripeHeaders(idempotencyKey?{"Idempotency-Key":idempotencyKey}:{});
  const res=await fetch(`https://api.stripe.com/v1/${path}`,{method:"POST",headers,body:form,signal:AbortSignal.timeout(15_000)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(typeof (data as Record<string, unknown>)?.error === "object" && typeof ((data as Record<string, unknown>).error as Record<string, unknown>)?.message === "string"
    ? String(((data as Record<string, unknown>).error as Record<string, unknown>).message)
    : `Stripe request failed (${res.status})`);
  return parseStripeResponse(path, data);
}
/**
 * Fetch the current Stripe object outside the database transaction.
 *
 * Webhook snapshot events are immutable and Stripe does not guarantee event
 * delivery order. For subscription state we therefore retrieve the current
 * resource instead of trying to reconstruct chronology from event.created.
 */
export async function stripeRetrieve(path:string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "GET",
    headers: stripeHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (data as Record<string, unknown>)?.error;
    const message =
      typeof error === "object" &&
      error !== null &&
      typeof (error as Record<string, unknown>).message === "string"
        ? String((error as Record<string, unknown>).message)
        : `Stripe request failed (${res.status})`;
    throw new Error(message);
  }
  const object = requireStripeObject(data);
  if (typeof object.id !== "string" || object.id.length === 0) {
    throw new Error(`Stripe response missing id for ${path}`);
  }
  return object;
}

export type StripePriceBinding = {
  id: string;
  active: boolean;
  type: string | null;
  currency: string | null;
  interval: string | null;
  productId: string | null;
};

export class StripePriceBindingError extends Error {
  constructor(
    message: string,
    public readonly code: "STRIPE_PRICE_INVALID" | "STRIPE_NOT_CONFIGURED" | "STRIPE_UNAVAILABLE",
    public readonly status: 400 | 502 | 503,
  ) {
    super(message);
  }
}

export async function validateStripePriceBinding(input: {
  priceId: string;
  currency: string;
  interval: string;
  productId?: string | null;
  requireActive?: boolean;
}): Promise<StripePriceBinding> {
  let price: Record<string, unknown>;
  try {
    price = await stripeRetrieve(`prices/${encodeURIComponent(input.priceId)}`);
  } catch (error) {
    if (error instanceof Error && error.message === "Stripe is not configured") {
      throw new StripePriceBindingError("Stripe billing is not configured on this Gateway.", "STRIPE_NOT_CONFIGURED", 503);
    }
    throw new StripePriceBindingError("Stripe Price could not be verified right now.", "STRIPE_UNAVAILABLE", 502);
  }
  const recurring =
    price.recurring && typeof price.recurring === "object" && !Array.isArray(price.recurring)
      ? price.recurring as Record<string, unknown>
      : null;
  const productId = typeof price.product === "string" ? price.product : null;
  const binding: StripePriceBinding = {
    id: String(price.id),
    active: price.active === true,
    type: typeof price.type === "string" ? price.type : null,
    currency: typeof price.currency === "string" ? price.currency.toLowerCase() : null,
    interval: recurring && typeof recurring.interval === "string" ? recurring.interval : null,
    productId,
  };

  if (binding.id !== input.priceId) throw new StripePriceBindingError("Stripe Price ID did not match the requested price.", "STRIPE_PRICE_INVALID", 400);
  if (binding.type !== "recurring") throw new StripePriceBindingError("Stripe Price must be a recurring subscription price.", "STRIPE_PRICE_INVALID", 400);
  if (input.requireActive !== false && !binding.active) throw new StripePriceBindingError("Stripe Price is inactive.", "STRIPE_PRICE_INVALID", 400);
  if (binding.currency !== input.currency.toLowerCase()) throw new StripePriceBindingError("Plan currency does not match the Stripe Price.", "STRIPE_PRICE_INVALID", 400);
  if (binding.interval !== input.interval) throw new StripePriceBindingError("Plan billing interval does not match the Stripe Price.", "STRIPE_PRICE_INVALID", 400);
  if (input.productId && binding.productId !== input.productId) throw new StripePriceBindingError("Stripe Product ID does not match the Stripe Price.", "STRIPE_PRICE_INVALID", 400);

  return binding;
}

export function verifyStripeSignature(payload:string, header:string, secret:string, toleranceSec=300): boolean {
  const parts=header.split(",").map(p=>p.split("=",2)); const ts=Number(parts.find(([k])=>k==="t")?.[1]); if(!Number.isFinite(ts)||Math.abs(Date.now()/1000-ts)>toleranceSec)return false;
  const provided=parts.filter(([k])=>k==="v1").map(([,v])=>v).filter(Boolean); if(provided.length===0)return false;
  const expected=createHmac("sha256",secret).update(`${ts}.${payload}`).digest("hex"); const expectedBuf=Buffer.from(expected,"hex");
  return provided.some(sig=>{try{const b=Buffer.from(sig,"hex");return b.length===expectedBuf.length&&timingSafeEqual(b,expectedBuf);}catch{return false;}});
}
