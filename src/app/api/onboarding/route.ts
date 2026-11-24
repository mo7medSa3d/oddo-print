import { NextResponse } from "next/server";
/** Workspace users cannot perform this action; Platform Owner has a distinct session audience. */
export async function GET(_req: Request) { return NextResponse.json({ error: "Platform Owner required", code: "PLATFORM_OWNER_REQUIRED" }, { status: 403 }); }
export async function POST(_req: Request) { return NextResponse.json({ error: "Platform Owner required", code: "PLATFORM_OWNER_REQUIRED" }, { status: 403 }); }
