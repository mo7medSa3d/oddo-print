import { NextResponse } from "next/server";
import { validateWorkspaceManager } from "../../../../lib/manager-auth";

/** The workspace session does not authorize changes to workspace ownership. */
export async function POST(req: Request) {
  const claims = await validateWorkspaceManager(req);
  if (!claims?.userId) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  return NextResponse.json({ error: "Platform Owner required", code: "PLATFORM_OWNER_REQUIRED" }, { status: 403 });
}
