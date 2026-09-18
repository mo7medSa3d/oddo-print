import { createHmac, timingSafeEqual } from "node:crypto";
import { runtimeSecret } from "./runtime-secret";
export function stripeSecret(): string { const s=runtimeSecret("STRIPE_SECRET_KEY"); if(!s) throw new Error("Stripe is not configured"); return s; }
export function stripeHeaders(extra:Record<string,string>={}) { return { Authorization:`Bearer ${stripeSecret()}`, "Content-Type":"application/x-www-form-urlencoded", ...(runtimeSecret("STRIPE_API_VERSION")?{"Stripe-Version":runtimeSecret("STRIPE_API_VERSION")!}:{}), ...extra }; }
export type StripeApiResponse = { id: string; url?: string | null };

function requireStripeObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Stripe returned an invalid response object");
  return data as Record<string, unknown>;
}

function parseStripeResponse(path: string, data: unknown): StripeApiResponse {
  const object = requireStripeObject(data);
  if (typeof object.id !== "string" || object.id.length === 0) throw new Error(`Stripe response missing id for ${path}`);
  if (path === "checkout/sessions" && object.url !== null && typeof object.url !== "string") {
    throw new Error("Stripe checkout session returned an invalid url");
  }
  return { id: object.id, ...(Object.prototype.hasOwnProperty.call(object, "url") ? { url: object.url as string | null } : {}) };
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
export function verifyStripeSignature(payload:string, header:string, secret:string, toleranceSec=300): boolean {
  const parts=header.split(",").map(p=>p.split("=",2)); const ts=Number(parts.find(([k])=>k==="t")?.[1]); if(!Number.isFinite(ts)||Math.abs(Date.now()/1000-ts)>toleranceSec)return false;
  const provided=parts.filter(([k])=>k==="v1").map(([,v])=>v).filter(Boolean); if(provided.length===0)return false;
  const expected=createHmac("sha256",secret).update(`${ts}.${payload}`).digest("hex"); const expectedBuf=Buffer.from(expected,"hex");
  return provided.some(sig=>{try{const b=Buffer.from(sig,"hex");return b.length===expectedBuf.length&&timingSafeEqual(b,expectedBuf);}catch{return false;}});
}
