import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store" };
const RETIRED_BODY = { error: "Legacy cloud print reconciliation retired" };

export async function GET() {
  return NextResponse.json(RETIRED_BODY, { status: 410, headers: HEADERS });
}

export async function POST() {
  return NextResponse.json(RETIRED_BODY, { status: 410, headers: HEADERS });
}
