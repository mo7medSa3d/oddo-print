import { validateWorkspaceManager, type ManagerClaims } from "./manager-auth";
import { applicationOrigin } from "./application-origin";
import { hasBodyOverLimit } from "./request-limits";
import { ManagerMutationAuthorityChangedError } from "./manager-mutation-authorization";
import { AuthenticationChangedError } from "./session-tokens";
import { TenantDeletedError, TenantSuspendedError } from "./tenant-guard";
import { WorkspaceSessionExpiredError, workspacePolicyResponse } from "./workspace-session-security";
import { logError } from "./log";

export const WORKSPACE_SECURITY_HEADERS = { "Cache-Control": "private, no-store" };
export class WorkspaceSecurityRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function assertWorkspaceSecurityOrigin(req: Request) {
  if (req.headers.get("origin") !== applicationOrigin() || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new WorkspaceSecurityRequestError(403, "INVALID_ORIGIN", "This request must come from the application origin.");
  }
}
export async function requireWorkspaceSecurityClaims(req: Request): Promise<ManagerClaims> {
  // These endpoints distinguish an authoritative expiry from a clock-store
  // outage: the activity UI must not convert infrastructure failure to logout.
  const claims = await validateWorkspaceManager(req, { propagateClockFailure: true });
  if (!claims || claims.ver !== 2 || !claims.familyId || !claims.sid) throw new WorkspaceSessionExpiredError();
  return claims;
}

/** Bound streamed bodies before allocating the complete JSON string. */
export async function readWorkspaceSecurityJson(req: Request): Promise<unknown> {
  const limit = 32 * 1024;
  if (hasBodyOverLimit(req, limit)) throw new WorkspaceSecurityRequestError(413, "REQUEST_TOO_LARGE", "Request too large");
  const reader = req.body?.getReader();
  if (!reader) throw new WorkspaceSecurityRequestError(400, "INVALID_REQUEST", "Invalid JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new WorkspaceSecurityRequestError(413, "REQUEST_TOO_LARGE", "Request too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw new WorkspaceSecurityRequestError(400, "INVALID_REQUEST", "Invalid JSON"); }
}

export function workspaceSecurityErrorResponse(error: unknown): Response {
  if (error instanceof ManagerMutationAuthorityChangedError) return error.response();
  if (error instanceof WorkspaceSessionExpiredError) return workspacePolicyResponse(error);
  if (error instanceof AuthenticationChangedError || error instanceof TenantDeletedError || error instanceof TenantSuspendedError) return workspacePolicyResponse(new WorkspaceSessionExpiredError());
  if (error instanceof WorkspaceSecurityRequestError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: WORKSPACE_SECURITY_HEADERS });
  // Database and credential verifier failures must not disclose an account,
  // password, token or driver error.
  logError("auth.workspace_security.unavailable", { error: "Workspace security infrastructure unavailable" });
  return Response.json({ error: "Security verification temporarily unavailable", code: "SECURITY_UNAVAILABLE" }, { status: 503, headers: WORKSPACE_SECURITY_HEADERS });
}
