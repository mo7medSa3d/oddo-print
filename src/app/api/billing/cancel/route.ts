import { NextResponse } from "next/server";
/** V4: provider callbacks and customer billing mutations cannot grant access.
 * Historical provider records remain available for audit only. */
export async function POST(_req: Request) {
  return NextResponse.json({error:"Manual subscription management required",code:"MANUAL_BILLING_REQUIRED"},{status:410});
}
