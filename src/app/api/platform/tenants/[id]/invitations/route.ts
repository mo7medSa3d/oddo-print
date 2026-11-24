import { NextResponse } from "next/server";

/** Invitations belong to the authenticated workspace Team route, not Platform Admin. */
function moved(): NextResponse {
  return NextResponse.json(
    { error: "Use the workspace Team page for invitations", code: "INVITATIONS_MOVED" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() { return moved(); }
export async function POST() { return moved(); }
export async function DELETE() { return moved(); }
